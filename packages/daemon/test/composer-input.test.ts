import { describe, expect, it } from "vitest";
import { classifyPaneActivity, inspectComposerInput } from "../src/domain/session-transport.js";
import { composerContainsOwnedText, ownCollapsedPaste, type ComposerSnapshot } from "../src/domain/composer-prompts.js";

function claude(body: string, cursor?: { x: number; y: number }, width = 80): ComposerSnapshot {
  const rows = body.split("\n");
  const last = rows.at(-1)!;
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + last.length, y: 1 + rows.length, width, height: 24, ...cursor }, inMode: false };
}

describe("cursor-bound composer input", () => {
  it("keeps nested prompt examples inside the current draft, including when its head is clipped", () => {
    const body = "intro\n────────────────────\n❯ \n────────────────────\n? for shortcuts\n────────────────────\n❯ ";
    const snapshot = claude(body, { x: 4, y: 8 });
    expect(inspectComposerInput(snapshot).state).toBe("text");
    const clipped = { ...snapshot, screen: snapshot.screen.split("\n").slice(3).join("\n"), cursor: { ...snapshot.cursor, y: 5 } };
    expect(inspectComposerInput(clipped).state).toBe("unknown");
  });

  it("uses the styled input read for opted-in readiness, while preserving default draft and permission checks", () => {
    const snapshot = claude("\x1b[2msuggested follow-up\x1b[22m", { x: 2, y: 2 });
    snapshot.screen = snapshot.screen.replace("? for shortcuts", "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents\n✘ Auto-update failed: no write permission to npm prefix · Run claude doctor");
    const plain = snapshot.screen.replace(/\x1b\[[0-9;]*m/g, "");
    expect(classifyPaneActivity(plain)).toMatchObject({ state: "attention", reason: "prompt_draft" });
    expect(classifyPaneActivity(plain, { composerSnapshot: snapshot })).toMatchObject({ state: "agent_idle" });
    const permission = { ...snapshot, screen: snapshot.screen.replace("Ready", "Do you want to allow this command?") };
    expect(classifyPaneActivity(plain, { composerSnapshot: permission })).toMatchObject({ state: "attention", reason: "permission_prompt" });
  });

  it("ignores a dim autocomplete suggestion at an empty cursor, preserving real drafts with the same spelling", () => {
    const ghost = "Summarize the recent changes";
    expect(inspectComposerInput(claude(`\x1b[2m${ghost}\x1b[22m`, { x: 2, y: 2 })).state).toBe("empty");
    expect(inspectComposerInput(claude(ghost, { x: 2, y: 2 })).state).toBe("text");
  });

  it("excludes only a wholly dim suffix after the cursor when identifying staged text", () => {
    const input = inspectComposerInput(claude("owned\x1b[2m ghost suggestion\x1b[22m", { x: 7, y: 2 }));
    expect(input.state).toBe("text");
    expect(composerContainsOwnedText(input, "owned")).toBe(true);
    expect(composerContainsOwnedText(input, "owned ghost suggestion")).toBe(false);
    const mixed = inspectComposerInput(claude("owned\x1b[2m ghost\x1b[22m human", { x: 7, y: 2 }));
    expect(composerContainsOwnedText(mixed, "owned")).toBe(false);
  });

  it("recognizes Claude's non-breaking prompt space without erasing draft content", () => {
    for (const body of ["", "unfinished request"]) {
      const snapshot = claude(body);
      snapshot.screen = snapshot.screen.replace("❯ ", "❯\u00a0");
      const input = inspectComposerInput(snapshot);
      expect(input.state).toBe(body ? "text" : "empty");
      if (body) expect(composerContainsOwnedText(input, body)).toBe(true);
    }
  });

  it.each(["Ask Codex to do anything", "Press up to edit queued messages"])("preserves a literal %s draft at the start cursor", text => {
    expect(inspectComposerInput(claude(text, { x: 2, y: 2 })).state).toBe("text");
  });
  it("distinguishes an empty input from a draft even while a work status is visible", () => {
    const empty = claude(""); empty.screen = empty.screen.replace("Ready", "✻ Working… (2s · esc to interrupt)");
    expect(inspectComposerInput(empty).state).toBe("empty");
    expect(inspectComposerInput(claude("a half-written request")).state).toBe("text");
    expect(inspectComposerInput(claude("", { x: 5, y: 2 })).state).toBe("text");
    expect(inspectComposerInput(claude("\n")).state).toBe("text");
    expect(inspectComposerInput(claude("\n", { x: 2, y: 2 })).state).toBe("text");
    expect(inspectComposerInput(claude("   ", { x: 2, y: 2 })).state).toBe("text");
  });

  it.each(["›", "»"])("recognizes the empty Codex placeholder with marker %s only at the input cursor", marker => {
    const s: ComposerSnapshot = { screen: `Working\n${marker} \x1b[2mAsk Codex to do anything\x1b[22m\n\ngpt-5 · 90% context left\n`, cursor: { x: 2, y: 1, width: 80, height: 24 }, inMode: false };
    expect(inspectComposerInput(s).state).toBe("empty");
    expect(inspectComposerInput({ ...s, cursor: { ...s.cursor, x: 12 } }).state).toBe("text");
  });

  it("does not infer an empty input from history, a selector, copy mode or an incomplete capture", () => {
    expect(inspectComposerInput(null).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), inMode: true }).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), cursor: { x: 0, y: 0, width: 80, height: 24 } }).state).toBe("unknown");
    expect(inspectComposerInput(claude("1. Approve this command")).state).toBe("unknown");
    expect(inspectComposerInput({ ...claude(""), screen: "❯\n" }).state).toBe("unknown");
  });

  it("does not mistake color channel values for faint styling", () => {
    for (const sgr of ["38;2;2;2;2", "38;5;2", "38;2;0;255;255;2", "2;38;5;2;22"]) {
      const value = claude(`\x1b[${sgr}mAsk Codex to do anything\x1b[0m`, { x: 2, y: 2 });
      expect(inspectComposerInput(value).state).toBe("text");
    }
    expect(inspectComposerInput(claude("\x1b[2;38;5;245mAsk Codex to do anything\x1b[0m", { x: 2, y: 2 })).state).toBe("empty");
  });

  it("requires the complete owned text and preserves significant spaces", () => {
    const input = inspectComposerInput(claude("Run two commands\nthen report."));
    expect(composerContainsOwnedText(input, "Run two commands\nthen report.")).toBe(true);
    expect(composerContainsOwnedText(input, "Run twocommands\nthen report.")).toBe(false);
    expect(composerContainsOwnedText(input, "Run two commands")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("owned plus a human draft")), "owned")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("owned", { x: 8, y: 2 })), "owned")).toBe(false);
  });

  it("accepts supported hard and word wrapping without deleting arbitrary whitespace", () => {
    const hard = inspectComposerInput(claude("abcdefgh\nijkl", undefined, 10));
    expect(composerContainsOwnedText(hard, "abcdefghijkl")).toBe(true);
    const words = inspectComposerInput(claude("one two\nthree", undefined, 10));
    expect(composerContainsOwnedText(words, "one two three")).toBe(true);
    expect(composerContainsOwnedText(words, "one  two three")).toBe(false);
    expect(composerContainsOwnedText(inspectComposerInput(claude("one\ntwo")), "one two")).toBe(false);
  });

  it("matches Unicode cell widths and treats an opaque paste as separately owned evidence", () => {
    const input = inspectComposerInput(claude("你好世界\nagain", { x: 7, y: 3 }, 10));
    expect(composerContainsOwnedText(input, "你好世界again")).toBe(true);
    const opaque = inspectComposerInput(claude("[Pasted text #4 +2 lines]"));
    expect(ownCollapsedPaste(opaque, "one\ntwo\nthree")).toBe("[Pasted text #4 +2 lines]");
    expect(ownCollapsedPaste(opaque, "one\ntwo")).toBeNull();
    expect(composerContainsOwnedText(opaque, "one\ntwo\nthree")).toBe(false);
    expect(ownCollapsedPaste(inspectComposerInput(claude("[Pasted text #4 +2 lines] foreign")), "one\ntwo\nthree")).toBeNull();
  });
});

// The bottom rows of a live Claude Code 2.1.289 seat in an 80x24 tmux pane, auto mode, captured with
// `tmux capture-pane -p -e`. Only the seat name is changed. Claude draws its own cursor: a reverse-video
// space after the last typed character, which the terminal cursor sits on.
function liveClaude(prompt: string, cursorX: number): ComposerSnapshot {
  const name = "dev-impl@my-rig";
  const rows = [
    ...Array<string>(14).fill(""),
    "● Ready.",
    "",
    "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mSautéed for 15s · done 2:24 PM\x1b[39m",
    "",
    `\x1b[38;5;244m${"─".repeat(80 - name.length - 3)} ${name} ─`,
    `\x1b[39m❯ ${prompt}\x1b[0m\x1b[39m\x1b[49m`,
    `\x1b[38;5;244m${"─".repeat(80)}`,
    prompt.startsWith("\x1b[7m ")
      ? "\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m"
      : "\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m",
    "",
  ];
  return { screen: rows.join("\n"), cursor: { x: cursorX, y: 19, width: 80, height: 24 }, inMode: false };
}

describe("a live Claude seat's drawn cursor", () => {
  it("reads an empty box as empty, not as a typed space", () => {
    expect(inspectComposerInput(liveClaude("\x1b[7m ", 2), "claude-code")).toMatchObject({ state: "empty", rows: [""] });
  });

  it("reads a draft as its typed text only", () => {
    const input = inspectComposerInput(liveClaude("draft in progress\x1b[7m ", 19), "claude-code");
    expect(input).toMatchObject({ state: "text", rows: ["draft in progress"], cursorAtEnd: true });
  });

  it("keeps a draft whose cursor sits on a typed character", () => {
    expect(inspectComposerInput(liveClaude("\x1b[7md\x1b[0mraft", 2), "claude-code").state).toBe("text");
    expect(inspectComposerInput(liveClaude("dr\x1b[7ma\x1b[0mft", 4), "claude-code")).toMatchObject({ state: "text", rows: ["draft"] });
  });

  it("keeps typed spaces that aren't the drawn cursor", () => {
    expect(inspectComposerInput(liveClaude(" \x1b[7m ", 3), "claude-code").state).toBe("text");
    expect(inspectComposerInput(liveClaude(" ", 2), "claude-code").state).toBe("text");
  });
});
