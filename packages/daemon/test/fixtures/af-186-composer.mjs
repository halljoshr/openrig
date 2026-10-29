// AF-186: a deterministic Claude-like composer for the watchdog's own wake. It is not a provider emulator.
//   argv: <stateFile> <config JSON>
//   config.draft:          text already typed in the box (a human's unsent draft) when the composer starts
//   config.swallowEnters:  how many Enters, after a paste lands, are lost (the seat is still taking the paste in)
//   config.typeAfterPasteMs, config.typeText: a human types typeText this long after a paste lands
//   config.typeAfterEnterMs: a human types typeText this long after the first Enter that follows a paste arrives
//   config.unreadable:     the composer never draws a readable box (like a runtime whose box OpenRig can't read)
//   config.unreadableMs:   the box is unreadable for this long after the composer starts, then readable (a redraw)
//   config.unreadableAfterEnterMs: the box is unreadable for this long after the first Enter that follows a paste
//   config.collapseMs:     a multi-line paste shows raw first and collapses this long after it's drawn (default 0: at once)
//   config.renderDelayMs:  the seat draws a paste this long after it lands; until then the box shows what it showed before
// A multi-line paste collapses into "[Pasted text #N +M lines]", at once or after collapseMs, as a live Claude seat does
// with the watchdog's two-line wake (AF-148's late-collapse shapes: test/fixtures/af-148-collapse-composer.mjs). Like a live Claude seat, the footer reads "… · ← for agents" only while the box is empty.
// Enter submits the full text behind the label. The state file records the input, every submission and every Enter.
import { writeFileSync, renameSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import stringWidth from "string-width";

const [stateFile, configJson] = process.argv.slice(2);
const config = { swallowEnters: 0, ...JSON.parse(configJson ?? "{}") };
let input = config.draft ?? "", pending = "", pasting = false, pasted = "", pastes = 0, label = "";
let swallow = 0, enters = 0, enteredSincePaste = false, hidden = !!config.unreadableMs;
if (config.unreadableMs) setTimeout(() => { hidden = false; render(); }, config.unreadableMs);
const submissions = [];
const decoder = new StringDecoder("utf8");

function render() {
  const rows = ["Editable delivery fixture", ...submissions.slice(-3).flatMap(text => text.split("\n"))];
  let cursor = [rows.length + 1, 1];
  if (config.unreadable || hidden) {
    rows.push("✻ Working…");
  } else {
    rows.push("────────────────────────────────────────");
    const start = rows.length;
    const body = label ? [label] : input.split("\n");
    rows.push(`❯ ${body[0]}`, ...body.slice(1).map(line => `  ${line}`));
    cursor = [start + body.length, 3 + stringWidth(body.at(-1))];
    rows.push("────────────────────────────────────────",
      input ? "  ⏵⏵ auto mode on (shift+tab to cycle)" : "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents");
  }
  process.stdout.write(`\x1b[2J\x1b[H${rows.join("\r\n")}\x1b[${cursor[0]};${cursor[1]}H`);
  writeFileSync(`${stateFile}.tmp`, JSON.stringify({ input, submissions, enters }));
  renameSync(`${stateFile}.tmp`, stateFile);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", data => {
  pending += decoder.write(data);
  while (pending.length) {
    if (pending.startsWith("\x1b[200~")) { pasting = true; pasted = ""; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) {
      pasting = false; pending = pending.slice(6);
      const landed = pasted; pastes++;
      const draw = () => {
        input += landed;
        // Typed text after a paste stays behind no label, as in Claude: the label shows only for a pure paste.
        const next = landed.includes("\n") && input === landed ? `[Pasted text #${pastes} +${landed.split("\n").length - 1} lines]` : "";
        if (!next || !config.collapseMs) { label = next; return; }
        label = "";
        setTimeout(() => { if (input === landed) label = next; render(); }, config.collapseMs);
      };
      if (config.renderDelayMs) setTimeout(() => { draw(); render(); }, config.renderDelayMs); else draw();
      swallow = config.swallowEnters; enteredSincePaste = false;
      if (config.typeAfterPasteMs && config.typeText) {
        const text = config.typeText; config.typeText = undefined;
        setTimeout(() => { input += text; label = ""; render(); }, config.typeAfterPasteMs);
      }
      continue;
    }
    if (pending[0] === "\x1b" && pending.length < 6) break;
    const char = pending[0]; pending = pending.slice(1);
    if (pasting) { pasted += char === "\r" ? "\n" : char; continue; }
    if (char === "\r" || char === "\n") {
      enters++;
      if (!enteredSincePaste && config.typeAfterEnterMs && config.typeText) {
        const text = config.typeText; config.typeText = undefined;
        setTimeout(() => { input += text; label = ""; render(); }, config.typeAfterEnterMs);
      }
      if (!enteredSincePaste && config.unreadableAfterEnterMs) {
        hidden = true; setTimeout(() => { hidden = false; render(); }, config.unreadableAfterEnterMs);
      }
      enteredSincePaste = true;
      if (swallow > 0) { swallow--; continue; }
      if (input) submissions.push(input);
      input = ""; label = "";
    } else if (char === "\x15") { input = ""; label = ""; }
    else if (char >= " ") { input += char; label = ""; }
  }
  render();
});
render();
