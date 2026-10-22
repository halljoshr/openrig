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
import type { ComposerInput } from "../src/domain/composer-prompts.js";
import { inspectComposerInput } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";

// AF-145 (https://github.com/Newity-LLC/agent-factory/issues/145): a draft-aware send must not be left typed in the
// input box without Enter because the one pre-Enter read caught the box mid-redraw. On 2026-10-21, 10 of 81 guarded
// deliveries to the factory's orchestrator and PM seats ended "Text is in ..., but the Enter reported a failure",
// and Josh's later Enter submitted each one normally, so the box held only the delivery's text.
//   1. A pre-Enter read that is unknown for a moment submits: copy mode from before the 200 ms pre-Enter sleep until
//      350 ms, so the read starts unknown and the box is readable again about 150 ms later, inside a 10 x 50 ms settle.
//   1b. The same for a readable box that is not yet provably owned (cursor off the end for a moment): it submits.
//   2. A pre-Enter read that stays unknown sends no Enter, leaves the box untouched, and records what it read.
//   3. A real human addition before Enter is still protected: no Enter, the human's text untouched, the read
//      recorded, and the error says Enter was not sent (not "the Enter reported a failure").
//   4. An ordinary send still submits once.
//   5. (Pre-PR review BLOCKING) A collapsed-paste label the paste never showed is not ours: when one with the same
//      line count turns up only at the pre-Enter read (Josh pasted), Enter is refused. A label seen at the paste is
//      still ours and submits, and so is a late one the read proves is this paste (pasteMatchesExpected). The
//      fixture can't render a collapsed label, so case 5 scripts the guard's reads.
//   Cases 3 and 5 also check the refusal record holds no box text; case 2, that a post-paste refusal doesn't say "held".
// Same private tmux fixture as draft-aware-delivery-native.test.ts: the real cursor/capture/paste/Enter path.
const run = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const composer = fileURLToPath(new URL("./fixtures/draft-composer.mjs", import.meta.url));

describe.skipIf(process.platform === "win32")("AF-145: the pre-Enter check settles before refusing", () => {
  it.each(["claude", "codex"])("%s input: a momentary unreadable box submits; a lasting one or a human edit is left alone and recorded", async runtime => {
    const scratch = mkdtempSync(join(tmpdir(), "af145-"));
    const socket = join(scratch, "s");
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_TMPDIR;
    const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
    const state = () => JSON.parse(readFileSync(join(scratch, "a.json"), "utf8")) as { input: string; submissions: string[] };
    const waitInput = async (input: string) => vi.waitFor(() => expect(state().input).toBe(input), { timeout: 5000, interval: 25 });
    const db = new Database(":memory:");
    let transport: SessionTransport | undefined;
    const timers: NodeJS.Timeout[] = [];
    try {
      const command = [process.execPath, composer, runtime, join(scratch, "a.json")].map(shellQuote).join(" ");
      const pane = (await tmux(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "120", "-y", "40", "-s", "worker@test", command])).trim();
      await waitInput("");
      migrate(db, ALL_MIGRATIONS);
      db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
        INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal');
        INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
        INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
      db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)").run("binding-a", "a", "worker@test", pane);
      const hooks: { beforeEnter?: () => Promise<void> } = {};
      const adapter = new TmuxAdapter(async () => { throw new Error("Native fixture requires argv execution"); }, undefined, async args => tmux(args.slice(1)));
      const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); adapter.deliveryGuard = guard;
      transport = new SessionTransport({ db, tmuxAdapter: adapter, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
        now: () => new Date(), sleep: async ms => { if (ms === 200) await hooks.beforeEnter?.(); await pause(ms); } });
      const send = (id: string, text: string) => transport!.send("worker@test", text, { deliveryId: id, actorSession: "sender@test", verify: true });
      const row = (id: string) => {
        const r = db.prepare("SELECT delivery_state, guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { delivery_state: string; guard_delivery: string } | undefined;
        return { state: r?.delivery_state, result: r?.guard_delivery ? JSON.parse(r.guard_delivery).result : undefined };
      };
      await guard.set("a", { mode: "draft-aware" }, "human@test", "AF-145 fixture");
      await vi.waitFor(async () => expect(inspectComposerInput(await adapter.captureComposerSnapshot(pane)).state).toBe("empty"), { timeout: 5000 });

      // 4. An ordinary send submits once.
      expect(await send("plain", "plain message")).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
      await vi.waitFor(() => expect(state().submissions).toEqual(["plain message"]));

      // 1. The box is unreadable when the pre-Enter read starts (copy mode hides the composer; the hook runs before the
      //    200 ms sleep), and readable again about 150 ms into that read.
      //    Today: one read, draft_input_unknown, the text left typed. Fixed: the read settles and Enter is sent.
      hooks.beforeEnter = async () => {
        hooks.beforeEnter = undefined;
        await tmux(["copy-mode", "-t", pane]);
        timers.push(setTimeout(() => { void tmux(["send-keys", "-t", pane, "-X", "cancel"]).catch(() => {}); }, 350));
      };
      const momentary = await send("momentary", "momentary redraw");
      expect(momentary).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
      await vi.waitFor(() => expect(state().submissions).toEqual(["plain message", "momentary redraw"]));
      expect(state().input).toBe("");
      expect(row("momentary").state).toBe("delivered");

      // 1b. The production signature (all 10 strandings were draft_input_changed): the box is READABLE but not yet
      //     provably owned when the pre-Enter read starts (cursor moved to the start, so cursorAtEnd is false), and
      //     owned again about 150 ms later (cursor back at the end). Today: draft_input_changed, the text left typed.
      //     Fixed: the read settles until known AND owned, and Enter is sent. (Pre-build review r1: a retry that
      //     only waits out "unknown" passed case 1 and left this one broken.)
      hooks.beforeEnter = async () => {
        hooks.beforeEnter = undefined;
        await tmux(["send-keys", "-t", pane, "C-a"]);
        timers.push(setTimeout(() => { void tmux(["send-keys", "-t", pane, "C-e"]).catch(() => {}); }, 350));
      };
      const unowned = await send("unowned", "cursor moved for a moment");
      expect(unowned).toMatchObject({ ok: true, sent: true, delivery: { state: "complete" } });
      await vi.waitFor(() => expect(state().submissions).toEqual(["plain message", "momentary redraw", "cursor moved for a moment"]));
      expect(state().input).toBe("");
      expect(row("unowned").state).toBe("delivered");

      // 2. The box stays unreadable through the whole settle window: no Enter, the box untouched, the read recorded.
      hooks.beforeEnter = async () => {
        hooks.beforeEnter = undefined;
        await tmux(["copy-mode", "-t", pane]);
      };
      const lasting = await send("lasting", "lasting redraw");
      expect(lasting).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown", delivery: { state: "indeterminate" } });
      expect(lasting.error).toContain("Enter was not sent");
      expect(lasting.error).not.toContain("reported a failure");
      // Pre-PR review MEDIUM: after the paste nothing is held (the row is indeterminate), so the error must not say so.
      expect(lasting.error).not.toMatch(/\bheld\b/i);
      expect(row("lasting").result?.refusedInput?.state).toBe("unknown");
      await tmux(["send-keys", "-t", pane, "-X", "cancel"]);
      await waitInput("lasting redraw");
      expect(state().submissions).toEqual(["plain message", "momentary redraw", "cursor moved for a moment"]);
      await tmux(["send-keys", "-t", pane, "C-u"]); await waitInput("");

      // 3. A human adds to the box before Enter: still never submitted, the human text untouched, the read recorded.
      hooks.beforeEnter = async () => {
        hooks.beforeEnter = undefined;
        await tmux(["send-keys", "-t", pane, "-l", " plus a human draft"]);
        await waitInput("second message plus a human draft");
      };
      const human = await send("human", "second message");
      expect(human).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed", delivery: { state: "indeterminate" } });
      expect(human.error).toContain("Enter was not sent");
      expect(human.error).not.toContain("reported a failure");
      expect(row("human").result?.refusedInput?.state).toBe("text");
      // Pre-PR review HIGH: the refusal record is the box's shape, never its text. Josh's draft is in neither the
      // result nor the stored outbox row.
      const stored = (db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get("human") as { guard_delivery: string }).guard_delivery;
      expect(JSON.stringify(human)).not.toContain("human draft");
      expect(stored).not.toContain("human draft");
      expect(typeof row("human").result?.refusedInput?.cursorAtEnd).toBe("boolean");
      expect(JSON.stringify(row("human").result?.refusedInput)).not.toContain("second message");
      await pause(700);   // longer than any settle window: no late Enter
      expect(state()).toEqual({ input: "second message plus a human draft", submissions: ["plain message", "momentary redraw", "cursor moved for a moment"] });
    } finally {
      timers.forEach(clearTimeout);
      await transport?.guardedDelivery?.stop();
      await tmux(["kill-server"]).catch(() => {});
      db.close(); rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it("5. a collapsed-paste label first seen at the pre-Enter read is not ours; one seen at the paste is", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
        INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal');
        INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
        INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
      db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)").run("binding-a", "a", "worker@test", "%1");
      const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
      const text = "first line\nsecond line\nthird line";   // two line breaks, so a "+2 lines" label has its line count
      const label = (n: number): ComposerInput => ({ state: "text", rows: [`[Pasted text #${n} +2 lines]`], columns: 120, cursorAtEnd: true, collapsedPaste: `[Pasted text #${n} +2 lines]` });
      const unknown: ComposerInput = { state: "unknown", rows: [], columns: 120, cursorAtEnd: false, collapsedPaste: null };
      let reads = { paste: unknown, enter: unknown };
      let phase: "paste" | "enter" = "paste";
      guard.attachInputInspection(async () => reads[phase], async () => false);
      await guard.set("a", { mode: "draft-aware" }, "human@test", "AF-145 case 5");
      // The transport's order: stage the text, paste and observe it, then the pre-Enter check.
      const deliver = (r: typeof reads) => {
        reads = r;
        return guard.operation("worker@test", async () => {
          phase = "paste"; guard.expectStagedInput("worker@test", text); await guard.notePasted("worker@test", text);
          phase = "enter"; await guard.beforeInput("worker@test", true);
        });
      };

      // Ours: the label shows at the paste and is unchanged before Enter. Enter is allowed.
      await expect(deliver({ paste: label(7), enter: label(7) })).resolves.toBeUndefined();

      // Also ours: the label shows only at the pre-Enter read (a late redraw), but the read proves it is this
      // delivery's paste (pasteMatchesExpected). Enter is allowed, so the fix can't simply refuse every late label.
      await expect(deliver({ paste: unknown, enter: { ...label(8), pasteMatchesExpected: true } })).resolves.toBeUndefined();

      // Josh's: the paste-time reads never saw a label (unknown throughout), and a same-line-count label turns up
      // only at the pre-Enter read. Today it is adopted and Enter would submit Josh's paste. Fixed: refused.
      const refusal = await deliver({ paste: unknown, enter: label(99) }).then(() => undefined, (error: unknown) => error);
      expect(refusal).toMatchObject({ code: "draft_input_changed" });
      expect((refusal as { refusedInput?: { state?: string } }).refusedInput?.state).toBe("text");
      expect(JSON.stringify((refusal as { refusedInput?: unknown }).refusedInput)).not.toContain("Pasted text");
    } finally {
      db.close();
    }
  });
});
