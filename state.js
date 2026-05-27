/* Application state + frame/scan ingest. Holds the live data the panels
 * read; `advance()` rolls the per-tick history buffers. */

import { strength } from "./render.js";

export const TICK_MS = 150; /* render cadence; also the time-axis sample spacing */
export const LIVE_MS = 4000; /* a station is "live" if seen within this window */
export const SIG_LO = -95, SIG_HI = -25, SIG_NB = 35; /* RSSI histogram range */

/* frame categories for the frame-type × time heatmap */
export const FRAME_CATS = [
  { name: "Beacon", test: (e) => e.ftype === 0 && e.fsubtype === 8 },
  { name: "Probe", test: (e) => e.ftype === 0 && (e.fsubtype === 4 || e.fsubtype === 5) },
  { name: "Auth", test: (e) => e.ftype === 0 && e.fsubtype === 11 },
  { name: "Assoc", test: (e) => e.ftype === 0 && e.fsubtype <= 3 },
  { name: "Deauth", test: (e) => e.ftype === 0 && (e.fsubtype === 12 || e.fsubtype === 10), alert: true },
  { name: "Data", test: (e) => e.ftype === 2 },
  { name: "Control", test: (e) => e.ftype === 1 },
  { name: "Other", test: () => true },
];

export const stations = new Map();    /* TA -> {dbm, ch, count, last, heat, b*} */
export const ssidByBssid = new Map();  /* BSSID -> SSID */
export const chans = new Map();         /* channel -> {band, rssiSum, rssiN} */
export const aps = new Map();           /* BSSID -> {ssid, freq, signal, last} (scans) */
export const sigBuckets = new Array(SIG_NB).fill(0);
export const catHeat = FRAME_CATS.map(() => []);
export const tot = { beacon: 0, deauth: 0, data: 0 }; /* cumulative tallies */
export const startTime = Date.now();
export let totalFrames = 0;

let tickCats = new Array(FRAME_CATS.length).fill(0);

export function macStr(addr) {
  return Object.values(addr ?? {})
    .map((b) => Number(b).toString(16).padStart(2, "0"))
    .join(":");
}

export function freqToChan(freq, band) {
  if (!freq) return null;
  if (band === 0 || (freq >= 2412 && freq <= 2484))
    return freq === 2484 ? 14 : Math.round((freq - 2407) / 5);
  if (band === 3 || freq >= 5955) return Math.round((freq - 5950) / 5);
  return Math.round((freq - 5000) / 5);
}

/* Screenshot-safe relabeling: with --anonymize, every SSID/MAC maps to a
 * stable generic name so nothing identifying ends up in a shared image. */
const anon = !!globalThis.yeet?.args?.anonymize;
const aliasMap = new Map();
export function alias(name) {
  if (!anon || !name || name === "‹hidden›") return name;
  let a = aliasMap.get(name);
  if (!a) {
    const kind = /^[0-9a-f]{2}:[0-9a-f]{2}:/i.test(name) ? "station-" : "network-";
    a = kind + String(aliasMap.size + 1).padStart(2, "0");
    aliasMap.set(name, a);
  }
  return a;
}

/* per-received-frame ingest (from ieee80211_rx_list) */
export function onFrame(e) {
  totalFrames++;
  if (e.ssid_len) ssidByBssid.set(macStr(e.addr3), e.ssid);

  if (e.ftype === 0 && e.fsubtype === 8) tot.beacon++;
  else if (e.ftype === 2) tot.data++;
  if (e.ftype === 0 && (e.fsubtype === 10 || e.fsubtype === 12)) tot.deauth++;

  if (e.signal) {
    const idx = Math.max(0, Math.min(SIG_NB - 1,
      Math.floor((e.signal - SIG_LO) / ((SIG_HI - SIG_LO) / SIG_NB))));
    sigBuckets[idx]++;
  }

  const ch = freqToChan(e.freq, e.band);
  if (ch != null) {
    let c = chans.get(ch);
    if (!c) { c = { band: e.band, rssiSum: 0, rssiN: 0 }; chans.set(ch, c); }
    if (e.signal) { c.rssiSum += e.signal; c.rssiN++; }
  }

  const key = macStr(e.addr2);
  let st = stations.get(key);
  if (!st) { st = { last: 0, count: 0, heat: [], bSum: 0, bN: 0, bRssiN: 0 }; stations.set(key, st); }
  st.count++;
  st.last = Date.now();
  st.dbm = e.signal;
  st.ch = ch;
  st.bN++;
  if (e.signal) { st.bSum += e.signal; st.bRssiN++; }

  for (let i = 0; i < FRAME_CATS.length; i++) {
    if (FRAME_CATS[i].test(e)) { tickCats[i]++; break; }
  }
}

/* scan-result ingest (from cfg80211_inform_bss_frame_data) */
export function onBss(e) {
  const bssid = macStr(e.bssid);
  if (e.ssid_len) ssidByBssid.set(bssid, e.ssid);
  aps.set(bssid, { ssid: e.ssid_len ? e.ssid : "", freq: e.freq, signal: e.signal, last: Date.now() });
}

/* top live stations (by frame count), newest activity within LIVE_MS */
export function topRssiStations() {
  const now = Date.now();
  return [...stations.entries()]
    .filter(([, st]) => now - st.last < LIVE_MS)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);
}

/* roll one time-slice into the history buffers; prune dead stations */
export function advance() {
  const now = Date.now();
  for (const [mac, st] of stations) {
    if (now - st.last > 60000) { stations.delete(mac); continue; }
    const v = st.bN === 0 ? -1 : st.bRssiN > 0 ? strength(st.bSum / st.bRssiN)
      : Math.min(1, 0.3 + st.bN / 12);
    st.heat.push(v); if (st.heat.length > 200) st.heat.shift();
    st.bN = 0; st.bSum = 0; st.bRssiN = 0;
  }
  for (let i = 0; i < FRAME_CATS.length; i++) {
    catHeat[i].push(tickCats[i]); if (catHeat[i].length > 240) catHeat[i].shift();
  }
  tickCats = new Array(FRAME_CATS.length).fill(0);
}
