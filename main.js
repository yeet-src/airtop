import { RingBuf } from "yeet:bpf";
import bpf from "./bin/airtop.bpf.o";

import { ESC, HOME, CLEAR, HIDE, SHOW, RESET, bold, fg } from "./render.js";
import { onFrame, onBss, advance, TICK_MS } from "./state.js";
import { renderDashboard } from "./dashboard.js";

/* ---- terminal size ------------------------------------------------ */
let TCOLS = 80, TROWS = 24;
function refreshSize() {
  try {
    const s = globalThis.tty?.size?.();
    if (s) { TCOLS = Math.max(1, s.cols | 0 || 80); TROWS = Math.max(1, s.rows | 0 || 24); }
  } catch { /* keep current */ }
}

const MIN_COLS = 64, MIN_ROWS = 24;
function centerLine(text, pre = "") {
  const pad = Math.max(0, (TCOLS - text.length) >> 1);
  return " ".repeat(pad) + pre + text + RESET;
}

/* synchronized, flicker-free output via the tty builtin; console fallback */
function paint(out) {
  const t = globalThis.tty;
  if (t?.write) { t.beginFrame?.(); t.write(out); t.endFrame?.(); }
  else console.log(out);
}

function render() {
  if (TCOLS < MIN_COLS || TROWS < MIN_ROWS) {
    let out = HOME + `${ESC}J`;
    for (let i = 0; i < Math.max(0, (TROWS >> 1) - 1); i++) out += "\n";
    out += centerLine("terminal too small", bold + fg(196)) + "\n";
    out += centerLine(`need ≥ ${MIN_COLS}×${MIN_ROWS} · have ${TCOLS}×${TROWS}`, fg(244));
    paint(out);
    return;
  }
  advance();
  let out = HOME;
  for (const line of renderDashboard(TCOLS, TROWS)) out += line + "\n";
  out += `${ESC}J`;
  paint(out);
}

/* ---- run ---------------------------------------------------------- */
const control = await bpf
  .bind("frames", { kind: "ringbuf", btf_struct: "dot11_evt" })
  .bind("aps", { kind: "ringbuf", btf_struct: "ap_evt" })
  .start();

await new RingBuf(control, "frames").subscribe(
  (evt) => onFrame(evt.dot11_evt ?? evt),
  (err) => console.error(err.message),
);
await new RingBuf(control, "aps").subscribe(
  (evt) => onBss(evt.ap_evt ?? evt),
  (err) => console.error(err.message),
);

refreshSize();
globalThis.tty?.on?.("resize", (s) => {
  if (s) { TCOLS = Math.max(1, s.cols | 0 || TCOLS); TROWS = Math.max(1, s.rows | 0 || TROWS); }
  paint(CLEAR); /* drop stale cells from the old geometry */
});

paint(HIDE + CLEAR);
setInterval(render, TICK_MS);

/* Runs until Ctrl-C. */
await new Promise(() => {});
