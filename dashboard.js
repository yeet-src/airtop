/* Dashboard composition: each panel returns/pushes pre-sized lines, and
 * `renderDashboard(C, R)` lays them out to fill a C×R terminal. */

import {
  fg, bg, bold, RESET, EOL, EIGHTH, FREQ_PALETTE, C_ALERT,
  strength, sigColor, sigColorN, heatCell, brailleChart, mmss,
} from "./render.js";
import {
  stations, ssidByBssid, chans, aps, sigBuckets, catHeat, tot,
  startTime, totalFrames, FRAME_CATS, SIG_LO, SIG_HI, SIG_NB, TICK_MS,
  alias, freqToChan, topRssiStations,
} from "./state.js";

const FREQ_BANDS = [
  { name: "2.4 GHz", lo: 2400, hi: 2495 },
  { name: "5 GHz", lo: 5150, hi: 5895 },
  { name: "6 GHz", lo: 5925, hi: 7125 },
];

/* ---- layout helpers ---------------------------------------------- */
function topRule(C, title) {
  const head = ` ▌ ${title} `;
  return bold + fg(51) + head + RESET + fg(238) + "─".repeat(Math.max(0, C - head.length)) + RESET + EOL;
}
function botRule(C) { return fg(238) + "─".repeat(C) + RESET + EOL; }
function bandTitle(C, text) {
  return `${fg(45)}  ${text} ${fg(238)}${"─".repeat(Math.max(0, C - text.length - 3))}${RESET}${EOL}`;
}
function sectionTitle(lw, left, right) {
  return `${fg(45)}${left}${" ".repeat(Math.max(1, lw - left.length))}${fg(238)}│ ` +
    `${fg(45)}${right}${RESET}${EOL}`;
}
function zip(L, R, lw, rw, rows) {
  const h = Math.max(L.length, R.length);
  const bl = " ".repeat(lw), br = " ".repeat(rw);
  for (let i = 0; i < h; i++)
    rows.push(`${L[i] ?? bl}${fg(238)}│${RESET} ${R[i] ?? br}${EOL}`);
}

/* ---- panels ------------------------------------------------------- */
/* frequency spectrum: AP RSSI humps on a MHz axis (pushes rows directly) */
function drawBand(rows, band, C, H) {
  const list = [...aps.values()]
    .filter((a) => a.signal && a.freq >= band.lo && a.freq <= band.hi)
    .sort((a, b) => (b.signal || -200) - (a.signal || -200));

  const span = band.hi - band.lo;
  const cellF = (x) => band.lo + (x / (C - 1)) * span;
  const HW = 11; /* half-width MHz ≈ a 20 MHz channel */
  const val = new Array(C).fill(0), col = new Array(C).fill(0);
  list.forEach((a, i) => {
    const s = strength(a.signal), color = FREQ_PALETTE[i % FREQ_PALETTE.length];
    for (let x = 0; x < C; x++) {
      const d = (cellF(x) - a.freq) / HW;
      const v = d > -1 && d < 1 ? s * (1 - d * d) : 0;
      if (v > val[x]) { val[x] = v; col[x] = color; }
    }
  });

  const label = new Array(C).fill(null);
  list.forEach((a, i) => {
    const cx = Math.round(((a.freq - band.lo) / span) * (C - 1));
    const name = `${alias(a.ssid || "‹hidden›").slice(0, 12)} ${a.signal}dBm`;
    const start = Math.max(0, Math.min(C - name.length, cx - (name.length >> 1)));
    let free = true;
    for (let k = 0; k < name.length; k++) if (label[start + k]) { free = false; break; }
    if (free) for (let k = 0; k < name.length; k++)
      label[start + k] = { ch: name[k], color: FREQ_PALETTE[i % FREQ_PALETTE.length] };
  });

  const bt = `${band.name} · dBm vs MHz`;
  rows.push(`${fg(45)}  ${bt}  ${fg(238)}${"─".repeat(Math.max(0, C - bt.length - 4))}${RESET}${EOL}`);
  let lbl = "";
  for (let x = 0; x < C; x++) lbl += label[x] ? fg(label[x].color) + label[x].ch + RESET : " ";
  rows.push(lbl + EOL);
  for (let r = 0; r < H; r++) {
    let line = "";
    for (let x = 0; x < C; x++) {
      const eighths = val[x] * H * 8;
      const here = Math.max(0, Math.min(8, Math.round(eighths - (H - 1 - r) * 8)));
      line += here > 0 ? fg(col[x]) + EIGHTH[here] + RESET : " ";
    }
    rows.push(line + EOL);
  }
  let base = "";
  for (let x = 0; x < C; x++) base += x % 12 === 0 ? "┬" : "─";
  rows.push(fg(244) + base + RESET + EOL);
  const ax = new Array(C).fill(" ");
  for (let x = 0; x < C; x += 12) {
    const f = String(Math.round(band.lo + (x / (C - 1)) * span));
    for (let k = 0; k < f.length && x + k < C; k++) ax[x + k] = f[k];
  }
  for (let k = 0; k < 3; k++) ax[C - 3 + k] = "MHz"[k];
  rows.push(bold + fg(250) + ax.join("") + RESET + EOL);
}

/* per-station RSSI over time, as numbered braille mini-graphs */
function panelSmallMultiples(C, h) {
  const tops = topRssiStations();
  const MIN_GW = 16;
  const byWidth = Math.max(1, Math.floor((C + 1) / (MIN_GW + 1)));
  const n = Math.max(1, Math.min(5, tops.length || 1, byWidth));
  const gw = Math.floor((C - (n - 1)) / n);
  const sep = fg(238) + "│" + RESET;
  const headers = [], bodies = [];
  for (let i = 0; i < n; i++) {
    const entry = tops[i];
    if (!entry) {
      headers.push(" ".repeat(gw));
      bodies.push(Array.from({ length: h }, () => " ".repeat(gw)));
      continue;
    }
    const [mac, st] = entry;
    const color = FREQ_PALETTE[i % FREQ_PALETTE.length];
    bodies.push(brailleChart(gw, h, [{ data: st.heat.map((v) => (v < 0 ? null : v)), color }], false));
    const badge = "▰" + (i + 1);
    const dbmStr = st.dbm ? String(st.dbm) + "dBm" : "--";
    const nm = alias(ssidByBssid.get(mac) || mac).slice(0, Math.max(1, gw - 4 - dbmStr.length));
    const plain = 2 + 1 + nm.length + 1 + dbmStr.length;
    headers.push(bold + fg(color) + badge + RESET + " " + fg(248) + nm + " " +
      bold + sigColor(strength(st.dbm)) + dbmStr + RESET +
      " ".repeat(Math.max(0, gw - plain)));
  }
  const body = [];
  for (let r = 0; r < h; r++) body.push(bodies.map((b) => b[r]).join(sep));
  return { header: headers.join(sep), body };
}

/* frame-type × time heatmap rows (history rolled by state.advance) */
function panelFrames(w, h) {
  const labelW = 8, stripN = Math.max(6, w - labelW - 1);
  let max = 1;
  for (let i = 0; i < FRAME_CATS.length; i++)
    for (const n of catHeat[i].slice(-stripN)) max = Math.max(max, n);
  const lines = [];
  for (let i = 0; i < Math.min(h, FRAME_CATS.length); i++) {
    const cat = FRAME_CATS[i];
    const lbl = (cat.alert ? fg(C_ALERT) + bold : fg(252)) + cat.name.padEnd(labelW) + RESET;
    const data = catHeat[i].slice(-stripN);
    let strip = "";
    for (let k = 0; k < stripN - data.length; k++) strip += heatCell(-1);
    for (const n of data) strip += heatCell(n === 0 ? -1 : Math.max(0.12, n / max));
    lines.push(lbl + " " + strip);
  }
  return lines;
}

const HIST_GUTTER = 5; /* width of the histogram's count y-axis */
function compactNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

/* signal distribution as a solid block area, colored by dBm strength,
 * with a frame-count y-axis gutter on the left */
function panelHistB(w, h) {
  let max = 1;
  for (const n of sigBuckets) max = Math.max(max, n);
  const cw = w - HIST_GUTTER; /* chart width after the gutter */
  const val = new Array(cw).fill(0), col = new Array(cw).fill(0);
  for (let x = 0; x < cw; x++) {
    const b = Math.min(SIG_NB - 1, Math.floor((x / cw) * SIG_NB));
    val[x] = sigBuckets[b] / max;
    const dbm = SIG_LO + (b + 0.5) * ((SIG_HI - SIG_LO) / SIG_NB);
    col[x] = sigColorN(strength(dbm));
  }
  const lines = [];
  for (let r = 0; r < h; r++) {
    const tick = r === 0 ? max : r === h - 1 ? 0 : r === (h >> 1) ? Math.round(max / 2) : null;
    let line = tick != null
      ? fg(240) + compactNum(tick).padStart(HIST_GUTTER - 1) + " " + RESET
      : " ".repeat(HIST_GUTTER);
    for (let x = 0; x < cw; x++) {
      const eighths = val[x] * h * 8;
      const here = Math.max(0, Math.min(8, Math.round(eighths - (h - 1 - r) * 8)));
      line += here > 0 ? fg(col[x]) + EIGHTH[here] + RESET : " ";
    }
    lines.push(line);
  }
  return lines;
}

/* dBm x-axis under the histogram (gutter offset, chart spans the rest) */
function histAxis(lw) {
  const cw = lw - HIST_GUTTER;
  const ax = new Array(lw).fill(" ");
  for (const d of [-90, -70, -50, -30]) {
    const x = HIST_GUTTER + Math.round(((d - SIG_LO) / (SIG_HI - SIG_LO)) * (cw - 1));
    const lab = String(d);
    const s = Math.max(0, Math.min(lw - lab.length, x - (lab.length >> 1)));
    for (let k = 0; k < lab.length; k++) ax[s + k] = lab[k];
  }
  return bold + fg(250) + ax.join("") + RESET;
}

/* discovered APs: SSID, channel, signal gauge, dBm */
function panelAPs(w, h) {
  const barW = Math.max(6, Math.min(12, w - 26));
  const nameW = Math.max(6, w - barW - 15);
  const list = [...aps.values()]
    .sort((a, b) => (b.signal || -200) - (a.signal || -200)).slice(0, h);
  const lines = list.map((ap) => {
    const s = strength(ap.signal);
    const name = alias(ap.ssid || "‹hidden›").slice(0, nameW).padEnd(nameW);
    const chN = freqToChan(ap.freq, ap.freq >= 5000 ? 1 : 0);
    const ch = "ch" + (chN != null ? String(chN).padStart(3) : "  ?");
    const dbm = ap.signal ? String(ap.signal).padStart(4) + "dBm" : "  --   ";
    const bn = Math.round(s * barW);
    const gauge = sigColor(s) + "▰".repeat(bn) + fg(237) + "▱".repeat(barW - bn) + RESET;
    return fg(252) + name + RESET + " " + fg(123) + ch + RESET + " " + gauge + " " +
      bold + sigColor(s) + dbm + RESET;
  });
  while (lines.length < h) lines.push(" ".repeat(w));
  return lines;
}

/* ---- composition -------------------------------------------------- */
export function renderDashboard(C, R) {
  const rows = [];
  const lw = Math.floor((C - 2) / 2), rw = C - 2 - lw;

  const showFrames = R >= 34;
  const avail = Math.max(9, R - 15 - (showFrames ? FRAME_CATS.length + 2 : 0));
  const hFreq = Math.max(3, Math.round(avail * 0.40));
  const hRssi = Math.max(3, Math.round(avail * 0.32));
  const hHist = Math.max(3, avail - hFreq - hRssi);

  let band = FREQ_BANDS[0], bmax = -1;
  for (const b of FREQ_BANDS) {
    const c = [...aps.values()].filter((a) => a.signal && a.freq >= b.lo && a.freq <= b.hi).length;
    if (c > bmax) { bmax = c; band = b; }
  }
  let homeCh = "—", homeMax = 0;
  for (const [ch, c] of chans) { const t = c.rssiN || 0; if (t > homeMax) { homeMax = t; homeCh = ch; } }

  rows.push(topRule(C, "802.11 RF MONITOR"));
  const deauthStr = tot.deauth ? `${fg(C_ALERT)}${tot.deauth}${RESET}${fg(244)}` : "0";
  rows.push(`  ${fg(46)}●${fg(244)} LIVE ${fg(240)}${mmss(Date.now() - startTime)}${fg(244)}  ` +
    `${fg(252)}${totalFrames}${fg(244)} frm · ${fg(252)}${stations.size}${fg(244)} stn · ` +
    `${fg(252)}${aps.size}${fg(244)} APs · ${fg(51)}${tot.beacon}${fg(244)} bcn · ` +
    `deauth ${deauthStr} · ch ${fg(123)}${homeCh}${RESET}${EOL}`);
  rows.push(EOL);

  drawBand(rows, band, C, hFreq);
  rows.push(EOL);

  let heatLen = 0;
  for (const [, st] of topRssiStations()) heatLen = Math.max(heatLen, st.heat.length);
  const span = Math.max(1, Math.round((heatLen * TICK_MS) / 1000));
  rows.push(bandTitle(C, `RSSI × TIME  ·  per-station · last ${span}s · −30…−90 dBm`));
  const sm = panelSmallMultiples(C, hRssi);
  rows.push(sm.header + EOL);
  for (const line of sm.body) rows.push(line + EOL);
  rows.push(EOL);

  if (showFrames) {
    rows.push(bandTitle(C, "FRAME FEED · type × time · color = count/slice"));
    for (const line of panelFrames(C, FRAME_CATS.length)) rows.push(line + EOL);
    rows.push(EOL);
  }

  rows.push(sectionTitle(lw, "SIGNAL HISTOGRAM · frames vs dBm", `ACCESS POINTS · ${aps.size}`));
  zip(panelHistB(lw, hHist), panelAPs(rw, hHist), lw, rw, rows);
  rows.push(`${histAxis(lw)}${fg(238)}│${RESET}${EOL}`);
  rows.push(botRule(C));
  return rows;
}
