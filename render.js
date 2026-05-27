/* Pure terminal-rendering toolkit: ANSI, color ramps, and braille canvas.
 * No application state — safe to import anywhere. */

export const ESC = "\x1b[";
export const HOME = `${ESC}H`;
export const CLEAR = `${ESC}2J${ESC}H`;
export const HIDE = `${ESC}?25l`;
export const SHOW = `${ESC}?25h`;
export const RESET = `${ESC}0m`;
export const EOL = `${ESC}K`;
export const bold = `${ESC}1m`;
export const fg = (n) => `${ESC}38;5;${n}m`;
export const bg = (n) => `${ESC}48;5;${n}m`;

/* low→high heat ramp (256-color) and silent/background slot */
export const HEAT = [17, 18, 19, 20, 26, 32, 39, 45, 51, 50, 48, 46, 82, 118,
  154, 190, 226, 220, 214, 208, 202, 196, 197, 231];
export const SILENT_BG = 234;
export const EIGHTH = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]; /* sub-cell bar tops */
export const FREQ_PALETTE = [46, 51, 201, 226, 208, 129, 87, 213, 118, 220, 159, 196];

/* frame-class colors */
export const C_MGMT = 51, C_CTRL = 226, C_DATA = 46, C_ALERT = 196;

/* dBm → 0..1 strength (−90 weak … −30 strong); 0/unknown → floor */
export function strength(dbm) {
  if (!dbm) return 0;
  return Math.max(0, Math.min(1, (dbm + 90) / 60));
}
export function sigColorN(s) {
  if (s >= 0.66) return 46;
  if (s >= 0.45) return 226;
  if (s >= 0.25) return 208;
  return 196;
}
export function sigColor(s) { return fg(sigColorN(s)); }

export function mmss(ms) {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/* one heat cell: v<0 → idle (dark bg), else a bg-colored block */
export function heatCell(v) {
  if (v < 0) return bg(SILENT_BG) + " " + RESET;
  return bg(HEAT[Math.min(HEAT.length - 1, Math.floor(v * HEAT.length))]) + " " + RESET;
}

/* Braille canvas: each cell packs a 2×4 dot grid, so cw×ch cells give
 * 2cw×4ch pixels. One fg color per cell (last writer wins). (0,0) top-left. */
const BRAILLE_DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
export function brailleCanvas(cw, ch) {
  const PW = cw * 2, PH = ch * 4;
  const mask = new Int32Array(cw * ch);
  const color = new Array(cw * ch).fill(0);
  return {
    PW, PH,
    set(px, py, col) {
      if (px < 0 || px >= PW || py < 0 || py >= PH) return;
      const i = (py >> 2) * cw + (px >> 1);
      mask[i] |= BRAILLE_DOT[py & 3][px & 1];
      if (col) color[i] = col;
    },
    rows() {
      const out = [];
      for (let cy = 0; cy < ch; cy++) {
        let line = "";
        for (let cx = 0; cx < cw; cx++) {
          const i = cy * cw + cx, m = mask[i];
          line += m === 0 ? " " : fg(color[i] || 51) + String.fromCodePoint(0x2800 + m) + RESET;
        }
        out.push(line);
      }
      return out;
    },
  };
}

/* braille line/area chart: series = [{data:[0..1|null], color}].
 * Lines connect vertically between samples; fill draws to the baseline. */
export function brailleChart(cw, ch, series, fill) {
  const cv = brailleCanvas(cw, ch);
  const PW = cv.PW, PH = cv.PH;
  for (const s of series) {
    const d = s.data, n = d.length;
    if (!n) continue;
    let prev = null;
    for (let px = 0; px < PW; px++) {
      const t = n === 1 ? 0 : (px / (PW - 1)) * (n - 1);
      const i0 = Math.floor(t), i1 = Math.min(n - 1, i0 + 1), f = t - i0;
      const a = d[i0], b = d[i1];
      if (a == null || b == null) { prev = null; continue; }
      const v = Math.max(0, Math.min(1, a + (b - a) * f));
      const py = Math.round((1 - v) * (PH - 1));
      if (fill) { for (let y = py; y < PH; y++) cv.set(px, y, s.color); }
      else {
        cv.set(px, py, s.color);
        if (prev != null) {
          const lo = Math.min(prev, py), hi = Math.max(prev, py);
          for (let y = lo; y <= hi; y++) cv.set(px, y, s.color);
        }
        prev = py;
      }
    }
  }
  return cv.rows();
}
