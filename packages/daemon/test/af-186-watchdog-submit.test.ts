import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { formatWatchdogDeliveryMessage } from "../src/domain/watchdog-policy-engine.js";

// AF-186 (https://github.com/Newity-LLC/agent-factory/issues/186): OpenRig's watchdog (policy parked-owner-consumer)
// pastes its wake into a seat's input box and sometimes leaves it there without Enter; Josh had to press Enter in
// mgmt-pm's pane on 2026-10-27. The watchdog is the only sender that knows the paste is its own, so it must submit its
// own paste (Enter, then confirm the box emptied, retrying Enter a bounded number of times), and never paste onto or
// submit a human's draft. Driven through the daemon's own watchdog delivery (makeWatchdogDeliver -> SessionTransport ->
// TmuxAdapter) on a real tmux server (private socket) running a Claude-like composer (fixtures/af-186-composer.mjs).
// Most factory seats run with the typing guard off; the orchestrator and PM run draft-aware: both are covered.
// Cases:
//   1. Guard off, empty box, Enter accepted: the wake is submitted once (today's behaviour, kept).
//   2. Guard off, empty box, the first Enter is lost: the wake is still submitted, once, with no human input.
//   2b. Guard off, the paste shows raw and collapses 100 ms later, the first Enter is lost: submitted once.
//   3. Draft-aware, empty box, the first Enter is lost: the same.
//   3b. Draft-aware, raw then collapsed 100 ms later (inside AF-148's 300 ms window), Enter fine: submitted once.
//   3c. Draft-aware, raw then collapsed 100 ms later, the first Enter is lost: submitted once (the retry's own pre-Enter
//       ownership check must accept the adopted label; pre-build r1 BLOCKING: the PM and orchestrator are draft-aware).
//   3d. Draft-aware, the paste drawn 40 ms late then collapsed at once, the first Enter is lost: submitted once.
//   4. Two Enters lost: still submitted once (the retry is more than one).
//   5. Guard off, a human's draft in the box: nothing is pasted, nothing is submitted, the draft is untouched, and the
//      wake is held (status "retained", so the held-wake path hands it over), not failed and not delivered.
//   6. Draft-aware, a human's draft in the box: the same (today's behaviour, kept).
//   7a. Guard off, a human types 60 ms after the paste (before the first Enter), which is lost: nothing submitted.
//   7b. Guard off, the first Enter is lost and a human types 100 ms after it, before any retry: no further Enter,
//       nothing submitted, the box keeps our text plus the human's (pre-build r1 MEDIUM).
//   8. Every Enter is lost: the delivery gives up within 6 s, with a bounded number of Enters (2 to 4), and reports
//      it failed (not delivered, not held).
//   9. Guard off, a box OpenRig can't read (as on a runtime whose composer it doesn't know): delivered as today,
//      pasted and submitted once (the lead's call: such a seat keeps today's delivery, never a held wake nobody hands
//      over).
//   9b. Draft-aware, a box OpenRig can't read: nothing pasted, nothing submitted, held (today's behaviour, kept).
// Pre-PR review (AF-186 vet):
//   10. Guard off, a human's draft, the box unreadable for its first reads only (a redraw): nothing pasted, held. Only a
//       box that stays unreadable keeps today's paste-and-Enter (MEDIUM).
//   11. Another sender (a plain transport send, not the watchdog) to a guard-off seat whose first Enter is lost: one
//       Enter, no retry, as today (MEDIUM: other senders unchanged).
//   11b. The same on a draft-aware seat: one Enter, no retry (the retry is the watchdog's own).
//   12. Another sender to a guard-off seat with a draft: still pasted onto it, as today (MEDIUM: other senders unchanged).
//   13. A watchdog digest (several occurrences in one send) with the first Enter lost: submitted once (LOW).
//   14. The wake submitted, then a human types 200 ms later, before the first confirm read: reported delivered (LOW).
// Not covered, accepted in the plan: a label that first shows more than 300 ms after the paste. AF-148 refuses it
// because a human's paste looks the same, and AF-186 keeps that rule.
const run = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const composer = fileURLToPath(new URL("./fixtures/af-186-composer.mjs", import.meta.url));
const wake = "You are parked (arbitrated: idle at prompt) while holding 1 open obligation: qitem-af186. Resume the work or update each row honestly.";
const source = (occ: string) => ({ jobId: `job-${occ}`, policy: "parked-owner-consumer", occurrenceId: occ });
const draft = "half-typed reply to the orchestrator";

type State = { input: string; submissions: string[]; enters: number };

async function seat(config: object, mode: "off" | "draft-aware", fn: (h: {
  deliver: (occ: string) => Promise<{ status: string; error?: string }>;
  digest: (occs: string[]) => Promise<{ status: string; error?: string }>;
  plain: (text: string) => Promise<{ ok: boolean }>;
  payload: (occ: string) => string;
  state: () => State;
}) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "af186-"));
  const socket = join(scratch, "s");
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
  const state = () => JSON.parse(readFileSync(join(scratch, "a.json"), "utf8")) as State;
  const db = new Database(":memory:");
  let transport: SessionTransport | undefined;
  try {
    const command = [process.execPath, composer, join(scratch, "a.json"), JSON.stringify(config)].map(shellQuote).join(" ");
    const pane = (await tmux(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "120", "-y", "40", "-s", "worker@test", command])).trim();
    await vi.waitFor(() => expect(typeof state().input).toBe("string"), { timeout: 5000, interval: 25 });
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
    db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)").run("binding-a", "a", "worker@test", pane);
    const adapter = new TmuxAdapter(async () => { throw new Error("Native fixture requires argv execution"); }, undefined, async args => tmux(args.slice(1)));
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); adapter.deliveryGuard = guard;
    transport = new SessionTransport({ db, tmuxAdapter: adapter, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
      now: () => new Date(), sleep: pause });
    if (mode === "draft-aware") await guard.set("a", { mode: "draft-aware" }, "human@test", "AF-186 fixture");
    await pause(300);   // the composer has drawn its first frame
    const deliver = makeWatchdogDeliver({ sessionTransport: transport, outbox: new OutboxHandler(db), db });
    await fn({
      deliver: occ => deliver({ targetSession: "worker@test", message: wake }, source(occ)) as Promise<{ status: string; error?: string }>,
      digest: occs => deliver({ targetSession: "worker@test", message: wake }, { jobId: `digest-${occs.join("+")}`, policy: "parked-owner-consumer",
        occurrenceId: `digest-${occs.join("+")}`, members: occs.map(o => ({ jobId: `job-${o}`, occurrenceId: o })) } as never) as Promise<{ status: string; error?: string }>,
      plain: text => transport!.send("worker@test", text, { deliveryId: `plain-${Date.now()}`, actorSession: "sender@test" }) as Promise<{ ok: boolean }>,
      payload: occ => formatWatchdogDeliveryMessage(source(occ) as never, wake),
      state,
    });
  } finally {
    await transport?.guardedDelivery?.stop();
    await tmux(["kill-server"]).catch(() => {});
    db.close(); rmSync(scratch, { recursive: true, force: true });
  }
}

async function submittedOnce(config: object, mode: "off" | "draft-aware", occ: string) {
  await seat(config, mode, async ({ deliver, payload, state }) => {
    const started = Date.now();
    const outcome = await deliver(occ);
    expect(outcome.status).toBe("ok");
    expect(Date.now() - started).toBeLessThan(6000);
    await vi.waitFor(() => expect(state().submissions).toEqual([payload(occ)]), { timeout: 3000 });
    expect(state().input).toBe("");
    await pause(1500);   // longer than any retry window: no late extra Enter submits anything else
    expect(state().submissions).toEqual([payload(occ)]);
  });
}

describe.skipIf(process.platform === "win32")("AF-186: the watchdog submits its own wake and never a human's draft", () => {
  it("1. guard off, empty box, Enter accepted: submitted once", () => submittedOnce({}, "off", "plain-off"), 30_000);

  it("2. guard off, empty box, the first Enter is lost: still submitted once", () => submittedOnce({ swallowEnters: 1 }, "off", "lost-off"), 30_000);

  it("2b. guard off, raw then collapsed at 100 ms, the first Enter is lost: submitted once", () => submittedOnce({ collapseMs: 100, swallowEnters: 1 }, "off", "late-off"), 30_000);

  it("3. draft-aware, empty box, the first Enter is lost: still submitted once", () => submittedOnce({ swallowEnters: 1 }, "draft-aware", "lost-aware"), 30_000);

  it("3b. draft-aware, raw then collapsed at 100 ms, Enter fine: submitted once", () => submittedOnce({ collapseMs: 100 }, "draft-aware", "late-aware"), 30_000);

  it("3c. draft-aware, raw then collapsed at 100 ms, the first Enter is lost: submitted once", () => submittedOnce({ collapseMs: 100, swallowEnters: 1 }, "draft-aware", "late-lost-aware"), 30_000);

  it("3d. draft-aware, drawn 40 ms late then collapsed, the first Enter is lost: submitted once", () => submittedOnce({ renderDelayMs: 40, swallowEnters: 1 }, "draft-aware", "late-draw-aware"), 30_000);

  it("4. two Enters lost: still submitted once", () => submittedOnce({ swallowEnters: 2 }, "off", "lost-twice"), 30_000);

  for (const mode of ["off", "draft-aware"] as const) {
    it(`${mode === "off" ? 5 : 6}. ${mode}, a human's draft in the box: nothing pasted or submitted, draft untouched`, async () => {
      await seat({ draft }, mode, async ({ deliver, state }) => {
        const outcome = await deliver(`draft-${mode}`);
        expect(outcome.status).toBe("retained");
        await pause(1500);
        expect(state()).toMatchObject({ input: draft, submissions: [] });
        expect(state().enters).toBe(0);
      });
    }, 30_000);
  }

  it("7a. guard off, a human types before the first Enter, which is lost: nothing submitted", async () => {
    await seat({ swallowEnters: 1, typeAfterPasteMs: 60, typeText: " and mine" }, "off", async ({ deliver, payload, state }) => {
      await deliver("typed-over");
      await pause(1500);
      expect(state().submissions).toEqual([]);
      expect(state().input).toBe(`${payload("typed-over")} and mine`);
    });
  }, 30_000);

  it("7b. guard off, the first Enter is lost and a human types 100 ms later, before any retry: no further Enter", async () => {
    await seat({ swallowEnters: 1, typeAfterEnterMs: 100, typeText: " and mine" }, "off", async ({ deliver, payload, state }) => {
      await deliver("typed-after-enter");
      await pause(1500);
      expect(state().submissions).toEqual([]);
      expect(state().input).toBe(`${payload("typed-after-enter")} and mine`);
    });
  }, 30_000);

  it("8. every Enter is lost: gives up within 6 s, at most 4 Enters, not reported delivered", async () => {
    await seat({ swallowEnters: 100 }, "off", async ({ deliver, state }) => {
      const started = Date.now();
      const outcome = await deliver("never-takes");
      expect(Date.now() - started).toBeLessThan(6000);
      expect(outcome.status).toBe("failed");
      await pause(1500);
      expect(state().submissions).toEqual([]);
      expect(state().enters).toBeGreaterThanOrEqual(2);
      expect(state().enters).toBeLessThanOrEqual(4);
    });
  }, 30_000);

  it("9. guard off, a box OpenRig can't read: delivered as today, submitted once", async () => {
    await seat({ unreadable: true }, "off", async ({ deliver, payload, state }) => {
      const outcome = await deliver("unreadable");
      expect(outcome.status).toBe("ok");
      await vi.waitFor(() => expect(state().submissions).toEqual([payload("unreadable")]), { timeout: 3000 });
      expect(state().enters).toBe(1);
    });
  }, 30_000);

  it("9b. draft-aware, a box OpenRig can't read: nothing pasted or submitted, held", async () => {
    await seat({ unreadable: true }, "draft-aware", async ({ deliver, state }) => {
      const outcome = await deliver("unreadable-aware");
      expect(outcome.status).toBe("retained");
      await pause(1500);
      expect(state()).toMatchObject({ input: "", submissions: [], enters: 0 });
    });
  }, 30_000);

  it("10. guard off, a human's draft, the box unreadable for its first reads only: nothing pasted, held", async () => {
    await seat({ draft, unreadableMs: 450 }, "off", async ({ deliver, state }) => {
      const outcome = await deliver("redraw-draft");
      expect(outcome.status).toBe("retained");
      await pause(1500);
      expect(state()).toMatchObject({ input: draft, submissions: [], enters: 0 });
    });
  }, 30_000);

  const other = "a message from another seat\nline two";
  it("11. another sender, guard off, the first Enter lost: one Enter, no retry (unchanged)", async () => {
    await seat({ swallowEnters: 1 }, "off", async ({ plain, state }) => {
      expect((await plain(other)).ok).toBe(true);   // reported as today: Enter was sent
      await pause(1500);
      expect(state().enters).toBe(1);
      expect(state().submissions).toEqual([]);
    });
  }, 30_000);

  it("11b. another sender, draft-aware, the first Enter lost: one Enter, no retry (unchanged)", async () => {
    await seat({ swallowEnters: 1 }, "draft-aware", async ({ plain, state }) => {
      expect((await plain(other)).ok).toBe(true);   // reported as today: Enter was sent
      await pause(1500);
      expect(state().enters).toBe(1);
      expect(state().submissions).toEqual([]);
    });
  }, 30_000);

  it("12. another sender, guard off, a human's draft: still pasted onto it (unchanged)", async () => {
    await seat({ draft }, "off", async ({ plain, state }) => {
      await plain(other);
      await pause(1500);
      expect(state().submissions).toEqual([`${draft}${other}`]);
    });
  }, 30_000);

  it("13. a watchdog digest with the first Enter lost: submitted once", async () => {
    await seat({ swallowEnters: 1 }, "off", async ({ digest, state }) => {
      const outcome = await digest(["dig-a", "dig-b"]);
      expect(outcome.status).toBe("ok");
      await vi.waitFor(() => expect(state().submissions).toHaveLength(1), { timeout: 3000 });
      expect(state().submissions[0]).toContain(wake);
      expect(state().input).toBe("");
    });
  }, 30_000);

  it("14. the wake submitted, then a human types 200 ms later: reported delivered", async () => {
    await seat({ typeAfterEnterMs: 200, typeText: "next thought" }, "off", async ({ deliver, payload, state }) => {
      const outcome = await deliver("typed-after-submit");
      expect(outcome.status).toBe("ok");
      expect(state().submissions).toEqual([payload("typed-after-submit")]);
      expect(state().input).toBe("next thought");
    });
  }, 30_000);
});
