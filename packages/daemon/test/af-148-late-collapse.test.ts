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
import { inspectComposerInput } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";

// AF-148 (https://github.com/Newity-LLC/agent-factory/issues/148): with draft-aware delivery on, a multi-line message
// that the seat collapses into "[Pasted text #N +M lines]" a moment after the paste must still be submitted, never left
// typed without Enter, and a paste that isn't the delivery's own must still never be submitted.
// On 2026-10-22 13:27:30Z (OpenRig 72794c80) a 7-line message to the PM was left typed as "[Pasted text #1 +6 lines]":
// the guard learns a label only from its first readable post-paste read, and can't prove a label it sees later
// (repro: /opt/agent-factory-notes/AF-148/repro.md).
// The fixture (fixtures/af-148-collapse-composer.mjs) is Claude-like: the footer's "· ← for agents" shows only while the
// box is empty, and a multi-line paste collapses late, either
//   (A) our text shows first and the label replaces it 100 ms later, or
//   (B) no readable composer for 800 ms (longer than today's 500 ms paste-time window), then the label.
// Cases:
//   1. (A) submits once, with the full text; the box ends empty; the row is delivered.
//   2. (B) the same.
//   1b, 1c. (C) the seat draws the paste 40 ms after it lands, so the first read after the paste still shows the empty
//      pre-paste box; then a label at once (1b), or our text and then the label (1c): each submitted once (review r1).
//   3. A human-like clear-and-paste of other text with the same line count, 40 ms after ours (shown raw, then
//      collapsed): Enter is refused, nothing is submitted, the other text is untouched, and the refusal record shows
//      what the paste-time reads saw (shape only: no box text, no label text).
//   3b. Our text sits raw (it never collapses) and 400 ms later another same-line-count block replaces it and
//      collapses at once, so no read sees it raw. The other block is never submitted and stays in the box: either ours
//      was submitted first, or Enter is refused. A label that first shows after our own text has sat on screen longer
//      than a moment is not ours.
//   3c. Our text shows, a human clears it (the box is empty, as before the paste, for 100 ms) and pastes another
//      same-line-count block that collapses at once, all within 300 ms: refused, nothing submitted, untouched. An empty
//      box after our own text isn't "not drawn yet" (review r1).
//   4. A multi-line message that never collapses, a label shown at once, and a one-line message all still submit,
//      each within 4 s.
//   4d. A box that never becomes readable after the paste: the send gives up within 4 s, sends no Enter, and says so
//      (no endless watch).
const run = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const composer = fileURLToPath(new URL("./fixtures/af-148-collapse-composer.mjs", import.meta.url));
const ours = "From: orch-orchestrator@josh-production\nTo: mgmt-pm@josh-production\nSent: 10-22 13:27Z\n---\nAF-148 fixture message\n---\nReply: rig send";
const foreign = "a human's pasted block\nline two\nline three\nline four\nline five\nline six\nline seven";

async function seat(config: object, fn: (h: {
  send: (id: string, text: string) => Promise<Awaited<ReturnType<SessionTransport["send"]>>>;
  state: () => { input: string; submissions: string[] };
  row: (id: string) => { state?: string; stored?: string; result?: any };
}) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "af148-"));
  const socket = join(scratch, "s");
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
  const state = () => JSON.parse(readFileSync(join(scratch, "a.json"), "utf8")) as { input: string; submissions: string[] };
  const db = new Database(":memory:");
  let transport: SessionTransport | undefined;
  try {
    const command = [process.execPath, composer, join(scratch, "a.json"), JSON.stringify(config)].map(shellQuote).join(" ");
    const pane = (await tmux(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "120", "-y", "40", "-s", "worker@test", command])).trim();
    await vi.waitFor(() => expect(state().input).toBe(""), { timeout: 5000, interval: 25 });
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
    db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)").run("binding-a", "a", "worker@test", pane);
    const adapter = new TmuxAdapter(async () => { throw new Error("Native fixture requires argv execution"); }, undefined, async args => tmux(args.slice(1)));
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); adapter.deliveryGuard = guard;
    transport = new SessionTransport({ db, tmuxAdapter: adapter, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
      now: () => new Date(), sleep: pause });
    await guard.set("a", { mode: "draft-aware" }, "human@test", "AF-148 fixture");
    await vi.waitFor(async () => expect(inspectComposerInput(await adapter.captureComposerSnapshot(pane)).state).toBe("empty"), { timeout: 5000 });
    await fn({
      send: (id, text) => transport!.send("worker@test", text, { deliveryId: id, actorSession: "sender@test", verify: true }),
      state,
      row: id => {
        const r = db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { delivery_state: string; guard_delivery: string } | undefined;
        return { state: r?.delivery_state, stored: r?.guard_delivery, result: r?.guard_delivery ? JSON.parse(r.guard_delivery).result : undefined };
      },
    });
  } finally {
    await transport?.guardedDelivery?.stop();
    await tmux(["kill-server"]).catch(() => {});
    db.close(); rmSync(scratch, { recursive: true, force: true });
  }
}

async function submitsOnce(config: object, id: string, text: string) {
  await seat(config, async ({ send, state, row }) => {
    const started = Date.now();
    const result = await send(id, text);
    expect(result).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
    expect(Date.now() - started).toBeLessThan(4000);
    await vi.waitFor(() => expect(state().submissions).toEqual([text]), { timeout: 3000 });
    expect(state().input).toBe("");
    expect(row(id).state).toBe("delivered");
  });
}

describe.skipIf(process.platform === "win32")("AF-148: a delivery's own late-collapsed paste is submitted; another paste never is", () => {
  it("1. (A) our text first, then the label 100 ms later: submitted once", () => submitsOnce({ mode: "raw", collapseMs: 100 }, "late-raw", ours), 30_000);

  it("1b. (C) the paste is drawn 40 ms late, then a label at once: submitted once", () => submitsOnce({ mode: "immediate", renderDelayMs: 40 }, "late-draw-label", ours), 30_000);

  it("1c. (C) the paste is drawn 40 ms late, our text first, then the label: submitted once", () => submitsOnce({ mode: "raw", collapseMs: 100, renderDelayMs: 40 }, "late-draw-raw", ours), 30_000);

  it("2. (B) no readable composer for 800 ms, then the label: submitted once", () => submitsOnce({ mode: "hidden", hideMs: 800 }, "late-hidden", ours), 30_000);

  it("3. another same-line-count paste replaces ours before it collapses: refused, untouched, recorded by shape", async () => {
    await seat({ mode: "raw", collapseMs: 100, foreign: { afterMs: 40, text: foreign } }, async ({ send, state, row }) => {
      const result = await send("replaced", ours);
      expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
      expect(result.error).toContain("Enter was not sent");
      await pause(1500);   // longer than any settle window: no late Enter
      expect(state()).toEqual({ input: foreign, submissions: [] });
      const refused = row("replaced").result?.refusedInput;
      expect(refused?.state).toBe("text");
      expect(refused?.labelPresent).toBe(true);
      // The two facts the next stranding needs, by shape only.
      expect(refused?.frameMatched).toBe(false);   // the footer drops "· ← for agents" once the box has content
      expect(typeof refused?.paste?.labelSeen).toBe("boolean");
      expect(typeof refused?.paste?.labelAdopted).toBe("boolean");
      expect(refused?.paste?.labelAdopted).toBe(false);
      expect(refused?.paste?.foreignReads).toBeGreaterThanOrEqual(1);
      expect(typeof refused?.paste?.reads).toBe("number");
      for (const recorded of [JSON.stringify(result), row("replaced").stored!]) {
        expect(recorded).not.toContain("human's pasted block");
        expect(recorded).not.toContain("Pasted text");
      }
    });
  }, 30_000);

  it("3b. another same-line-count paste replaces our settled raw text and collapses at once: never submitted, untouched", async () => {
    await seat({ mode: "none", foreign: { afterMs: 400, text: foreign, mode: "immediate" } }, async ({ send, state, row }) => {
      const result = await send("replaced-at-once", ours);
      await pause(1500);   // longer than any settle window: no late Enter
      // Either ours was submitted before the other block replaced it, or Enter was refused; the other block never is.
      expect(state().input).toBe(foreign);
      expect(state().submissions).not.toContain(foreign);
      if (result.ok) {
        expect(state().submissions).toEqual([ours]);
      } else {
        expect(result).toMatchObject({ sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
        expect(state().submissions).toEqual([]);
        expect(row("replaced-at-once").result?.refusedInput?.paste?.labelAdopted).toBe(false);
      }
    });
  }, 30_000);

  it("3c. a human clears our text and pastes a same-line-count block that collapses at once, within 300 ms: refused", async () => {
    await seat({ mode: "none", foreign: { afterMs: 60, clearMs: 100, text: foreign, mode: "immediate" } }, async ({ send, state, row }) => {
      const result = await send("cleared-replaced", ours);
      expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
      await pause(1500);   // longer than any settle window: no late Enter
      expect(state()).toEqual({ input: foreign, submissions: [] });
      expect(row("cleared-replaced").result?.refusedInput?.paste?.labelAdopted).toBe(false);
      expect(row("cleared-replaced").result?.refusedInput?.paste?.foreignReads).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);

  it("4a. a multi-line message that never collapses is still submitted", () => submitsOnce({ mode: "none" }, "never", ours), 30_000);
  it("4b. a label shown at once is still submitted", () => submitsOnce({ mode: "immediate" }, "immediate", ours), 30_000);
  it("4c. a one-line message is still submitted", () => submitsOnce({ mode: "raw", collapseMs: 100 }, "one-line", "one line, nothing to collapse"), 30_000);
  it("4d. a box that never becomes readable: the send gives up within 4 s and sends no Enter", async () => {
    await seat({ mode: "hidden", hideMs: 20_000 }, async ({ send, state }) => {
      const started = Date.now();
      const result = await send("never-readable", ours);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown", delivery: { state: "indeterminate" } });
      expect(result.error).toContain("Enter was not sent");
      expect(state().submissions).toEqual([]);
    });
  }, 30_000);
});
