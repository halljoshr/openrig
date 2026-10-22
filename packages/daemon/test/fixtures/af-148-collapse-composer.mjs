// AF-148: a deterministic Claude-like composer that collapses a multi-line bracketed paste into
// "[Pasted text #N +M lines]" late, the way a live Claude Code seat can. It is not a provider emulator.
//   argv: <stateFile> <config JSON>
//   config.mode: "raw"       our text shows first, then the label after collapseMs
//                "hidden"    no readable composer for hideMs, then the label
//                "immediate" the label at once (the case OpenRig already handles)
//                "none"      never collapses
//   config.foreign: { afterMs, text, mode }  a human-like clear-and-paste of other text afterMs after our paste,
//                                             drawn by its own mode (default "raw")
// Like a live Claude seat on this rig, the footer reads "… · ← for agents" only while the box is empty.
// Enter submits the full text behind the label. The state file records the input and every submission.
import { writeFileSync, renameSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import stringWidth from "string-width";

const [stateFile, configJson] = process.argv.slice(2);
const config = { mode: "none", collapseMs: 100, hideMs: 800, ...JSON.parse(configJson ?? "{}") };
let input = "", pending = "", pasting = false, pasted = "", pastes = 0;
let view = "raw", label = "";   // view: raw | label | hidden
const submissions = [];
const timers = [];
let collapsing;   // the pending collapse of the latest paste
const decoder = new StringDecoder("utf8");

function render() {
  const rows = ["Editable delivery fixture", ...submissions.slice(-3).flatMap(text => text.split("\n"))];
  let cursor = [rows.length + 1, 1];
  if (view === "hidden") {
    rows.push("✻ Pasting…");
  } else {
    rows.push("────────────────────────────────────────");
    const start = rows.length;
    const body = view === "label" ? [label] : input.split("\n");
    rows.push(`❯ ${body[0]}`, ...body.slice(1).map(line => `  ${line}`));
    cursor = [start + body.length, 3 + stringWidth(body.at(-1))];
    rows.push("────────────────────────────────────────",
      input ? "  ⏵⏵ auto mode on (shift+tab to cycle)" : "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents");
  }
  process.stdout.write(`\x1b[2J\x1b[H${rows.join("\r\n")}\x1b[${cursor[0]};${cursor[1]}H`);
  writeFileSync(`${stateFile}.tmp`, JSON.stringify({ input, submissions }));
  renameSync(`${stateFile}.tmp`, stateFile);
}

function later(ms, fn) { const timer = setTimeout(() => { fn(); render(); }, ms); timers.push(timer); return timer; }

// A paste of more than one line collapses; how and when depends on the mode.
function collapse(text, mode) {
  pastes++;
  const next = `[Pasted text #${pastes} +${text.split("\n").length - 1} lines]`;
  if (mode === "none" || !text.includes("\n")) { view = "raw"; return; }
  if (mode === "immediate") { view = "label"; label = next; return; }
  if (mode === "hidden") { view = "hidden"; collapsing = later(config.hideMs, () => { view = "label"; label = next; }); return; }
  view = "raw"; collapsing = later(config.collapseMs, () => { view = "label"; label = next; });
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
      input += pasted;
      collapse(pasted, config.mode);
      if (config.foreign) {
        const foreign = config.foreign; config.foreign = undefined;
        // The human's paste replaces ours, so ours never collapses.
        later(foreign.afterMs, () => { clearTimeout(collapsing); input = foreign.text; collapse(foreign.text, foreign.mode ?? "raw"); });
      }
      continue;
    }
    if (pending[0] === "\x1b" && pending.length < 6) break;
    const char = pending[0]; pending = pending.slice(1);
    if (pasting) pasted += char === "\r" ? "\n" : char;
    else if (char === "\r" || char === "\n") { submissions.push(input); input = ""; view = "raw"; }
    else if (char === "\x15") { input = ""; view = "raw"; }
    else if (char >= " ") { input += char; view = "raw"; }
  }
  render();
});
render();
