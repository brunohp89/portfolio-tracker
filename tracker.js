/* The tracker itself. It starts once loader.js has a snapshot to give it. */
/* ------------------------------------------------------------------ time zone
   Top-level, so the tracker and the loader below share it (classic scripts share the global scope). */
/** Device time zone: on a phone it follows the location when the clock is set automatically. */
// Reading it builds an Intl formatter (~50 µs) and every bar's time conversion asks for it (TZ() is the
// default argument of tzOffset), so it is read at most once a second; tickClock still notices a change.
let deviceTzValue = '', deviceTzAt = 0;
const deviceTz = () => {
  const now = Date.now();
  if (!deviceTzValue || now - deviceTzAt >= 1000) {
    try { deviceTzValue = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { deviceTzValue = 'UTC'; }
    deviceTzAt = now;
  }
  return deviceTzValue;
};
function validTz(z) {
  if (!z || typeof z !== 'string') return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return ''; }
}
let tzChoice = (() => { try { return validTz(JSON.parse(localStorage.getItem('pt.tz') || '""')); } catch { return ''; } })(); // '' = automatic (device time zone)
/** Time zone that sets midnight (daily candles, the day's change) and every time shown. */
const TZ = () => tzChoice || deviceTz();
const tzFmt = new Map();
function tzParts(tSec, zone = TZ()) {
  let f = tzFmt.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    tzFmt.set(zone, f);
  }
  const o = {};
  for (const x of f.formatToParts(new Date(tSec * 1000))) o[x.type] = x.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
const tzOffCache = new Map();
/** Seconds to add to UTC to get the wall-clock time of the zone at instant t (cached per 15 minutes:
 * offsets only change on quarter hours). */
function tzOffset(t, zone = TZ()) {
  const key = zone + '|' + Math.floor(t / 900);
  let off = tzOffCache.get(key);
  if (off == null) {
    const x = tzParts(t, zone);
    off = Date.UTC(x.y, x.mo - 1, x.d, x.h, x.mi, x.s) / 1000 - Math.floor(t);
    if (tzOffCache.size > 50000) tzOffCache.clear();
    tzOffCache.set(key, off);
  }
  return off;
}
/** Midnight of the wall date y-mo-d in the zone, as a UTC timestamp. */
function tzMidnight(y, mo, d, zone = TZ()) {
  const wall = Date.UTC(y, mo - 1, d) / 1000;
  const t = wall - tzOffset(wall, zone);
  const off2 = tzOffset(t, zone); // the offset at midnight itself (DST may differ from the guess)
  return wall - off2;
}
/** Short name of the zone right now, e.g. EST or GMT+1. */
const tzAbbr = (zone = TZ()) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName').value; }
  catch { return zone; }
};

window.startTracker = function (BOOT) {
/* Private names come from the Worker (/labels, kept in its KV) so this public code holds placeholders
   only: BROKER is the brokerage's display name and the `account` value of its positions in the
   snapshot, BK the snapshot's field name for its series and flows (h[BK], h['flow_' + BK], f[BK]). */
const LABELS = Object.assign({ broker: 'Broker', brokerKey: 'broker' }, BOOT.labels || {});
const BROKER = LABELS.broker, BK = LABELS.brokerKey;
for (const el of document.querySelectorAll('[data-label]')) el.textContent = LABELS[el.dataset.label] || el.textContent;
for (const el of document.querySelectorAll('[data-label-title]')) el.title = el.dataset.labelTitle.replaceAll('{broker}', BROKER);
'use strict';
const LWC = window.LightweightCharts;
const $ = (id) => document.getElementById(id);
/*
 * Writes that skip the DOM when nothing changed. The KPIs are redrawn on every price tick (up to four
 * times a second) and most of their markup is the same each time; an identical write still makes the
 * browser parse, restyle and lay out again. setHtml also checks that the node it wrote is still there,
 * so a direct write elsewhere (textContent, innerHTML) is never mistaken for "unchanged".
 */
const htmlWritten = new WeakMap();
function setHtml(el, html) {
  const w = htmlWritten.get(el);
  if (w && w.html === html && w.first === el.firstChild && w.last === el.lastChild) return;
  el.innerHTML = html;
  htmlWritten.set(el, { html, first: el.firstChild, last: el.lastChild });
}
function setText(el, text) {
  const n = el.firstChild;
  const same = text === '' ? !n : n && n === el.lastChild && n.nodeType === 3 && n.data === text;
  if (!same) el.textContent = text;
}
function setTitle(el, title) { if (el.title !== title) el.title = title; }

/* ------------------------------------------------------------------ storage */
const store = {
  get(key, dflt) { try { const v = localStorage.getItem('pt.' + key); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } },
  set(key, val) { try { localStorage.setItem('pt.' + key, JSON.stringify(val)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem('pt.' + key); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------------ config */
/*
 * The chart always holds the whole history the interval allows (daily and weekly: everything; hourly:
 * INTRADAY_DAYS), and a period only zooms into it, so indicators and the bars before the window are
 * the same whatever the period. Intervals under one hour are not offered.
 */
const INTERVALS = {
  '1h':  { sec: 3600,   base: '1h',  ranges: ['1M', '3M', '6M', '1Y'],       def: '3M', intraday: true },
  '4h':  { sec: 14400,  base: '1h',  ranges: ['3M', '6M', '1Y'],             def: '6M', intraday: true },
  '1D':  { sec: 86400,  base: '1d',  ranges: ['3M', '6M', '1Y', '2Y', '5Y', 'MAX'], def: '3M', intraday: false },
  '1W':  { sec: 604800, base: '1d',  ranges: ['1Y', '2Y', '5Y', 'MAX'],      def: '5Y', intraday: false },
};
const INTERVAL_LABEL = { '1h': '1h', '4h': '4h', '1D': '1G', '1W': '1S' };
/** History loaded for hourly and 4-hour candles (Yahoo keeps hourly bars for about two years). */
const INTRADAY_DAYS = 366;
const RANGE_LABEL = { '1D': '1G', '3D': '3G', '5D': '5G', '1M': '1M', '2M': '2M', '3M': '3M', '6M': '6M', '1Y': '1A', '2Y': '2A', '5Y': '5A', 'MAX': 'Max', 'LASTC': 'Dall\'ultimo versamento' };
// Trading days for short ranges, calendar days for the rest. 2M stays inside Yahoo's 60-day intraday limit.
const RANGE_DAYS = { '1D': 1, '3D': 3, '5D': 5, '1M': 30, '2M': 58, '3M': 92, '6M': 183, '1Y': 366, '2Y': 731, '5Y': 1827, 'MAX': null };
const BASES = {
  '1m':  { sec: 60,    yf: '1m',  cb: 60 },
  '5m':  { sec: 300,   yf: '5m',  cb: 300 },
  '15m': { sec: 900,   yf: '15m', cb: 900 },
  '1h':  { sec: 3600,  yf: '60m', cb: 3600 },
  '1d':  { sec: 86400, yf: '1d',  cb: 86400 },
};
const MAX_START = Date.UTC(2015, 0, 1) / 1000;
// Default Yahoo proxy, delivered with the snapshot. Settings can override it; an empty field falls back to this.
const DEFAULT_PROXY = (BOOT.snapshot.config && BOOT.snapshot.config.proxy) || '';
// Default Finnhub key, delivered with the snapshot. Settings can override it; "off" disables Finnhub.
const DEFAULT_FINNHUB = (BOOT.snapshot.config && BOOT.snapshot.config.finnhub) || '';
function finnhubKey() {
  const v = (state.settings.finnhub || '').trim();
  if (v.toLowerCase() === 'off') return '';
  return v || DEFAULT_FINNHUB;
}
const SCOPE_LABEL = { all: 'Valore portafoglio', broker: 'Valore ' + BROKER, crypto: 'Valore crypto', custom: 'Valore selezione' };

/* ------------------------------------------------------------------ state */
let embedded = BOOT.snapshot; // latest snapshot from Drive, replaced by applyRemote()
/*
 * Saved view preferences from before the current defaults: start once from the new defaults
 * (daily candles over the last 3 months), then keep whatever is chosen afterwards.
 */
const DEFAULTS_VERSION = 2;
if (store.get('defaultsVersion', 1) < DEFAULTS_VERSION) {
  store.set('interval', '1D'); store.set('range', '3M'); store.set('chartType', 'candle');
  store.set('defaultsVersion', DEFAULTS_VERSION);
}
const state = {
  snap: pickSnapshot(),
  settings: Object.assign({ proxy: '', token: '', finnhub: '', pollSec: 30 }, store.get('settings', {})),
  // An unknown stored view (e.g. a key renamed since) falls back to the whole portfolio.
  scope: ((v) => ['all', 'broker', 'crypto', 'custom'].includes(v) ? v : 'all')(store.get('scope', 'all')),
  custom: new Set(store.get('custom', [])),
  interval: store.get('interval', '1D'),
  range: store.get('range', null),
  chartType: store.get('chartType', 'candle'),
  scaleMode: store.get('scaleMode', 0),
  includeStatic: store.get('includeStatic', true),
  valueMode: store.get('valueMode', 'positions'), // 'positions' | 'real'
  showContrib: store.get('showContrib', true),
  showFlows: store.get('showFlows', true),
  showTrades: store.get('showTrades', true),
  showReal: store.get('showReal', true),
  live: {},            // symbol -> { price, prev, t, src }
  barCache: new Map(), // cache key -> { at, bars, meta }
  agg: [],             // aggregated bars of the current view, UTC seconds
  chartTimes: [],      // chart time of each aggregated bar (local-time shifted, strictly increasing)
  aggMeta: null,       // { syms, staticValue, startValue }
  buildSeq: 0,
  sortKey: 'dayPct', sortDir: -1, // best day first
  status: { crypto: 'off', stocks: 'off' },
};
if (!INTERVALS[state.interval]) state.interval = '1h';
/** Periods offered for an interval: "since the last contribution" with daily and weekly candles. */
function rangesFor(ivKey) {
  const base = INTERVALS[ivKey].ranges;
  return INTERVALS[ivKey].intraday ? base : base.concat(['LASTC']);
}
if (!state.range || !rangesFor(state.interval).includes(state.range)) state.range = INTERVALS[state.interval].def;

function pickSnapshot() {
  const saved = store.get('snapshot', null);
  if (saved && saved.positions && saved.asof >= embedded.asof) return saved;
  return embedded;
}
const positions = () => state.snap.positions;
const bySym = (s) => positions().find((p) => p.symbol === s);
const isMarketPos = (p) => p.kind !== 'static';

/* ------------------------------------------------------------------ formatting */
const fmtUsd = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSigned = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + fmtUsd(v, d);
const fmtPct = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
const fmtPrice = (v) => {
  if (v == null || !isFinite(v)) return '—';
  const d = v >= 1000 ? 2 : v >= 1 ? 2 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtQty = (v) => {
  // Always a number: a string quantity (snapshot, imported file) would otherwise reach the HTML as is.
  const n = v == null || v === '' ? NaN : Number(v);
  if (!isFinite(n)) return '—';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 8 });
};
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
/**
 * Text for HTML templates. Symbols, names, dates and messages come from the snapshot, the Worker, Yahoo
 * or an imported file: they are data and must never become markup or script (XSS).
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ time helpers */
const nowSec = () => Math.floor(Date.now() / 1000);
const nyParts = (tSec) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(tSec * 1000))) o[p.type] = p.value;
  return { wd: o.weekday, h: +o.hour, m: +o.minute, date: `${o.year}-${o.month}-${o.day}` };
};
/** UTC offset of New York at a given instant, in seconds (negative). */
function nyOffset(tSec) {
  const p = nyParts(tSec);
  const [y, mo, d] = p.date.split('-').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, p.h, p.m) / 1000;
  return asUtc - Math.floor(tSec / 60) * 60;
}
/** Timestamp of 16:00 New York time on a given UTC date (used to place fund NAVs at the close). */
function nyCloseTs(dayStartUtc) {
  const guess = dayStartUtc + 21 * 3600;
  return dayStartUtc + 16 * 3600 - nyOffset(guess);
}
/* ------------------------------------------------------------------ NYSE calendar */
/**
 * NYSE full-day holidays and 1:00 p.m. early closes, derived from the exchange's rules so the
 * calendar never expires. Checked against the published NYSE calendar for 2026-2028.
 */
const nyseCache = {};
function nyseCalendar(y) {
  if (nyseCache[y]) return nyseCache[y];
  const iso = (m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const wd = (m, d) => new Date(Date.UTC(y, m, d)).getUTCDay();
  const nth = (m, w, n) => { const first = wd(m, 1); return 1 + ((w - first + 7) % 7) + 7 * (n - 1); };
  const last = (m, w) => { const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return dim - ((wd(m, dim) - w + 7) % 7); };
  const observed = (m, d) => { const w = wd(m, d); return w === 6 ? [m, d - 1] : w === 0 ? [m, d + 1] : [m, d]; };
  // Easter Sunday (anonymous Gregorian algorithm), Good Friday two days earlier.
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const em = Math.floor((h + l - 7 * mm + 114) / 31) - 1, ed = ((h + l - 7 * mm + 114) % 31) + 1;
  const gf = new Date(Date.UTC(y, em, ed - 2));
  const hol = new Map();
  if (wd(0, 1) !== 6) { const [m, d] = observed(0, 1); hol.set(iso(m, d), 'Capodanno'); } // no Dec 31 make-up
  hol.set(iso(0, nth(0, 1, 3)), 'Martin Luther King Jr. Day');
  hol.set(iso(1, nth(1, 1, 3)), "Presidents' Day");
  hol.set(gf.toISOString().slice(0, 10), 'Venerdì Santo');
  hol.set(iso(4, last(4, 1)), 'Memorial Day');
  { const [m, d] = observed(5, 19); hol.set(iso(m, d), 'Juneteenth'); }
  { const [m, d] = observed(6, 4); hol.set(iso(m, d), 'Independence Day'); }
  hol.set(iso(8, nth(8, 1, 1)), 'Labor Day');
  const tg = nth(10, 4, 4);
  hol.set(iso(10, tg), 'Thanksgiving');
  { const [m, d] = observed(11, 25); hol.set(iso(m, d), 'Natale'); }
  const early = new Map();
  early.set(iso(10, tg + 1), 'giorno dopo Thanksgiving');
  const isTradingDay = (m, d) => { const w = wd(m, d); return w !== 0 && w !== 6 && !hol.has(iso(m, d)); };
  if (isTradingDay(11, 24)) early.set(iso(11, 24), 'vigilia di Natale');
  if (wd(6, 3) >= 1 && wd(6, 3) <= 4 && isTradingDay(6, 3)) early.set(iso(6, 3), 'vigilia di Independence Day');
  return (nyseCache[y] = { hol, early });
}
/** Status of the market a position trades on. kind: crypto | equity | fund | static */
function marketStatus(kind, tSec = nowSec()) {
  if (kind === 'crypto') return { open: true, label: 'Crypto: mercato aperto 24 ore su 24' };
  if (kind === 'static') return { open: null, label: 'Non quotato (CD e liquidità)' };
  const p = nyParts(tSec);
  const cal = nyseCalendar(+p.date.slice(0, 4));
  const fund = kind === 'fund' ? ' · fondo comune: NAV calcolato alla chiusura' : '';
  if (p.wd === 'Sat' || p.wd === 'Sun') return { open: false, label: 'NYSE chiusa (weekend)' + fund };
  if (cal.hol.has(p.date)) return { open: false, label: `NYSE chiusa (${cal.hol.get(p.date)})` + fund };
  const mins = p.h * 60 + p.m;
  const close = cal.early.has(p.date) ? 13 * 60 : 16 * 60;
  const closeLbl = close === 13 * 60 ? `13:00 ET, chiusura anticipata: ${cal.early.get(p.date)}` : '16:00 ET';
  if (mins >= 9 * 60 + 30 && mins < close) return { open: true, label: `NYSE aperta, chiude alle ${closeLbl}` + fund };
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return { open: false, label: 'NYSE chiusa (pre-market, apre alle 9:30 ET)' + fund };
  const postEnd = close === 13 * 60 ? 17 * 60 : 20 * 60; // on early-close days the late session ends at 17:00
  if (mins >= close && mins < postEnd) return { open: false, label: `NYSE chiusa (after-hours fino alle ${postEnd / 60}:00 ET)` + fund };
  return { open: false, label: 'NYSE chiusa' + fund };
}

/** UTC timestamp of a New York wall-clock time on a New York date (YYYY-MM-DD). */
function nyWallTs(date, h, m) {
  const [y, mo, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m) / 1000;
  return wall - nyOffset(wall - nyOffset(wall));
}
/** Seconds until the regular session closes (open) or next opens (closed), holidays and early closes included. */
function nyseCountdown(tSec = nowSec()) {
  const p = nyParts(tSec);
  if (marketStatus('equity', tSec).open) {
    const close = nyseCalendar(+p.date.slice(0, 4)).early.has(p.date) ? 13 : 16;
    return { open: true, sec: nyWallTs(p.date, close, 0) - tSec };
  }
  const [y, mo, d] = p.date.split('-').map(Number);
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(y, mo - 1, d + i));
    const iso = day.toISOString().slice(0, 10);
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6 || nyseCalendar(day.getUTCFullYear()).hol.has(iso)) continue;
    const open = nyWallTs(iso, 9, 30);
    if (open > tSec) return { open: false, sec: open - tSec };
  }
  return null;
}
/** 45m, 3h 05m, 2g 4h */
function fmtCountdown(sec) {
  const m = Math.max(1, Math.ceil(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}g ${h % 24}h`;
}

function isUsMarketWindow(tSec = nowSec()) {
  const p = nyParts(tSec);
  if (p.wd === 'Sat' || p.wd === 'Sun') return false;
  const mins = p.h * 60 + p.m;
  return mins >= 4 * 60 && mins <= 20 * 60; // pre-market to after-hours
}
/**
 * First day after the last step in cumulative net contributions (the brief's history),
 * so the real value from there on moves only with the market. Falls back to the full history.
 */
function lastContribStart() {
  const h = state.snap.history;
  if (!h || !h.contrib || !h.dates) return MAX_START;
  for (let i = h.contrib.length - 1; i > 0; i--) {
    const a = h.contrib[i], b = h.contrib[i - 1];
    if (a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) >= 1) {
      return localDayTs(h.dates[i]) + 86400;
    }
  }
  return MAX_START;
}
function rangeStart(range, iv, cryptoOnly) {
  if (range === 'LASTC') return lastContribStart();
  const days = RANGE_DAYS[range];
  if (days == null) return MAX_START;
  const now = nowSec();
  if (iv.intraday && days <= 5 && !cryptoOnly) {
    // Count back trading days so that "1G" on a Monday still shows a full session.
    let t = now, left = days;
    while (left > 0) {
      t -= 86400;
      const wd = nyParts(t).wd;
      if (wd !== 'Sat' && wd !== 'Sun') left--;
    }
    return t;
  }
  return now - days * 86400;
}
/** Seconds to add to UTC to get wall-clock time at instant t, in the selected time zone. */
const localOffset = (t) => tzOffset(t);
/**
 * Start of the bar containing t. Bars of 4 hours or more follow local wall-clock time, so a
 * daily candle runs from local midnight to midnight and a weekly one starts on Monday.
 */
function bucketStart(t, sec) {
  if (sec < 14400) return Math.floor(t / sec) * sec;
  const off = localOffset(t);
  const loc = t + off;
  const mon = 4 * 86400; // 1970-01-05 was a Monday
  const b = sec === 604800 ? Math.floor((loc - mon) / sec) * sec + mon : Math.floor(loc / sec) * sec;
  const start = b - off;
  const off2 = localOffset(start); // DST may change between the bar start and t
  return off2 === off ? start : b - off2;
}
/** Midnight in the selected time zone (as a UTC timestamp) of a YYYY-MM-DD date. */
const localDayTs = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return tzMidnight(y, m, d); };
const localMidnight = (t = nowSec()) => { const x = tzParts(t); return tzMidnight(x.y, x.mo, x.d); };
/**
 * Lightweight Charts renders times as UTC: shift every bar to the wall-clock time of the selected
 * zone, so intraday axes show that zone's hours and a daily candle (starting at its midnight) shows
 * its own date whatever side of UTC the zone is on.
 */
function toChartTime(t) {
  return t + localOffset(t);
}

/* ------------------------------------------------------------------ network */
class HttpError extends Error { constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; } }
let signalSupported = true;
async function fetchJson(url, timeoutMs = 15000) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
  const run = async (useSignal) => {
    const ctl = useSignal ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const r = await Promise.race([fetch(url, ctl ? { signal: ctl.signal } : {}), timeout]);
      if (!r.ok) throw new HttpError(r.status, url);
      return await r.json();
    } finally { if (timer) clearTimeout(timer); }
  };
  if (!signalSupported) return run(false);
  try { return await run(true); }
  catch (e) {
    // Some embedded previews wrap fetch with postMessage and cannot clone an AbortSignal.
    if (/clone|postMessage/i.test(String(e && e.message))) { signalSupported = false; return run(false); }
    throw e;
  }
}
/** Accept "name.workers.dev", "https://name.workers.dev/" and similar. */
function normalizeProxy(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function proxyUrl(path, baseOverride) {
  const base = normalizeProxy(baseOverride || state.settings.proxy || DEFAULT_PROXY);
  if (!base) return null;
  const sep = path.includes('?') ? '&' : '?';
  return base + path + (state.settings.token ? `${sep}token=${encodeURIComponent(state.settings.token)}` : '');
}
/** Tiny concurrency limiter so a 30-symbol view does not fire 30 requests at once. */
function limiter(n) {
  let active = 0; const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, res, rej } = q.shift(); fn().then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const yfLimit = limiter(4);
const cbLimit = limiter(1);

const yahooSymbol = (p) => p.kind === 'crypto' ? `${p.symbol}-USD` : p.symbol.replace('.', '-');

async function yahooChart(ysym, yfInterval, start, end, range) {
  const span = range ? `range=${range}` : `period1=${start}&period2=${end}`;
  const url = proxyUrl(`/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${yfInterval}&${span}&includePrePost=false`);
  if (!url) throw new Error('no-proxy');
  const j = await yfLimit(() => fetchJson(url));
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'risposta Yahoo vuota');
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (c == null || !isFinite(c)) continue;
    const o = q.open && q.open[i] != null ? q.open[i] : c;
    const h = q.high && q.high[i] != null ? q.high[i] : Math.max(o, c);
    const l = q.low && q.low[i] != null ? q.low[i] : Math.min(o, c);
    bars.push({ t: ts[i], o, h, l, c });
  }
  const m = res.meta || {};
  return { bars, meta: { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose, t: m.regularMarketTime } };
}

async function coinbaseCandles(product, gran, start, end) {
  const out = [];
  let e = end;
  while (e > start) {
    const s = Math.max(start, e - gran * 300);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}` +
      `&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
    const rows = await cbLimit(async () => { const r = await fetchJson(url); await sleep(340); return r; });
    if (!Array.isArray(rows)) throw new Error('risposta Coinbase non valida');
    for (const k of rows) out.push({ t: k[0], o: k[3], h: k[2], l: k[1], c: k[4] });
    if (!rows.length && out.length) break; // before the listing date
    e = s;
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((b, i) => i === 0 || b.t !== out[i - 1].t);
}

/**
 * Whole history for daily and weekly candles: daily bars up to a year ago, then hourly bars, so the
 * last year's candles split at local midnight (crypto included) as before, and the earlier ones come
 * from daily bars. Funds only have daily NAVs. hourly: whether the recent part is hourly (day refs).
 */
async function getDailyHistory(p, start, end) {
  if (p.kind === 'fund') return { ...(await getBars(p, '1d', start, end)), hourly: false };
  const cut = bucketStart(end - INTRADAY_DAYS * 86400, 86400) + 86400; // first whole local day of the hourly part
  const [d, h] = await Promise.allSettled([getBars(p, '1d', start, end), getBars(p, '1h', cut - 86400, end)]);
  if (h.status !== 'fulfilled' || !h.value.bars.length) {
    if (d.status !== 'fulfilled') throw d.reason;
    return { ...d.value, hourly: false };
  }
  const older = d.status === 'fulfilled' ? d.value.bars.filter((b) => bucketStart(b.t, 86400) < cut) : [];
  return { bars: older.concat(h.value.bars.filter((b) => b.t >= cut)), meta: h.value.meta, src: h.value.src, hourly: true };
}
/** Bars for one position at a base resolution, with source fallbacks and a short cache. */
async function getBars(p, baseKey, start, end) {
  const base = BASES[p.kind === 'fund' ? '1d' : baseKey];
  const fetchStart = p.kind === 'fund' ? start - 10 * 86400 : start; // seed the first NAV
  const key = `${p.symbol}|${base.yf}|${Math.floor(fetchStart / 600)}`;
  const hit = state.barCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

  let data;
  if (p.kind === 'crypto') {
    // Coinbase returns 300 candles per request: for long windows Yahoo (one request) is faster.
    const cbRequests = Math.ceil((end - fetchStart) / (base.cb * 300));
    const viaCoinbase = async () => ({ bars: await coinbaseCandles(`${p.symbol}-USD`, base.cb, fetchStart, end), meta: {}, src: 'Coinbase' });
    const viaYahoo = async () => ({ ...(await yahooChart(yahooSymbol(p), base.yf, fetchStart, end)), src: 'Yahoo' });
    if (proxyUrl('/') && cbRequests > 6) {
      try { data = await viaYahoo(); } catch { data = await viaCoinbase(); }
    } else {
      try { data = await viaCoinbase(); } catch (err) { if (!proxyUrl('/')) throw err; data = await viaYahoo(); }
    }
  } else {
    data = { ...(await yahooChart(yahooSymbol(p), base.yf, fetchStart, end)), src: 'Yahoo' };
    if (p.kind === 'fund') {
      // A NAV is only known after the close: place it at 16:00 New York time.
      data.bars = data.bars.map((b) => ({ ...b, t: nyCloseTs(Math.floor(b.t / 86400) * 86400) }));
    }
  }
  if (p.kind === 'crypto' && base.sec === 86400) data = { ...data, bars: data.bars.map((b) => ({ ...b, t: b.t + 12 * 3600 })) };
  state.barCache.set(key, { at: Date.now(), data });
  noteBars(p.symbol, data.bars);
  return data;
}

/* ------------------------------------------------------------------ live prices */
function liveTick(sym, price, tSec, src, prev) {
  if (!isFinite(price) || price <= 0) return;
  const cur = state.live[sym] || {};
  const dir = cur.price != null ? Math.sign(price - cur.price) : 0;
  state.live[sym] = { price, t: tSec || nowSec(), src, prev: prev ?? cur.prev, dir };
  dirty.table.add(sym);
  if (inScope(sym)) dirty.chart = true;
  scheduleFlush();
}
/** Newest known price: live tick or last fetched bar, whichever is more recent; else the snapshot. */
const barLast = {}; // symbol -> { t, c } of the newest fetched bar
function noteBars(sym, bars) {
  const b = bars[bars.length - 1];
  if (!b) return;
  const t = Math.min(b.t, nowSec()); // daily crypto bars are stamped at noon UTC, possibly ahead of now
  if (!barLast[sym] || t >= barLast[sym].t) barLast[sym] = { t, c: b.c };
}
function priceOf(p) {
  const lv = state.live[p.symbol], bl = barLast[p.symbol];
  if (lv && (!bl || lv.t >= bl.t)) return lv.price;
  if (bl) return bl.c;
  return p.price;
}
/*
 * Reference price for the day change: the price at local midnight, the same point where the
 * daily candle opens. Crypto: the last trade before midnight (Coinbase 1-minute candle, or the
 * live price when midnight passes with the page open). Stocks and funds: the last regular close
 * before midnight, from Yahoo's quote. Until a reference is known, the brief's previous close.
 */
const dayRef = { day: null, prices: {}, fromBars: {} };
/** A rollover seen within this many seconds of midnight means the page was running at midnight. */
const ROLLOVER_LIVE_SEC = 120;
function ensureDay() {
  const m = localMidnight();
  if (dayRef.day === m) return m;
  const rolled = dayRef.day != null;
  dayRef.day = m;
  dayRef.prices = {}; dayRef.fromBars = {};
  if (rolled && nowSec() - m < ROLLOVER_LIVE_SEC) {
    // Page running at the stroke of midnight: the current price is the price at midnight.
    for (const p of positions()) if (isMarketPos(p)) { dayRef.prices[p.symbol] = priceOf(p); dayRef.fromBars[p.symbol] = true; }
  } else if (rolled) {
    // Midnight noticed late (device asleep, tab frozen) or a new time zone: the current price is not the
    // price at midnight, so read the references from the bars, as on first load.
    setTimeout(loadDayRefs, 0);
  }
  // On first load the references arrive from Coinbase and Yahoo (loadDayRefs at boot).
  return m;
}
function setDayRef(sym, price, fromBars) {
  if (!isFinite(price) || price <= 0) return;
  if (!fromBars && dayRef.fromBars[sym]) return; // bar-based references win over quote metadata
  dayRef.prices[sym] = price;
  if (fromBars) dayRef.fromBars[sym] = true;
}
/** Set references from the bars of a series that covers midnight: last close before it. */
function refsFromSeries(series, m) {
  for (const s of series) {
    let ref = null;
    for (const b of s.bars) { if (b.t < m) ref = b.c; else break; }
    if (ref != null) setDayRef(s.p.symbol, ref, true);
  }
}
async function loadDayRefs() {
  const m = ensureDay();
  const list = positions().filter(isMarketPos);
  const res = await Promise.allSettled(list.map((p) => getBars(p, '1h', m - 5 * 86400, nowSec())));
  if (dayRef.day !== m) return;
  refsFromSeries(list.map((p, i) => ({ p, bars: res[i].status === 'fulfilled' ? res[i].value.bars : [] })), m);
  dirty.table.add('*'); scheduleFlush();
}
const prevOf = (p) => dayRef.prices[p.symbol] ?? p.prev;

/* Coinbase Exchange public WebSocket: ticker channel for the crypto positions. */
let cbWs = null, cbRetry = 0;
function connectCoinbase() {
  const products = positions().filter((p) => p.kind === 'crypto').map((p) => `${p.symbol}-USD`);
  if (!products.length) { setStatus('crypto', 'off', 'nessuna crypto'); return; }
  try { if (cbWs) cbWs.close(); } catch { /* ignore */ }
  setStatus('crypto', 'warn', 'connessione…');
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  cbWs = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'subscribe', product_ids: products, channels: ['ticker'] })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'subscriptions') { cbRetry = 0; setStatus('crypto', 'ok', 'live (Coinbase)'); }
    if (m.type === 'ticker' && m.product_id) {
      const sym = m.product_id.split('-')[0];
      const t = m.time ? Math.floor(Date.parse(m.time) / 1000) : nowSec();
      liveTick(sym, +m.price, t, 'live');
    }
    if (m.type === 'error') setStatus('crypto', 'err', m.message || 'errore');
  };
  ws.onclose = () => {
    if (cbWs !== ws) return;
    setStatus('crypto', 'err', 'riconnessione…');
    const delay = Math.min(30000, 1000 * 2 ** cbRetry++);
    setTimeout(connectCoinbase, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

/* Finnhub WebSocket (optional): real-time trades for stocks and ETFs. */
let fhWs = null, fhRetry = 0, fhStatus = 'off';
function connectFinnhub() {
  try { if (fhWs) { const old = fhWs; fhWs = null; old.close(); } } catch { /* ignore */ }
  const key = finnhubKey();
  if (!key) { fhStatus = 'off'; refreshStocksPill(); return; }
  const syms = positions().filter((p) => p.kind === 'equity').map((p) => p.symbol);
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(key)}`);
  fhWs = ws;
  ws.onopen = () => { fhRetry = 0; fhStatus = 'ok'; refreshStocksPill(); for (const s of syms) ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'trade' && Array.isArray(m.data)) {
      const lastBySym = {};
      for (const tr of m.data) lastBySym[tr.s] = tr;
      for (const s in lastBySym) liveTick(s, +lastBySym[s].p, Math.floor(lastBySym[s].t / 1000), 'live');
    }
    if (m.type === 'error') { fhStatus = 'err'; refreshStocksPill(m.msg); }
  };
  ws.onclose = () => {
    if (fhWs !== ws) return;
    fhStatus = 'err'; refreshStocksPill();
    setTimeout(connectFinnhub, Math.min(60000, 2000 * 2 ** fhRetry++));
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

/* Yahoo polling through the proxy for stocks, ETFs and fund NAVs. */
let pollTimer = null, yahooStatus = 'off', yahooErr = '';
/** Live prices of the benchmark's tickers (not positions, so kept apart from state.live). */
const benchLive = {};
async function pollBenchmark() {
  const b = state.snap.benchmark;
  if (!b || !b.weights || !proxyUrl('/')) return;
  const syms = Object.keys(b.weights);
  let got = null;
  try { got = await sparkQuotes(syms); } catch { got = {}; }
  for (const s of syms) {
    let q = got[s];
    if (!q) { try { q = (await yahooChart(s, '5m', 0, 0, '1d')).meta; } catch { q = null; } }
    if (q && isFinite(q.price) && q.price > 0) benchLive[s] = { price: q.price, t: q.t };
  }
  renderBench();
}
async function pollYahoo() {
  clearTimeout(pollTimer);
  pollBenchmark();
  const syms = positions().filter((p) => p.kind === 'equity' || p.kind === 'fund');
  if (!proxyUrl('/') || !syms.length) { yahooStatus = 'off'; refreshStocksPill(); return; }
  const open = isUsMarketWindow();
  let ok = 0, fail = 0;
  // Spark batches many symbols per request; fall back to one chart call per symbol.
  for (let i = 0; i < syms.length; i += 20) {
    const batch = syms.slice(i, i + 20);
    let got = null;
    try { got = await sparkQuotes(batch.map(yahooSymbol)); } catch { got = null; }
    for (const p of batch) {
      let q = got && got[yahooSymbol(p)];
      if (!q) {
        try { const r = await yahooChart(yahooSymbol(p), '5m', 0, 0, '1d'); q = r.meta; } catch (e) { yahooErr = e.message; }
      }
      if (q && isFinite(q.price)) {
        ok++;
        const m = ensureDay();
        // No regular trade since midnight: the last price is the reference; otherwise the previous close is.
        setDayRef(p.symbol, q.t != null && q.t < m ? q.price : q.prev, false);
        liveTick(p.symbol, q.price, q.t, state.live[p.symbol]?.src === 'live' ? 'live' : 'poll');
      }
      else fail++;
    }
  }
  yahooStatus = ok && !fail ? 'ok' : ok ? 'warn' : 'err';
  if (ok) yahooErr = fail ? `${fail} simboli senza prezzo` : '';
  refreshStocksPill();
  const sec = open ? Math.max(10, +state.settings.pollSec || 30) : 600;
  // Runs can overlap (foreground, settings, new snapshot): keep a single pending timer, or the loops multiply.
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollYahoo, sec * 1000);
}
async function sparkQuotes(ysyms) {
  const url = proxyUrl(`/v8/finance/spark?symbols=${ysyms.map(encodeURIComponent).join(',')}&range=1d&interval=5m`);
  const j = await yfLimit(() => fetchJson(url));
  const out = {};
  const results = j && j.spark && j.spark.result;
  if (Array.isArray(results)) {
    for (const r of results) {
      const resp = r.response && r.response[0];
      const m = resp && resp.meta;
      if (m && isFinite(m.regularMarketPrice)) out[r.symbol] = { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose, t: m.regularMarketTime };
    }
  } else if (j && typeof j === 'object') {
    for (const s of Object.keys(j)) {
      const r = j[s];
      const closes = (r && r.close) || [];
      const last = closes.filter((x) => x != null).pop();
      if (last != null) out[s] = { price: last, prev: r.chartPreviousClose ?? r.previousClose, t: r.timestamp ? r.timestamp[r.timestamp.length - 1] : undefined };
    }
  }
  if (!Object.keys(out).length) throw new Error('spark vuoto');
  return out;
}

function setStatus(which, level, text) {
  state.status[which] = level;
  const pill = $(which === 'crypto' ? 'pill-crypto' : 'pill-stocks');
  pill.querySelector('.dot').className = 'dot ' + (level === 'off' ? '' : level);
  pill.title = text || '';
  pill.lastChild.textContent = (which === 'crypto' ? 'Crypto' : 'Azioni/fondi') + (text ? ': ' + text : '');
}
function refreshStocksPill(extra) {
  const parts = [];
  if (fhStatus === 'ok') parts.push('Finnhub live');
  else if (fhStatus === 'err') parts.push('Finnhub errore');
  if (yahooStatus === 'ok') parts.push('Yahoo');
  else if (yahooStatus === 'warn') parts.push('Yahoo parziale');
  else if (yahooStatus === 'err') parts.push('Yahoo errore');
  const level = fhStatus === 'ok' || yahooStatus === 'ok' ? 'ok' : (yahooStatus === 'warn' ? 'warn' : (yahooStatus === 'err' || fhStatus === 'err') ? 'err' : 'off');
  setStatus('stocks', level, parts.length ? parts.join(' + ') : 'prezzi dello snapshot');
  if (extra || yahooErr) $('pill-stocks').title = [extra, yahooErr].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ scope */
function scopePositions() {
  const all = positions();
  switch (state.scope) {
    case 'broker': return all.filter((p) => p.account === BROKER);
    case 'crypto': return all.filter((p) => p.kind === 'crypto');
    case 'custom': return all.filter((p) => state.custom.has(p.symbol));
    default: return all;
  }
}
function inScope(sym) { return scopePositions().some((p) => p.symbol === sym); }
const inScopeNow = (p) => (state.scope !== 'custom' || state.custom.has(p.symbol)) && (isMarketPos(p) || staticIncluded());
const staticIncluded = () => state.includeStatic && state.scope !== 'crypto';

/* ------------------------------------------------------------------ aggregation */
/**
 * Sum per-symbol bars (current quantities) on the union of their timestamps,
 * forward-filling each symbol between its own bars, then resample to the view interval.
 * series: [{ q, bars: [{t,o,h,l,c}] }]; constant: value added to every bar.
 */
function aggregate(series, constant, start, ivSec) {
  const times = new Set();
  for (const s of series) for (const b of s.bars) if (b.t >= start) times.add(b.t);
  const ts = [...times].sort((a, b) => a - b);
  if (!ts.length) return [];
  const ptr = series.map(() => 0);
  const lastClose = series.map((s) => {
    // Seed with the last close before the window, or backfill with the first open.
    let seed = null;
    for (const b of s.bars) { if (b.t < start) seed = b.c; else break; }
    return seed != null ? seed : (s.bars.length ? s.bars[0].o : 0);
  });
  series.forEach((s, i) => { while (ptr[i] < s.bars.length && s.bars[ptr[i]].t < start) ptr[i]++; });

  const out = [];
  let cur = null;
  for (const t of ts) {
    let O = constant, H = constant, L = constant, C = constant;
    for (let i = 0; i < series.length; i++) {
      const s = series[i], q = s.q;
      const b = ptr[i] < s.bars.length && s.bars[ptr[i]].t === t ? s.bars[ptr[i]++] : null;
      if (b) { O += q * b.o; H += q * b.h; L += q * b.l; C += q * b.c; lastClose[i] = b.c; }
      else { const v = q * lastClose[i]; O += v; H += v; L += v; C += v; }
    }
    const k = bucketStart(t, ivSec);
    if (!cur || cur.t !== k) {
      // A portfolio has no gaps: each bar opens where the previous one closed, so a daily
      // candle opens at the value at midnight, the same reference as the day change.
      const o = cur ? cur.c : O;
      cur = { t: k, o, h: Math.max(o, H), l: Math.min(o, L), c: C };
      out.push(cur);
    } else { cur.h = Math.max(cur.h, H); cur.l = Math.min(cur.l, L); cur.c = C; }
  }
  return out;
}

/* ------------------------------------------------------------------ chart */
/*
 * Dollar labels for the value series. Set per series rather than with localization.priceFormatter,
 * which would also put a "$" on the RSI and MACD panes.
 */
const usdFormat = { type: 'custom', minMove: 0.01, formatter: (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }) };
const chart = LWC.createChart($('chart'), {
  autoSize: true,
  layout: { background: { type: 'solid', color: '#0f131c' }, textColor: '#8a93a6', fontSize: 11, attributionLogo: true },
  grid: { vertLines: { color: '#1a2030' }, horzLines: { color: '#1a2030' } },
  rightPriceScale: { borderColor: '#262d3d', scaleMargins: { top: 0.12, bottom: 0.08 } },
  timeScale: { borderColor: '#262d3d', timeVisible: true, secondsVisible: false, rightOffset: 4 },
  crosshair: { mode: LWC.CrosshairMode.Normal },
  // On a phone the chart fills most of the screen: a vertical one-finger swipe on the plot scrolls
  // the page, a horizontal one still pans the chart. See chartTouch below for the exceptions.
  handleScroll: { vertTouchDrag: false },
});
/*
 * The library uses vertTouchDrag for the price axis too: with it off, dragging the Y axis to stretch
 * it scrolls the page instead. It decides on the first movement of a gesture, so a gesture that starts
 * on the price axis, or uses two fingers, turns it back on (capture phase, before the chart's own
 * listeners) and the chart behaves as it always did; it goes off again when every finger is lifted.
 */
(function chartTouch() {
  const box = $('chart');
  let grabbed = false;
  const grab = (on) => { if (on !== grabbed) { grabbed = on; chart.applyOptions({ handleScroll: { vertTouchDrag: on } }); } };
  box.addEventListener('touchstart', (e) => {
    const r = box.getBoundingClientRect();
    const axisLeft = r.right - chart.priceScale('right').width();
    if (e.touches.length >= 2 || [...e.touches].some((t) => t.clientX >= axisLeft)) grab(true);
  }, { capture: true, passive: true });
  const release = (e) => { if (!e.touches.length) grab(false); };
  box.addEventListener('touchend', release, { capture: true, passive: true });
  box.addEventListener('touchcancel', release, { capture: true, passive: true });
})();
let mainSeries = null, mainSeriesType = null, contribSeries = null;

function makeMainSeries() {
  if (mainSeries && mainSeriesType === state.chartType) return;
  if (mainSeries) { detachDrawings(); chart.removeSeries(mainSeries); }
  mainSeriesType = state.chartType;
  const common = { priceLineVisible: true, lastValueVisible: true, priceFormat: usdFormat };
  if (state.chartType === 'candle') {
    mainSeries = chart.addSeries(LWC.CandlestickSeries, { ...common, upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
  } else if (state.chartType === 'area') {
    mainSeries = chart.addSeries(LWC.AreaSeries, { ...common, lineColor: '#2962ff', topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2 });
  } else {
    mainSeries = chart.addSeries(LWC.LineSeries, { ...common, color: '#2962ff', lineWidth: 2 });
  }
  attachDrawings();
}
const toSeriesPoint = (b, time) => state.chartType === 'candle'
  ? { time, open: b.o, high: b.h, low: b.l, close: b.c }
  : { time, value: b.c };
/**
 * Chart times must be strictly increasing. Shifting to local time can map two UTC bars
 * to the same local time when DST ends (01:00-02:00 happens twice): nudge by one second.
 */
function computeChartTimes(bars) {
  const out = new Array(bars.length);
  let prev = -Infinity;
  for (let i = 0; i < bars.length; i++) { const t = Math.max(toChartTime(bars[i].t), prev + 1); out[i] = t; prev = t; }
  return out;
}

/** The single position shown in the chart, or null when the view holds several. */
function soloPosition() {
  if (state.scope !== 'custom' || (state.aggMeta && state.aggMeta.real)) return null;
  const sc = scopePositions();
  return sc.length === 1 && isMarketPos(sc[0]) && sc[0].qty > 0 ? sc[0] : null;
}
/*
 * Average cost (PMC) line for a single symbol. The chart plots the position's value
 * (quantity × price), so the line sits at the total cost basis = quantity × PMC, and the
 * axis label shows the PMC per unit. The line is kept inside the visible range.
 */
let costLine = null;
function renderCostLine() {
  if (costLine) { try { mainSeries.removePriceLine(costLine); } catch { /* series replaced */ } costLine = null; }
  const p = soloPosition();
  const cost = p && p.cost > 0 ? p.cost : null;
  mainSeries.applyOptions({
    autoscaleInfoProvider: cost == null ? undefined : (orig) => {
      const r = orig();
      if (!r || !r.priceRange) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, cost), maxValue: Math.max(r.priceRange.maxValue, cost) } };
    },
  });
  if (cost == null) return;
  costLine = mainSeries.createPriceLine({
    price: cost, color: '#f0b429', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
    axisLabelVisible: true, title: `PMC ${fmtPrice(cost / p.qty)}`,
  });
}
function renderSeries(fit) {
  makeMainSeries();
  state.chartTimes = computeChartTimes(state.agg);
  mainSeries.setData(state.agg.map((b, i) => toSeriesPoint(b, state.chartTimes[i])));
  chart.priceScale('right').applyOptions({ mode: +state.scaleMode });
  renderCostLine();
  renderRealOverlay();
  renderRealLine();
  renderFlowLines();
  renderDrawings();
  renderIndicators();
  if (fit) zoomToRange();
  updateLegend();
  updatePeriodKpi();
}

/* ------------------------------------------------------------------ money flow markers */
/**
 * External flows of the current view, one entry per flow: { d: 'YYYY-MM-DD', a: money in > 0, what }.
 * The broker uses the brief's daily flows of the value history when present (they also hold
 * securities received, at market value), plus later dated flows; crypto uses the wallet lots.
 * A symbol selection only gets the crypto lots of its coins: broker money lands in cash.
 */
function flowEvents() {
  const f = state.snap.flows, h = state.snap.history, out = [];
  const wantBroker = state.scope === 'all' || state.scope === 'broker';
  const wantCrypto = state.scope !== 'broker';
  if (!f) {
    if (state.scope !== 'all') return out;
    const sf = scopeFlows(); // old snapshots: changes of the cumulative net contributions
    for (const x of sf.list || []) out.push({ d: String(x.d).slice(0, 10), a: x.a, what: 'flussi netti' });
    return out;
  }
  if (wantBroker) {
    const hf = h && h['flow_' + BK];
    const daily = hf && hf.length === h.dates.length;
    const lastDay = daily ? String(h.dates[h.dates.length - 1]).slice(0, 10) : '';
    if (daily) hf.forEach((a, i) => { if (Math.abs(a || 0) >= 1) out.push({ d: String(h.dates[i]).slice(0, 10), a, what: BROKER }); });
    for (const [d, a] of f[BK] || []) if (!daily || String(d).slice(0, 10) > lastDay) out.push({ d: String(d).slice(0, 10), a, what: BROKER });
  }
  if (wantCrypto) {
    for (const [d, sym, a] of f.crypto || []) {
      if (state.scope === 'custom' && !state.custom.has(sym)) continue;
      out.push({ d: String(d).slice(0, 10), a, what: sym });
    }
  }
  return out;
}
/**
 * Position changes of the current view without money in or out (brief 0.9.1+):
 * { d, sym, kind: buy | sell | reinvest | out | sent, q, a }.
 */
function tradeEvents() {
  const t = state.snap.trades;
  if (!t) return [];
  return t.filter(([, sym, kind]) => {
    if (state.scope === 'custom') return state.custom.has(sym);
    if (state.scope === 'crypto') return kind === 'sent';
    if (state.scope === 'broker') return kind !== 'sent';
    return true;
  }).map(([d, sym, kind, q, a]) => ({ d: String(d).slice(0, 10), sym, kind, q, a }));
}
/**
 * Last day the positions of the view changed (a flow or a trade): from then on the chart of
 * today's positions is the real value. null when the snapshot has no trades to tell.
 */
function positionsExactSince() {
  if (!state.snap.trades) return null;
  let last = '';
  for (const e of flowEvents()) if (e.d > last) last = e.d;
  for (const e of tradeEvents()) if (e.d > last) last = e.d;
  return last || null;
}
/** Flows and trades grouped by the chart bar they fall in: Map(bar index -> { net, items, trades }). */
let flowBars = new Map();
function computeFlowBars() {
  flowBars = new Map();
  if (!state.agg.length || (!state.showFlows && !state.showTrades)) return;
  const iv = INTERVALS[state.interval];
  const times = state.agg.map((b) => b.t);
  const place = (e, add) => {
    const ts = localDayTs(e.d);
    const key = iv.intraday ? ts : bucketStart(ts, iv.sec);
    if (key < times[0] || ts > nowSec()) return; // before the visible history, or not happened yet
    const j = firstOnOrAfterNum(times, key);
    if (j >= times.length) return;
    const g = flowBars.get(j) || { net: 0, items: [], trades: [] };
    add(g);
    flowBars.set(j, g);
  };
  if (state.showFlows) for (const e of flowEvents()) place(e, (g) => { g.net += e.a; g.items.push(e); });
  if (state.showTrades) for (const e of tradeEvents()) place(e, (g) => { g.trades.push(e); });
}
function firstOnOrAfterNum(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
const fmtK = (v) => (v >= 0 ? '+' : '−') + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : Math.abs(v).toFixed(0));
let flowRaf = 0;
function renderFlowLines() { computeFlowBars(); drawFlowLines(); }
/** Positions the dashed lines on the chart; called again on every scroll, zoom and resize. */
function drawFlowLines() {
  cancelAnimationFrame(flowRaf);
  flowRaf = requestAnimationFrame(() => {
    const box = $('flowlines');
    const ts = chart.timeScale(), w = ts.width(), axisH = mainPaneBottom();
    const shade = exactShade(ts, w, axisH);
    if (!flowBars.size) { box.innerHTML = shade; return; }
    const pts = [];
    for (const [j, g] of flowBars) {
      const x = ts.timeToCoordinate(state.chartTimes[j]);
      if (x != null && x >= 0 && x <= w) pts.push({ x: Math.round(x), g });
    }
    // every line is drawn; amount labels go to the largest flows first, where there is room
    // (the legend shows every flow of the bar under the crosshair)
    const placed = [];
    for (const p of [...pts].filter((q) => q.g.items.length).sort((a, b) => Math.abs(b.g.net) - Math.abs(a.g.net))) {
      if (placed.every((x) => Math.abs(x - p.x) >= 44)) { p.label = true; placed.push(p.x); }
    }
    let html = shade;
    for (const { x, g, label } of pts) {
      const kind = !g.items.length ? ' op' : g.net < 0 ? ' out' : ''; // a day with a flow is drawn as a flow
      html += `<div class="fl${kind}" style="left:${x}px;bottom:${axisH}px">${label ? `<span>${fmtK(g.net)}</span>` : ''}</div>`;
    }
    box.innerHTML = html;
  });
}
/**
 * Current positions mode: shade in blue the bars from the last flow or trade of the view on, where
 * the chart is the real value, and in purple the earlier bars where today's positions are within
 * REAL_TOLERANCE of the real value, one band per run of bars.
 * Without a real history to compare with (intraday, custom view), shade in blue from the bar of
 * the last flow or trade of the view to the right edge: there today's quantities were already held.
 */
function exactShade(ts, w, axisH) {
  if (!state.agg.length || (state.aggMeta && state.aggMeta.real)) return '';
  const ranges = realMatchRanges();
  if (ranges) {
    const pct = Math.round(REAL_TOLERANCE * 100);
    const lastOf = { exact: -1, near: -1 }; // only the latest band of each kind is labelled
    ranges.forEach((r, k) => { lastOf[r.kind] = k; });
    let html = '';
    ranges.forEach(({ from, to, kind }, k) => {
      const x0 = ts.timeToCoordinate(state.chartTimes[from]);
      const x1 = to + 1 < state.chartTimes.length ? ts.timeToCoordinate(state.chartTimes[to + 1]) : w;
      if (x0 == null || x1 == null) return;
      const left = Math.max(0, Math.round(x0)), right = Math.min(w, Math.round(x1));
      if (right <= left) return;
      const text = kind === 'exact' ? `uguale al reale dal ${fmtBarDay(exactBandDay(from))}` : `entro ${pct}% del reale`;
      const label = k === lastOf[kind] && (k === ranges.length - 1 || right - left >= 140) ? `<span>${text}</span>` : '';
      html += `<div class="exact${kind === 'near' ? ' near' : ''}" style="left:${left}px;width:${right - left}px;bottom:${axisH}px">${label}</div>`;
    });
    return html;
  }
  const j = exactSinceBar(); // null: unknown, or changed after the last bar (nothing real to shade yet)
  if (j == null) return '';
  const x = ts.timeToCoordinate(state.chartTimes[j]);
  if (x == null) return '';
  const left = Math.max(0, Math.round(x));
  if (left >= w) return '';
  return `<div class="exact" style="left:${left}px;width:${w - left}px;bottom:${axisH}px"><span>valore reale dal ${fmtBarDay(localDayTs(positionsExactSince()))}</span></div>`;
}
/** Day a blue band starts: the day of the last flow or trade, not the start of its bar. */
function exactBandDay(from) {
  const since = positionsExactSince();
  return since ? Math.max(state.agg[from].t, localDayTs(since)) : state.agg[from].t;
}
const fmtBarDay = (t) => new Date(t * 1000).toLocaleDateString('it-IT', { timeZone: TZ(), day: 'numeric', month: 'short', year: 'numeric' });
chart.timeScale().subscribeVisibleLogicalRangeChange(drawFlowLines);
chart.timeScale().subscribeSizeChange(drawFlowLines);
/* ------------------------------------------------------------------ drawing tools */
/*
 * TradingView-style tools on the main series: a ruler (the move between two points: value, percentage,
 * bars and time span), bar markers (an arrow with an optional note) and horizontal levels. Markers and
 * levels are kept per view (scope, and the symbols for Simboli…) in this browser; the ruler is not kept.
 * While a tool is active a transparent layer over the chart takes the pointer, so with no tool in use
 * the chart's own pan, zoom and touch handling (chartTouch) work exactly as before.
 */
const DRAW_KEY = 'drawings';
/** A ruler end or a click lands on the nearest bar value (O/H/L/C for candles, the close otherwise) within this distance. */
const MAGNET_PX = 14;
const MARKER_COLOR = '#f0b429', LEVEL_COLOR = '#b39ddb';
const draw = {
  tool: null,      // 'ruler' | 'marker' | 'level' | null
  ruler: null,     // { a: { t, p }, b: { t, p } }, bar time (UTC s) and value
  rulerView: '',   // view the ruler was drawn in: it is dropped when the view changes
  phase: 'idle',   // ruler: 'drag' (button held), 'second' (waiting for the second tap), 'done'
  down: null,      // where the ruler gesture started (client px), to tell a drag from a tap
  all: (() => { const v = store.get(DRAW_KEY, {}); return v && typeof v === 'object' ? v : {}; })(),
  markersApi: null,
  levelLines: [],
  primitive: null,
};
const viewKey = () => (state.scope === 'custom' ? 'custom:' + [...state.custom].sort().join(',') : state.scope);
/*
 * Markers and levels are shared by every device through the Worker (GET/POST /drawings). Each change is
 * an idempotent operation ({ op: 'add' | 'remove' | 'clear', view, kind, item | id }): it is applied here
 * at once, queued in localStorage (pt.drawingsPending) and sent; the Worker answers with every drawing,
 * which becomes the local copy with the still unsent changes applied on top. Offline, or with a Worker
 * that does not know /drawings yet, the app keeps working on the local copy and sends the queue later.
 */
const DRAW_PENDING_KEY = 'drawingsPending', DRAW_SYNCED_KEY = 'drawingsSynced';
const DRAW_SYNC_MS = 2 * 60 * 1000;
draw.pending = ((v) => (Array.isArray(v) ? v.filter((o) => o && typeof o === 'object') : []))(store.get(DRAW_PENDING_KEY, []));
function applyDrawOp(all, op) {
  if (!op || typeof op.view !== 'string') return;
  if (op.op === 'clear') { delete all[op.view]; return; }
  const key = op.kind === 'marker' ? 'markers' : op.kind === 'level' ? 'levels' : null;
  if (!key) return;
  const cur = all[op.view] || {};
  const d = { markers: Array.isArray(cur.markers) ? cur.markers : [], levels: Array.isArray(cur.levels) ? cur.levels : [] };
  if (op.op === 'add' && op.item) d[key] = d[key].filter((x) => x.id !== op.item.id).concat(op.item);
  else if (op.op === 'remove') d[key] = d[key].filter((x) => x.id !== op.id);
  if (d.markers.length || d.levels.length) all[op.view] = d;
  else delete all[op.view];
}
function saveDrawState() { store.set(DRAW_KEY, draw.all); store.set(DRAW_PENDING_KEY, draw.pending); }
function changeDrawings(op) {
  applyDrawOp(draw.all, op);
  draw.pending.push(op);
  saveDrawState();
  syncDrawings();
}
let drawSync = { busy: false, again: false };
async function syncDrawings() {
  const api = BOOT.drawings;
  if (!api) return;
  if (drawSync.busy) { drawSync.again = true; return; }
  drawSync = { busy: true, again: false };
  try {
    let server;
    if (draw.pending.length) {
      const sent = draw.pending.slice(0, 200);
      try { server = (await api.post(sent)).drawings; }
      catch (e) {
        if (e.status !== 400) throw e;
        server = null; // refused as invalid: sending it again would fail again, so drop it
      }
      draw.pending = draw.pending.slice(sent.length); // later changes were queued after these
      if (draw.pending.length) drawSync.again = true;
      if (!server) server = (await api.get()).drawings;
    } else {
      server = (await api.get()).drawings;
    }
    const next = server && typeof server === 'object' ? JSON.parse(JSON.stringify(server)) : {};
    for (const op of draw.pending) applyDrawOp(next, op);
    const changed = JSON.stringify(next) !== JSON.stringify(draw.all);
    draw.all = next;
    saveDrawState();
    if (changed) { renderDrawings(); updateLegend(); }
  } catch { /* offline or an older Worker: the local copy and the queue stay, sent at the next sync */ }
  finally {
    const again = drawSync.again;
    drawSync = { busy: false, again: false };
    if (again) setTimeout(syncDrawings, 0);
  }
}
/** First sync in this browser: what was drawn before the sync existed is queued for upload, once. */
if (BOOT.drawings && !store.get(DRAW_SYNCED_KEY, false)) {
  const up = [];
  for (const [view, d] of Object.entries(draw.all)) {
    if (!/^(all|broker|crypto|custom:.*)$/.test(view) || !d) continue;
    for (const m of Array.isArray(d.markers) ? d.markers : []) up.push({ op: 'add', view, kind: 'marker', item: m });
    for (const l of Array.isArray(d.levels) ? d.levels : []) up.push({ op: 'add', view, kind: 'level', item: l });
  }
  draw.pending = up.concat(draw.pending);
  saveDrawState();
  store.set(DRAW_SYNCED_KEY, true);
}
const rulerViewKey = () => [viewKey(), state.interval, state.valueMode, state.includeStatic].join('|');
function viewDrawings() {
  const d = draw.all[viewKey()];
  return {
    markers: Array.isArray(d && d.markers) ? d.markers.filter((m) => m && isFinite(m.t)) : [],
    levels: Array.isArray(d && d.levels) ? d.levels.filter((l) => l && isFinite(l.price)) : [],
  };
}

/** Index of the bar holding time t (UTC s), or -1. Markers placed on daily or weekly bars carry day: true. */
function barIndexFor(t, day) {
  const n = state.agg.length;
  if (!n) return -1;
  const iv = INTERVALS[state.interval];
  if (day && iv.intraday) {
    const j = firstOnOrAfterNum(state.agg.map((b) => b.t), t);
    return j < n && state.agg[j].t < t + 86400 ? j : -1;
  }
  let lo = 0, hi = n - 1, j = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (state.agg[mid].t <= t) { j = mid; lo = mid + 1; } else hi = mid - 1; }
  return j >= 0 && t < state.agg[j].t + iv.sec ? j : -1;
}
const exactBarIndex = (t) => { const j = barIndexFor(t, false); return j >= 0 && state.agg[j].t === t ? j : -1; };

/** Bar index and value under a point of the plot (px from the chart's top-left), with the magnet; null off the plot. */
function chartPoint(x, y) {
  if (!mainSeries || !state.agg.length) return null;
  const ts = chart.timeScale();
  if (x < 0 || y < 0 || x > ts.width() || y > chart.paneSize().height) return null;
  const L = ts.coordinateToLogical(x);
  let p = mainSeries.coordinateToPrice(y);
  if (L == null || p == null || !isFinite(p)) return null;
  const i = Math.max(0, Math.min(state.agg.length - 1, Math.round(L)));
  const b = state.agg[i];
  let best = MAGNET_PX;
  for (const v of state.chartType === 'candle' ? [b.o, b.h, b.l, b.c] : [b.c]) {
    const cy = mainSeries.priceToCoordinate(v);
    if (cy != null && Math.abs(cy - y) < best) { best = Math.abs(cy - y); p = v; }
  }
  return { i, t: b.t, p };
}

const fmtSpan = (sec) => {
  const s = Math.abs(sec);
  if (s >= 86400) { const d = Math.round(s / 86400); return d >= 365 ? `${(d / 365).toFixed(1).replace('.', ',')} anni (${d}g)` : `${d}g`; }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`;
};
const fmtMove = (v) => fmtSigned(v, Math.abs(v) < 100 ? 2 : 0);

/** Pixel geometry and text of the ruler for the current scroll, zoom and price scale, or null. */
function rulerGeometry(series) {
  const r = draw.ruler;
  if (!r || !series) return null;
  if (draw.rulerView !== rulerViewKey()) { draw.ruler = null; return null; }
  const ia = exactBarIndex(r.a.t), ib = exactBarIndex(r.b.t);
  if (ia < 0 || ib < 0) return null;
  const ts = chart.timeScale();
  const x1 = ts.timeToCoordinate(state.chartTimes[ia]), x2 = ts.timeToCoordinate(state.chartTimes[ib]);
  const y1 = series.priceToCoordinate(r.a.p), y2 = series.priceToCoordinate(r.b.p);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
  const d = r.b.p - r.a.p;
  const pct = r.a.p ? d / r.a.p : null;
  const bars = ib - ia;
  const day = (t) => new Date(t * 1000).toLocaleDateString('it-IT', { timeZone: TZ(), day: 'numeric', month: 'short', year: '2-digit' });
  const lines = [
    `${fmtMove(d)}${pct == null ? '' : ` (${fmtPct(pct)})`}`,
    `${Math.abs(bars)} ${Math.abs(bars) === 1 ? 'barra' : 'barre'} · ${fmtSpan(r.b.t - r.a.t)}`,
    INTERVALS[state.interval].intraday && Math.abs(r.b.t - r.a.t) < 86400 ? null : `${day(Math.min(r.a.t, r.b.t))} → ${day(Math.max(r.a.t, r.b.t))}`,
  ].filter(Boolean);
  return { x1, x2, y1, y2, up: d >= 0, lines, live: draw.phase !== 'done' };
}
function paintRuler(ctx, g, size) {
  const col = g.up ? '38,166,154' : '239,83,80';
  const l = Math.min(g.x1, g.x2), r = Math.max(g.x1, g.x2), t = Math.min(g.y1, g.y2), b = Math.max(g.y1, g.y2);
  ctx.save();
  ctx.fillStyle = `rgba(${col},.16)`;
  ctx.fillRect(l, t, Math.max(1, r - l), Math.max(1, b - t));
  ctx.strokeStyle = `rgba(${col},.95)`;
  ctx.lineWidth = 1;
  const arrow = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 2) return;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (len < 10) return;
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x1 - 7 * Math.cos(a - 0.45), y1 - 7 * Math.sin(a - 0.45));
    ctx.moveTo(x1, y1); ctx.lineTo(x1 - 7 * Math.cos(a + 0.45), y1 - 7 * Math.sin(a + 0.45));
    ctx.stroke();
  };
  const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
  arrow(mx, g.y1, mx, g.y2);
  arrow(g.x1, my, g.x2, my);
  // Label under the box when the move is down, above it when up; kept inside the plot.
  ctx.font = '11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const lh = 15, padX = 8, padY = 5;
  const w = Math.max(...g.lines.map((s) => ctx.measureText(s).width)) + 2 * padX;
  const h = g.lines.length * lh + 2 * padY - 3;
  let bx = Math.min(Math.max(4, mx - w / 2), size.width - w - 4);
  let by = g.up ? t - h - 6 : b + 6;
  if (by < 4) by = b + 6;
  if (by + h > size.height - 4) by = Math.max(4, t - h - 6);
  ctx.fillStyle = `rgba(${col},.92)`;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, w, h, 4); ctx.fill(); } else ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  g.lines.forEach((s, k) => ctx.fillText(s, bx + padX, by + padY + k * lh));
  ctx.restore();
}
/** Series primitive: the chart draws the ruler in its own paint cycle, so it follows every scroll, zoom and axis drag. */
function rulerPrimitive() {
  let series = null, request = null, geo = null;
  const renderer = { draw(target) { if (geo) target.useMediaCoordinateSpace(({ context, mediaSize }) => paintRuler(context, geo, mediaSize)); } };
  const view = { renderer: () => renderer, zOrder: () => 'top' };
  return {
    attached(p) { series = p.series; request = p.requestUpdate; },
    detached() { series = null; request = null; },
    updateAllViews() { geo = rulerGeometry(series); },
    paneViews: () => [view],
    redraw() { if (request) request(); },
  };
}

function attachDrawings() {
  draw.primitive = rulerPrimitive();
  mainSeries.attachPrimitive(draw.primitive);
  draw.markersApi = LWC.createSeriesMarkers(mainSeries, []);
  draw.levelLines = [];
}
function detachDrawings() {
  for (const ln of draw.levelLines) { try { mainSeries.removePriceLine(ln); } catch { /* series replaced */ } }
  draw.levelLines = [];
  try { if (draw.markersApi) draw.markersApi.detach(); } catch { /* series replaced */ }
  try { if (draw.primitive) mainSeries.detachPrimitive(draw.primitive); } catch { /* series replaced */ }
  draw.markersApi = null; draw.primitive = null;
}
/** Markers and levels of the current view on the current bars; called on every rebuild. */
function renderDrawings() {
  if (!mainSeries || !draw.markersApi) return;
  const d = viewDrawings();
  const day = !INTERVALS[state.interval].intraday;
  const list = [];
  for (const m of d.markers) {
    const j = barIndexFor(m.t, m.day && !day);
    if (j >= 0 && state.chartTimes[j] != null) list.push({ time: state.chartTimes[j], position: 'aboveBar', shape: 'arrowDown', color: MARKER_COLOR, text: m.text || '', id: String(m.id) });
  }
  list.sort((a, b) => a.time - b.time);
  draw.markersApi.setMarkers(list);
  for (const ln of draw.levelLines) { try { mainSeries.removePriceLine(ln); } catch { /* gone */ } }
  draw.levelLines = d.levels.map((l) => mainSeries.createPriceLine({
    price: l.price, color: LEVEL_COLOR, lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: l.text || '',
  }));
  if (draw.ruler && draw.rulerView !== rulerViewKey()) draw.ruler = null;
  if (draw.primitive) draw.primitive.redraw();
  $('draw-clear').disabled = !d.markers.length && !d.levels.length;
}
/** Notes of the markers on a bar, for the legend. */
function markerLegend(idx) {
  const b = state.agg[idx];
  if (!b) return '';
  const day = !INTERVALS[state.interval].intraday;
  const notes = viewDrawings().markers.filter((m) => m.text && barIndexFor(m.t, m.day && !day) === idx).map((m) => esc(m.text));
  return notes.length ? `<br><span style="color:${MARKER_COLOR}">▼ ${notes.join(' · ')}</span>` : '';
}

const DRAW_HINT = {
  ruler: 'Righello: trascina, oppure tocca il punto iniziale e poi quello finale',
  rulerSecond: 'Tocca il punto finale',
  marker: 'Tocca una candela per il marcatore (toccane una che lo ha per toglierlo)',
  level: 'Tocca all\'altezza del livello (toccane uno esistente per toglierlo)',
};
function setTool(tool) {
  draw.tool = tool;
  if (tool === 'ruler') { draw.ruler = null; draw.phase = 'idle'; }
  if (draw.primitive) draw.primitive.redraw();
  $('drawlayer').classList.toggle('on', !!tool);
  for (const b of document.querySelectorAll('#drawtools [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  $('drawhint').textContent = tool ? DRAW_HINT[tool] : '';
  if (!tool) chart.clearCrosshairPosition();
}
function clearRuler() {
  draw.ruler = null; draw.phase = 'idle';
  if (draw.primitive) draw.primitive.redraw();
}
function layerPoint(e) {
  const r = $('chart').getBoundingClientRect();
  return chartPoint(e.clientX - r.left, e.clientY - r.top);
}
function finishRuler() {
  draw.phase = 'done';
  setTool(null); // one shot, as on TradingView: the measure stays until the next tap on the chart
  if (draw.primitive) draw.primitive.redraw();
}
function markerAt(pt) {
  const d = viewDrawings();
  const day = !INTERVALS[state.interval].intraday;
  const hit = d.markers.find((m) => barIndexFor(m.t, m.day && !day) === pt.i);
  if (hit) {
    if (confirm(`Eliminare il marcatore${hit.text ? ` "${hit.text}"` : ''}?`)) changeDrawings({ op: 'remove', view: viewKey(), kind: 'marker', id: hit.id });
  } else {
    const text = prompt('Nota del marcatore (facoltativa)', '');
    if (text === null) return;
    changeDrawings({ op: 'add', view: viewKey(), kind: 'marker', item: { id: Date.now(), t: pt.t, day, text: text.replace(/\s+/g, ' ').trim().slice(0, 40) } });
  }
  setTool(null);
  renderDrawings();
  updateLegend();
}
function levelAt(pt, y) {
  const d = viewDrawings();
  const hit = d.levels.find((l) => { const ly = mainSeries.priceToCoordinate(l.price); return ly != null && Math.abs(ly - y) <= 8; });
  if (hit) {
    if (confirm(`Eliminare il livello ${fmtUsd(hit.price, Math.abs(hit.price) < 100 ? 2 : 0)}${hit.text ? ` "${hit.text}"` : ''}?`)) changeDrawings({ op: 'remove', view: viewKey(), kind: 'level', id: hit.id });
  } else {
    const text = prompt(`Nota del livello a ${fmtUsd(pt.p, Math.abs(pt.p) < 100 ? 2 : 0)} (facoltativa)`, '');
    if (text === null) return;
    changeDrawings({ op: 'add', view: viewKey(), kind: 'level', item: { id: Date.now(), price: Math.round(pt.p * 100) / 100, text: text.replace(/\s+/g, ' ').trim().slice(0, 30) } });
  }
  setTool(null);
  renderDrawings();
}
(function drawingTools() {
  const layer = $('drawlayer');
  const showCrosshair = (pt) => { if (pt && mainSeries) chart.setCrosshairPosition(pt.p, state.chartTimes[pt.i], mainSeries); };
  layer.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const pt = layerPoint(e);
    if (!pt) return;
    e.preventDefault();
    if (draw.tool === 'marker') { markerAt(pt); return; }
    if (draw.tool === 'level') { levelAt(pt, e.clientY - $('chart').getBoundingClientRect().top); return; }
    if (draw.tool !== 'ruler') return;
    try { layer.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (draw.phase === 'second') { draw.ruler.b = { t: pt.t, p: pt.p }; finishRuler(); return; }
    draw.ruler = { a: { t: pt.t, p: pt.p }, b: { t: pt.t, p: pt.p } };
    draw.rulerView = rulerViewKey();
    draw.phase = 'drag';
    draw.down = { x: e.clientX, y: e.clientY };
    draw.primitive.redraw();
  });
  layer.addEventListener('pointermove', (e) => {
    const pt = layerPoint(e);
    showCrosshair(pt);
    if (!pt || draw.tool !== 'ruler' || (draw.phase !== 'drag' && draw.phase !== 'second')) return;
    draw.ruler.b = { t: pt.t, p: pt.p };
    draw.primitive.redraw();
  });
  layer.addEventListener('pointerup', (e) => {
    if (draw.tool !== 'ruler' || draw.phase !== 'drag') return;
    if (Math.hypot(e.clientX - draw.down.x, e.clientY - draw.down.y) > 8) { finishRuler(); return; }
    draw.phase = 'second';
    $('drawhint').textContent = DRAW_HINT.rulerSecond;
  });
  layer.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') chart.clearCrosshairPosition(); });
  // With no tool active, the next press on the chart removes the last measure (the press that ends a
  // measure lands on the layer, so it never clears the measure it has just made).
  $('chart').addEventListener('pointerdown', () => { if (!draw.tool && draw.ruler) clearRuler(); }, { capture: true, passive: true });
  $('drawtools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { setTool(draw.tool === b.dataset.tool ? null : b.dataset.tool); if (b.dataset.tool === 'ruler' && !draw.tool) clearRuler(); return; }
    if (b.id === 'draw-clear') {
      const d = viewDrawings();
      if (!d.markers.length && !d.levels.length) return;
      if (!confirm(`Eliminare ${d.markers.length} marcatori e ${d.levels.length} livelli di questa vista?`)) return;
      changeDrawings({ op: 'clear', view: viewKey() });
      setTool(null); clearRuler(); renderDrawings(); updateLegend();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!draw.tool && !draw.ruler)) return;
    setTool(null); clearRuler();
  });
  // Drawings made on another device show up when the app comes back to the foreground, and every few minutes.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncDrawings(); });
  setInterval(() => { if (!document.hidden) syncDrawings(); }, DRAW_SYNC_MS);
  syncDrawings();
})();
/* ------------------------------------------------------------------ technical indicators */
/*
 * Lightweight Charts has no indicators of its own (TradingView keeps them in its larger charting
 * products), so they are computed here from the bars of the view: moving averages and Bollinger bands
 * over the price, RSI and MACD in panes of their own under it. The list is shared by every device
 * through the Worker (GET/POST /indicators), like markers and levels; it applies to every view.
 */
const IND_KEY = 'indicators', IND_DIRTY_KEY = 'indicatorsDirty';
const IND_MAX = 8, IND_MAX_PANES = 2;
const IND_COLORS = ['#f0b429', '#e040fb', '#00bcd4', '#ff7043', '#8bc34a', '#90a4ae', '#ffd54f', '#4dd0e1'];
const IND_TYPES = {
  sma: { label: 'Media mobile semplice (SMA)', short: 'SMA', pane: false, params: [{ k: 'n', label: 'Periodi', def: 20, min: 2, max: 400 }] },
  ema: { label: 'Media mobile esponenziale (EMA)', short: 'EMA', pane: false, params: [{ k: 'n', label: 'Periodi', def: 50, min: 2, max: 400 }] },
  bb: { label: 'Bande di Bollinger', short: 'BB', pane: false, params: [{ k: 'n', label: 'Periodi', def: 20, min: 2, max: 400 }, { k: 'k', label: 'Dev. std', def: 2, min: 0.5, max: 5, step: 0.5 }] },
  rsi: { label: 'RSI', short: 'RSI', pane: true, params: [{ k: 'n', label: 'Periodi', def: 14, min: 2, max: 100 }] },
  macd: { label: 'MACD', short: 'MACD', pane: true, params: [{ k: 'f', label: 'Veloce', def: 12, min: 2, max: 100 }, { k: 's', label: 'Lenta', def: 26, min: 3, max: 200 }, { k: 'g', label: 'Segnale', def: 9, min: 2, max: 100 }] },
};
/** A valid indicator, or null: { id, type, color, ...params } with every parameter inside its range. */
function cleanIndicator(x) {
  const t = x && IND_TYPES[x.type];
  if (!t || !Number.isSafeInteger(x.id) || x.id <= 0) return null;
  const out = { id: x.id, type: x.type, color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : IND_COLORS[0] };
  for (const p of t.params) {
    const v = Number(x[p.k]);
    out[p.k] = isFinite(v) ? Math.min(p.max, Math.max(p.min, p.step ? Math.round(v / p.step) * p.step : Math.round(v))) : p.def;
  }
  return out;
}
const cleanIndicators = (v) => (Array.isArray(v) ? v.map(cleanIndicator).filter(Boolean).slice(0, IND_MAX) : []);
const ind = {
  list: cleanIndicators(store.get(IND_KEY, [])),
  dirty: !!store.get(IND_DIRTY_KEY, false), // changed here and not yet saved by the Worker
  series: new Map(), // id -> { lines: [series], guides: [price lines] }
  values: new Map(), // id -> { [line]: number[] | null[] } for the bars of the view
  sync: { busy: false, again: false },
};
const indName = (x) => `${IND_TYPES[x.type].short} ${IND_TYPES[x.type].params.map((p) => x[p.k]).join(', ')}`;

// ---- math (bars of the view, oldest first; null where the indicator is not defined yet)
function smaOf(v, n) {
  const out = new Array(v.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) { sum = 0; cnt = 0; continue; }
    sum += v[i]; cnt++;
    if (cnt > n) sum -= v[i - n];
    if (cnt >= n) out[i] = sum / n;
  }
  return out;
}
/** EMA seeded with the SMA of the first n defined values. */
function emaOf(v, n) {
  const out = new Array(v.length).fill(null);
  const a = 2 / (n + 1);
  let prev = null, seed = 0, cnt = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) continue;
    if (prev == null) {
      seed += v[i]; cnt++;
      if (cnt === n) { prev = seed / n; out[i] = prev; }
    } else { prev = a * v[i] + (1 - a) * prev; out[i] = prev; }
  }
  return out;
}
function bollingerOf(v, n, k) {
  const mid = smaOf(v, n), up = new Array(v.length).fill(null), lo = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    if (mid[i] == null) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n); // population standard deviation, as TradingView
    up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
  }
  return { mid, up, lo };
}
/** Wilder's RSI. */
function rsiOf(v, n) {
  const out = new Array(v.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) { gain += g; loss += l; if (i < n) continue; gain /= n; loss /= n; }
    else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function macdOf(v, f, s, g) {
  const ef = emaOf(v, f), es = emaOf(v, s);
  const macd = v.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = emaOf(macd, g);
  const hist = macd.map((m, i) => (m != null && signal[i] != null ? m - signal[i] : null));
  return { macd, signal, hist };
}
function computeIndicator(x, closes) {
  if (x.type === 'sma') return { main: smaOf(closes, x.n) };
  if (x.type === 'ema') return { main: emaOf(closes, x.n) };
  if (x.type === 'bb') return bollingerOf(closes, x.n, x.k);
  if (x.type === 'rsi') return { main: rsiOf(closes, x.n) };
  return macdOf(closes, x.f, x.s, x.g);
}

// ---- series
const oscFormat = { type: 'custom', minMove: 0.01, formatter: (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) };
function removeIndicatorSeries() {
  for (const s of ind.series.values()) for (const l of s.lines) { try { chart.removeSeries(l); } catch { /* already gone */ } }
  ind.series.clear();
  while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
}
/** Series for the current list: overlays on the price pane, each oscillator in a pane of its own. */
function buildIndicatorSeries() {
  removeIndicatorSeries();
  let pane = 0;
  for (const x of ind.list) {
    const t = IND_TYPES[x.type];
    const base = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineWidth: 1 };
    if (!t.pane) {
      // The price decides the scale: a band far from it (or below zero on a log scale) must not squash it.
      const over = { ...base, color: x.color, priceFormat: usdFormat, autoscaleInfoProvider: () => null };
      const lines = x.type === 'bb'
        ? ['up', 'mid', 'lo'].map((k) => chart.addSeries(LWC.LineSeries, { ...over, lineStyle: k === 'mid' ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid }))
        : [chart.addSeries(LWC.LineSeries, { ...over, lineWidth: 2 })];
      ind.series.set(x.id, { keys: x.type === 'bb' ? ['up', 'mid', 'lo'] : ['main'], lines, guides: [] });
      continue;
    }
    if (pane >= IND_MAX_PANES) continue;
    pane++;
    const osc = { ...base, priceFormat: oscFormat, lastValueVisible: true };
    if (x.type === 'rsi') {
      const l = chart.addSeries(LWC.LineSeries, { ...osc, color: x.color, lineWidth: 2, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, pane);
      const guides = [70, 30].map((p) => l.createPriceLine({ price: p, color: '#8a93a6', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false, title: '' }));
      ind.series.set(x.id, { keys: ['main'], lines: [l], guides });
    } else {
      const hist = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: oscFormat }, pane);
      const m = chart.addSeries(LWC.LineSeries, { ...osc, color: x.color, lineWidth: 2 }, pane);
      const sig = chart.addSeries(LWC.LineSeries, { ...osc, color: 'rgba(209,212,220,.85)', lastValueVisible: false }, pane);
      ind.series.set(x.id, { keys: ['hist', 'macd', 'signal'], lines: [hist, m, sig], guides: [] });
    }
  }
  const panes = chart.panes();
  for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(0.35);
  if (panes.length) panes[0].setStretchFactor(1);
  // The chart grows with each indicator pane, so the price pane keeps about its height.
  $('chartwrap').classList.toggle('panes1', panes.length === 2);
  $('chartwrap').classList.toggle('panes2', panes.length >= 3);
  ind.built = JSON.stringify(ind.list);
}
const indPoint = (key, v, time, overlay) => {
  if (v == null || !isFinite(v) || (overlay && state.scaleMode === 1 && v <= 0)) return { time }; // log scale: no value at or below zero
  return key === 'hist' ? { time, value: v, color: v >= 0 ? 'rgba(38,166,154,.6)' : 'rgba(239,83,80,.6)' } : { time, value: v };
};
/** Computes every indicator on the bars of the view and draws it; called on every rebuild. */
function renderIndicators() {
  if (ind.built !== JSON.stringify(ind.list)) buildIndicatorSeries();
  const closes = state.agg.map((b) => b.c);
  ind.values.clear();
  for (const x of ind.list) {
    const s = ind.series.get(x.id);
    if (!s) continue;
    const vals = computeIndicator(x, closes);
    ind.values.set(x.id, vals);
    const overlay = !IND_TYPES[x.type].pane;
    // In % mode the library measures every series from its own first value, so an average or a band
    // would sit away from the price it belongs to: overlays are hidden there.
    if (overlay) for (const l of s.lines) l.applyOptions({ visible: state.scaleMode !== 2 });
    s.keys.forEach((k, j) => s.lines[j].setData(state.chartTimes.map((time, i) => indPoint(k, vals[k][i], time, overlay))));
  }
  drawFlowLines();
  placeDrawTools();
}
/** Live tick: recompute and move only the last point of each line. */
function updateIndicatorsTail() {
  const n = state.agg.length;
  if (!n || !ind.list.length) return;
  const closes = state.agg.map((b) => b.c);
  for (const x of ind.list) {
    const s = ind.series.get(x.id);
    if (!s) continue;
    const vals = computeIndicator(x, closes);
    ind.values.set(x.id, vals);
    s.keys.forEach((k, j) => s.lines[j].update(indPoint(k, vals[k][n - 1], state.chartTimes[n - 1], !IND_TYPES[x.type].pane)));
  }
}
function indicatorLegend(idx) {
  if (!ind.list.length) return '';
  const parts = [];
  for (const x of ind.list) {
    const v = ind.values.get(x.id);
    if (!v) continue;
    const t = IND_TYPES[x.type];
    const fmt = t.pane ? (n) => (n == null ? '—' : n.toFixed(Math.abs(n) >= 100 ? 0 : 2)) : (n) => (n == null ? '—' : fmtUsd(n, Math.abs(n) < 100 ? 2 : 0));
    const vals = x.type === 'bb' ? [v.up[idx], v.mid[idx], v.lo[idx]] : x.type === 'macd' ? [v.macd[idx], v.signal[idx], v.hist[idx]] : [v.main[idx]];
    const hidden = !t.pane && state.scaleMode === 2 ? ' <span class="muted">(nascosta in scala %)</span>' : '';
    parts.push(`<span style="color:${x.color}">${esc(indName(x))}</span> <span class="num">${vals.map(fmt).join(' / ')}</span>${hidden}`);
  }
  return parts.length ? '<br>' + parts.join(' &nbsp;') : '';
}
/** Height of everything under the price pane (indicator panes and the time axis), in px. */
function mainPaneBottom() {
  const h = $('chart').clientHeight - chart.paneSize(0).height;
  return h > 0 ? h : chart.timeScale().height();
}
/** The tool buttons sit at the bottom left of the price pane, above the TradingView logo. */
function placeDrawTools() {
  const b = mainPaneBottom() + 40;
  $('drawtools').style.bottom = b + 'px';
  $('indpanel').style.bottom = b + 38 + 'px';
}
chart.timeScale().subscribeSizeChange(placeDrawTools);

// ---- list changes and sync
function setIndicators(list) {
  ind.list = cleanIndicators(list);
  ind.dirty = true;
  store.set(IND_KEY, ind.list); store.set(IND_DIRTY_KEY, true);
  renderIndicators(); updateLegend(); renderIndPanel();
  syncIndicators();
}
async function syncIndicators() {
  const api = BOOT.indicators;
  if (!api) return;
  if (ind.sync.busy) { ind.sync.again = true; return; }
  ind.sync = { busy: true, again: false };
  try {
    const sent = JSON.stringify(ind.list);
    let server;
    if (ind.dirty) {
      try { server = (await api.post(ind.list)).indicators; }
      catch (e) { if (e.status !== 400) throw e; server = (await api.get()).indicators; } // refused: take the shared list
      if (JSON.stringify(ind.list) === sent) { ind.dirty = false; store.set(IND_DIRTY_KEY, false); }
      else ind.sync.again = true; // changed while saving: send the newer list
    } else {
      server = (await api.get()).indicators;
    }
    if (!ind.dirty) {
      const next = cleanIndicators(server);
      if (JSON.stringify(next) !== JSON.stringify(ind.list)) {
        ind.list = next; store.set(IND_KEY, next);
        renderIndicators(); updateLegend(); renderIndPanel();
      }
    }
  } catch { /* offline or an older Worker: the local list stays and is sent at the next sync */ }
  finally {
    const again = ind.sync.again;
    ind.sync = { busy: false, again: false };
    if (again) setTimeout(syncIndicators, 0);
  }
}

// ---- panel
function renderIndPanel() {
  const box = $('indpanel');
  if (box.hidden) return;
  const rows = ind.list.map((x) => `<div class="ir"><span class="sw" style="background:${x.color}"></span>${esc(indName(x))}`
    + `${IND_TYPES[x.type].pane && ind.list.filter((y) => IND_TYPES[y.type].pane).indexOf(x) >= IND_MAX_PANES ? ' <span class="muted">(non mostrato: al massimo 2 pannelli)</span>' : ''}`
    + `<button type="button" data-del="${x.id}" title="Rimuovi" aria-label="Rimuovi ${esc(indName(x))}">✕</button></div>`).join('');
  const type = box.dataset.type && IND_TYPES[box.dataset.type] ? box.dataset.type : 'sma';
  const opts = Object.entries(IND_TYPES).map(([k, t]) => `<option value="${k}"${k === type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const params = IND_TYPES[type].params.map((p) => `<label>${esc(p.label)} <input type="number" data-p="${p.k}" value="${p.def}" min="${p.min}" max="${p.max}" step="${p.step || 1}" inputmode="decimal"></label>`).join('');
  box.innerHTML = `<div class="ih"><b>Indicatori</b><button type="button" data-close title="Chiudi" aria-label="Chiudi">✕</button></div>`
    + (rows || '<div class="muted">Nessun indicatore attivo.</div>')
    + (ind.list.length < IND_MAX ? `<div class="ia"><select id="ind-type">${opts}</select>${params}<button type="button" class="btn" data-add>Aggiungi</button></div>` : '<div class="muted">Al massimo 8 indicatori.</div>')
    + `<div class="muted">Calcolati sulle candele della vista; salvati per tutti i dispositivi.</div>`;
}
(function indicatorPanel() {
  const box = $('indpanel');
  $('ind-btn').addEventListener('click', () => {
    box.hidden = !box.hidden;
    $('ind-btn').classList.toggle('on', !box.hidden);
    renderIndPanel();
  });
  box.addEventListener('change', (e) => { if (e.target.id === 'ind-type') { box.dataset.type = e.target.value; renderIndPanel(); } });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-close')) { box.hidden = true; $('ind-btn').classList.remove('on'); return; }
    if (b.dataset.del) { setIndicators(ind.list.filter((x) => String(x.id) !== b.dataset.del)); return; }
    if (b.hasAttribute('data-add')) {
      const type = $('ind-type').value;
      const x = { id: Date.now(), type, color: IND_COLORS.find((c) => !ind.list.some((y) => y.color === c)) || IND_COLORS[ind.list.length % IND_COLORS.length] };
      for (const inp of box.querySelectorAll('input[data-p]')) x[inp.dataset.p] = Number(inp.value);
      if (type === 'macd' && x.f >= x.s) { alert('Nel MACD la media veloce deve avere meno periodi della lenta.'); return; }
      const c = cleanIndicator(x);
      if (c) setIndicators(ind.list.concat(c));
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncIndicators(); });
  setInterval(() => { if (!document.hidden) syncIndicators(); }, DRAW_SYNC_MS);
  syncIndicators();
})();
const TRADE_LABEL = { buy: 'acquisto', sell: 'vendita', reinvest: 'reinvestimento', out: 'trasferimento in uscita', sent: 'inviate dal wallet' };
function flowLegend(idx) {
  const g = flowBars.get(idx);
  if (!g) return '';
  const label = (e) => e.what === BROKER ? (e.a >= 0 ? `entrata ${esc(BROKER)}` : `uscita ${esc(BROKER)}`)
    : e.what === 'flussi netti' ? 'flussi netti' : `${esc(e.what)} arrivati nel wallet`;
  let out = '';
  if (g.items.length) out += '<br><span class="muted">Flussi:</span> ' + g.items.map((e) => `${label(e)} <span class="num ${cls(e.a)}">${fmtSigned(e.a)}</span> <span class="muted">(${esc(e.d)})</span>`).join(' · ');
  if (g.trades.length) {
    const shown = g.trades.slice(0, 4).map((e) => `<span style="color:#f0b429">${esc(TRADE_LABEL[e.kind] || e.kind)}</span> ${esc(e.sym)} ${fmtQty(e.q)}${e.a ? ` <span class="muted">(${fmtUsd(e.a)})</span>` : ''}`);
    out += '<br><span class="muted">Operazioni:</span> ' + shown.join(' · ') + (g.trades.length > 4 ? ` <span class="muted">e altre ${g.trades.length - 4}</span>` : '');
  }
  return out;
}

/* ------------------------------------------------------------------ real value over the current positions */
/**
 * With "current positions", a line with the real value of the view from the brief's daily history,
 * one point per bar (the last day of the bucket), ending on today's value: today the current
 * positions are the real portfolio. Where the line and the candles part, the positions differed.
 */
let realSeries = null, realByBar = new Map();
function realLineReason() {
  if (INTERVALS[state.interval].intraday) return 'la serie reale è giornaliera: usa 1G o 1S';
  if (state.scope === 'custom') return `il valore reale esiste solo per Tutto, ${BROKER} e Crypto`;
  if (!staticIncluded() && state.scope !== 'crypto') return 'il valore reale comprende liquidità e CD: attiva "CD e liquidità"';
  if (!realHistory(state.scope)) return 'questo snapshot non ha lo storico reale per questa vista';
  return '';
}
function syncRealToggle() {
  const why = realLineReason();
  $('opt-real').checked = state.showReal;
  $('opt-real').disabled = !!why;
  $('lbl-real').style.display = state.valueMode === 'positions' ? '' : 'none';
  $('lbl-real').style.opacity = why ? 0.4 : 1;
  $('lbl-real').title = why ? `Valore reale non disponibile: ${why}.`
    : 'Linea con il valore vero della vista giorno per giorno (dal Portfolio Brief) sopra le candele delle posizioni attuali: dove si separano, le posizioni erano diverse da oggi.';
}
function renderRealLine() {
  syncRealToggle();
  if (realSeries) { chart.removeSeries(realSeries); realSeries = null; }
  realByBar = new Map();
  if (!state.showReal) return;
  const byBar = realValuesByBar();
  if (!byBar) return;
  realByBar = byBar;
  const data = [...realByBar.entries()].sort((a, b) => a[0] - b[0]).map(([j, v]) => ({ time: state.chartTimes[j], value: v }));
  realSeries = chart.addSeries(LWC.LineSeries, { color: '#d1d4dc', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: usdFormat });
  realSeries.setData(data);
}
/** Real value of the view at each bar (the last day of the bucket), or null where it cannot be compared. */
function realValuesByBar() {
  if (!state.agg.length || !state.aggMeta || state.aggMeta.real || realLineReason()) return null;
  const iv = INTERVALS[state.interval];
  const times = state.agg.map((b) => b.t);
  const out = new Map();
  for (const p of realHistory(state.scope)) {
    const key = bucketStart(p.t, iv.sec);
    if (key < times[0]) continue;
    const j = firstOnOrAfterNum(times, key);
    if (j < times.length && times[j] === key) out.set(j, p.v); // weekly bars: the last day wins
  }
  out.set(times.length - 1, state.agg[times.length - 1].c); // today the positions are the real portfolio
  return out;
}
/** Gap between today's positions and the real value, as a share of the real value, below which the chart is shaded. */
const REAL_TOLERANCE = 0.05;
/**
 * First bar from which today's quantities were already held (after the last flow or trade of the
 * view), 0 if they never changed in the bars shown, null if unknown or only after the last bar.
 */
function exactSinceBar() {
  const since = positionsExactSince();
  if (!since || !state.agg.length) return null;
  const iv = INTERVALS[state.interval];
  const t0 = localDayTs(since), key = iv.intraday ? t0 : bucketStart(t0, iv.sec);
  const times = state.agg.map((b) => b.t);
  if (key < times[0]) return 0;
  const j = firstOnOrAfterNum(times, key);
  return j < times.length ? j : null;
}
/**
 * Runs of bars where today's positions match the real value: { from, to, kind } with bar indices.
 * kind 'exact' from the bar of the last flow or trade on: the quantities are today's, and the small
 * gap left (accrued interest of the CDs, closes from a different source) is not a real difference.
 * kind 'near' before it, where the gap is under REAL_TOLERANCE of the real value; a bar with no
 * real value keeps the kind of the bar before it. null when the view has no real history.
 */
function realMatchRanges() {
  const real = realValuesByBar();
  if (!real) return null;
  const exactFrom = exactSinceBar();
  const out = [];
  let kind = null;
  for (let j = 0; j < state.agg.length; j++) {
    const v = real.get(j);
    if (exactFrom != null && j >= exactFrom) kind = 'exact';
    else if (v != null) kind = v !== 0 && Math.abs(state.agg[j].c - v) < REAL_TOLERANCE * Math.abs(v) ? 'near' : null;
    if (!kind) continue;
    const last = out[out.length - 1];
    if (last && last.to === j - 1 && last.kind === kind) last.to = j; else out.push({ from: j, to: j, kind });
  }
  return out;
}
/** Live ticks move today's point of the real line together with the last candle. */
function updateRealLineTail() {
  if (!realSeries || !state.agg.length) return;
  const j = state.agg.length - 1;
  realByBar.set(j, state.agg[j].c);
  realSeries.update({ time: state.chartTimes[j], value: state.agg[j].c });
}
function realLegend(idx, b) {
  const v = realByBar.get(idx);
  if (v == null || idx === state.agg.length - 1) return '';
  const gap = b.c - v;
  return `<br><span style="color:#d1d4dc">Reale</span> <span class="num">${fmtUsd(v)}</span> <span class="muted">· posizioni attuali meno reale</span> <span class="num ${cls(gap)}">${fmtSigned(gap)}</span>`;
}

/** Cumulative net contributions (dashed), shown with the real history of the whole portfolio. */
function renderRealOverlay() {
  if (contribSeries) { chart.removeSeries(contribSeries); contribSeries = null; }
  const iv = INTERVALS[state.interval];
  const h = state.snap.history;
  if (!state.showContrib || !state.aggMeta || !state.aggMeta.real || state.scope !== 'all' || !h || !h.contrib) return;
  const start = state.aggMeta.start;
  const cps = [];
  for (let i = 0; i < h.dates.length; i++) {
    const t = localDayTs(h.dates[i]);
    if (t < start || h.contrib[i] == null || !isFinite(h.contrib[i])) continue;
    const k = bucketStart(t, iv.sec);
    if (cps.length && cps[cps.length - 1].time === k) cps[cps.length - 1].value = h.contrib[i];
    else cps.push({ time: k, value: h.contrib[i] });
  }
  const lastC = cps.length ? cps[cps.length - 1].value : null;
  const lastAgg = state.agg[state.agg.length - 1];
  if (lastC != null && lastAgg && lastAgg.t > cps[cps.length - 1].time) cps.push({ time: lastAgg.t, value: lastC });
  // Same time mapping as the main series (strictly increasing).
  let prevT = -Infinity;
  for (const c of cps) { c.time = Math.max(toChartTime(c.time), prevT + 1); prevT = c.time; }
  contribSeries = chart.addSeries(LWC.LineSeries, { color: '#8a93a6', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true, title: 'versamenti', crosshairMarkerVisible: false, priceFormat: usdFormat,
    autoscaleInfoProvider: () => null }); // do not squash the value scale
  contribSeries.setData(cps);
}

function fmtBarTime(t) {
  const iv = INTERVALS[state.interval];
  const d = new Date(t * 1000);
  if (!iv.intraday) return d.toLocaleDateString('it-IT', { timeZone: TZ(), day: '2-digit', month: 'short', year: 'numeric' }) + (iv.sec === 604800 ? ' (sett.)' : '');
  return d.toLocaleString('it-IT', { timeZone: TZ(), day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
/**
 * Chart time of the bar under the crosshair (a tap or the mouse), or null for the latest bar. Kept
 * across live updates, so the legend keeps showing the chosen bar while prices keep flowing; it goes
 * back to the latest bar when the crosshair leaves the chart.
 */
let legendTime = null;
function updateLegend() {
  if (!state.agg.length) { setHtml($('legend'), ''); return; }
  let idx = state.agg.length - 1;
  if (legendTime != null) {
    const j = state.chartTimes.indexOf(legendTime);
    if (j >= 0) idx = j;
  }
  const b = state.agg[idx];
  const prev = idx > 0 ? state.agg[idx - 1].c : b.o;
  const ch = b.c - prev;
  const base = state.agg[periodStartIndex()].o; // "dall'inizio" of the selected period
  const k = (lbl, v) => `<span class="muted">${lbl}</span> <span class="num">${fmtUsd(v)}</span>`;
  setHtml($('legend'),
    `<b>${legendTitle()}</b> · <span class="muted">${INTERVAL_LABEL[state.interval]}</span> · ${fmtBarTime(b.t)}<br>` +
    [k('A', b.o), k('Max', b.h), k('Min', b.l), k('C', b.c)].join(' &nbsp;') +
    ` &nbsp;<span class="num ${cls(ch)}">${fmtSigned(ch)} (${fmtPct(prev ? ch / prev : 0)})</span>` +
    ` &nbsp;<span class="muted">dall'inizio</span> <span class="num ${cls(b.c - base)}">${fmtPct(base ? b.c / base - 1 : 0)}</span>` + soloLegend(b) + realLegend(idx, b) + flowLegend(idx) + markerLegend(idx) + indicatorLegend(idx));
}
function soloLegend(b) {
  const p = soloPosition();
  if (!p) return '';
  if (!(p.cost > 0)) return ` <br><span class="muted">PMC $0 (costo zero)</span>`;
  const pmc = p.cost / p.qty, px = b.c / p.qty;
  return `<br><span style="color:#f0b429">PMC ${fmtPrice(pmc)}</span> · <span class="muted">prezzo</span> <span class="num">${fmtPrice(px)}</span>` +
    ` · <span class="muted">sul PMC</span> <span class="num ${cls(px - pmc)}">${fmtPct(px / pmc - 1)}</span>`;
}
/** In "current positions" mode: the day from which the chart is the real value of the view, or close to it. */
function exactSinceText() {
  const ranges = state.agg.length ? realMatchRanges() : null;
  if (ranges && ranges.length) {
    // the bands that reach today: the exact one, then the near ones right before it
    let k = ranges.length - 1;
    const parts = [];
    if (ranges[k].kind === 'exact') { parts.push(`uguale al reale dal ${fmtBarDay(exactBandDay(ranges[k].from))}`); }
    let from = ranges[k].from;
    while (k > 0 && ranges[k - 1].to === from - 1) from = ranges[--k].from;
    if (!parts.length || from < ranges[ranges.length - 1].from) parts.push(`entro ${Math.round(REAL_TOLERANCE * 100)}%${parts.length ? '' : ' del reale'} dal ${fmtBarDay(state.agg[from].t)}`);
    return `</b> <span class="muted">· ${parts.join(' · ')}</span><b>`;
  }
  const d = positionsExactSince();
  return d ? `</b> <span class="muted">· uguale al reale dal ${fmtBarDay(localDayTs(d))}</span><b>` : '';
}
function legendTitle() {
  if (state.scope === 'custom') {
    const s = [...state.custom];
    return (s.length <= 4 ? s.map(esc).join(' + ') : `${s.length} simboli`) + exactSinceText();
  }
  const t = { all: 'Tutto il portafoglio', broker: BROKER, crypto: 'Crypto' }[state.scope];
  return state.aggMeta && state.aggMeta.real ? esc(t) + ' · storico reale' : esc(t) + exactSinceText();
}
chart.subscribeCrosshairMove((param) => { legendTime = param && param.time != null ? param.time : null; updateLegend(); });

/* ------------------------------------------------------------------ real history */
/** Daily real values for a scope from the brief's history, or null if not available. */
function realHistory(scope) {
  const h = state.snap.history;
  if (!h || !h.dates || !h.dates.length) return null;
  let vals;
  if (scope === 'all') vals = h.value;
  else if (scope === 'broker' && h[BK]) vals = h[BK];
  else if (scope === 'crypto' && h[BK]) vals = h.value.map((v, i) => (v == null || h[BK][i] == null) ? null : v - h[BK][i]);
  else return null;
  const out = [];
  for (let i = 0; i < h.dates.length; i++) {
    if (vals[i] == null || !isFinite(vals[i])) continue;
    out.push({ t: localDayTs(h.dates[i]), v: vals[i] });
  }
  return out.length ? out : null;
}
function realReason() {
  if (INTERVALS[state.interval].intraday) return 'lo storico reale è giornaliero: usa 1G o 1S';
  if (state.scope === 'custom') return `lo storico reale esiste solo per Tutto, ${BROKER} e Crypto`;
  if (!realHistory(state.scope)) return 'questo file non ha lo storico reale per questa vista (arriva con il prossimo aggiornamento del brief)';
  return '';
}
const realActive = () => state.valueMode === 'real' && !realReason();
/** Resample a list of daily bars to the view interval. */
function resample(bars, sec) {
  const out = [];
  for (const b of bars) {
    const k = bucketStart(b.t, sec);
    const cur = out[out.length - 1];
    if (!cur || cur.t !== k) out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c });
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  return out;
}

/** Rebuild the aggregated series for the current scope, interval and range. */
async function rebuild(fit = true) {
  const seq = ++state.buildSeq;
  const iv = INTERVALS[state.interval];
  const scope = scopePositions();
  const market = scope.filter(isMarketPos);
  const staticPos = staticIncluded() ? scope.filter((p) => !isMarketPos(p)) : [];
  const staticValue = staticPos.reduce((s, p) => s + p.value, 0);
  if (!market.length && !staticPos.length) {
    state.agg = []; state.aggMeta = null; renderSeries(true); showOverlay(state.scope === 'custom' ? 'Seleziona almeno un simbolo' : 'Nessuna posizione'); return;
  }
  showOverlay('Caricamento dati…');
  const end = nowSec();
  let start = iv.intraday ? end - INTRADAY_DAYS * 86400 : MAX_START;
  if (realActive()) return rebuildReal(seq, iv, scope, start, end);
  const results = await Promise.allSettled(market.map((p) => (iv.intraday ? getBars(p, iv.base, start, end) : getDailyHistory(p, start, end))));
  if (seq !== state.buildSeq) return;

  const series = [], missing = [];
  results.forEach((r, i) => {
    const p = market[i];
    if (r.status === 'fulfilled' && r.value.bars.length) series.push({ p, q: p.qty, bars: r.value.bars, src: r.value.src, hourly: iv.intraday || r.value.hourly });
    else missing.push({ p, why: r.status === 'rejected' ? r.reason && r.reason.message : 'nessun dato' });
  });
  const constant = staticValue + missing.reduce((s, m) => s + m.p.qty * priceOf(m.p), 0);
  // Daily bars cannot give the price at local midnight; funds only have daily NAVs anyway.
  refsFromSeries(series.filter((x) => x.hourly || x.p.kind === 'fund'), ensureDay());
  // Max starts when every symbol of the view has a history; the other periods, as before, keep a younger
  // symbol at its first price before that, so the history reaches at least 5 years back (all of it if shorter).
  const allFrom = series.length ? Math.max(...series.map((s) => s.bars[0].t)) : start;
  if (!iv.intraday) start = Math.max(start, Math.min(allFrom, end - RANGE_DAYS['5Y'] * 86400));
  let agg = aggregate(series, constant, start, iv.sec);
  if (!agg.length) {
    // No history at all (e.g. no proxy and only stocks): show a single flat point at the current value.
    const v = scopeValueNow();
    agg = [{ t: bucketStart(end, iv.sec), o: v, h: v, l: v, c: v }];
  }
  state.agg = agg;
  state.aggMeta = { start, maxFrom: iv.intraday ? start : allFrom, series, staticValue, missing, interval: state.interval };
  hideOverlay();
  renderSeries(fit);
  dirty.chart = true; scheduleFlush();
  showMissingBanner(missing);
}
/**
 * Real value: daily closes from the brief's history (each day's candle opens at the previous
 * close), then, after the last day in the history, the current holdings priced live. The
 * holdings cannot have changed since the history ends, because the brief rebuilds this file
 * whenever they change; CDs and cash are always included because the real value includes them.
 */
async function rebuildReal(seq, iv, scope, start, end) {
  const hist = realHistory(state.scope);
  const lastT = hist[hist.length - 1].t;
  const market = scope.filter(isMarketPos);
  const staticValue = state.scope === 'crypto' ? 0 : scope.filter((p) => !isMarketPos(p)).reduce((s, p) => s + p.value, 0);
  const gapStart = lastT - 7 * 86400;
  const results = await Promise.allSettled(market.map((p) => getBars(p, '1h', gapStart, end)));
  if (seq !== state.buildSeq) return;
  const series = [], missing = [];
  results.forEach((r, i) => {
    const p = market[i];
    if (r.status === 'fulfilled' && r.value.bars.length) series.push({ p, q: p.qty, bars: r.value.bars, src: r.value.src });
    else missing.push({ p, why: r.status === 'rejected' ? r.reason && r.reason.message : 'nessun dato' });
  });
  const constant = staticValue + missing.reduce((s, m) => s + m.p.qty * priceOf(m.p), 0);
  refsFromSeries(series, ensureDay());

  const days = [];
  let prev = null;
  for (const x of hist) {
    if (prev != null && x.t >= start) days.push({ t: x.t, o: prev, h: Math.max(prev, x.v), l: Math.min(prev, x.v), c: x.v });
    prev = x.v;
  }
  if (hist.length) start = hist[0].t; // the whole real history; a period only zooms
  const tail = aggregate(series, constant, lastT + 86400, 86400).filter((b) => b.t > lastT);
  if (tail.length) tail[0].o = prev; // continue from the last real close
  else {
    const v = scopeValueNow(); const k = bucketStart(end, 86400);
    if (k > lastT) tail.push({ t: k, o: prev, h: Math.max(prev, v), l: Math.min(prev, v), c: v });
  }
  if (tail.length) { tail[0].h = Math.max(tail[0].h, tail[0].o); tail[0].l = Math.min(tail[0].l, tail[0].o); }
  state.agg = resample(days.concat(tail), iv.sec);
  state.aggMeta = { start, series, staticValue, missing, interval: state.interval, real: true, lastRealT: lastT };
  hideOverlay();
  renderSeries(true);
  dirty.chart = true; scheduleFlush();
  showMissingBanner(missing);
}
function showMissingBanner(missing) {
  const b = $('banner');
  if (embeddedPreview) return; // keep the preview warning visible
  if (!missing.length) { b.classList.remove('show'); return; }
  const noProxy = !proxyUrl('/');
  const names = missing.map((m) => esc(m.p.symbol)).join(', ');
  b.innerHTML = noProxy
    ? `Storico non disponibile per ${missing.length} simboli (${names}): configura il proxy Yahoo in <b>Impostazioni</b>. Nel grafico sono a valore costante (aggiornato dai prezzi live quando disponibili).`
    : (() => {
        const reasons = [...new Set(missing.map((m) => m.why))];
        return reasons.length === 1
          ? `Storico non disponibile per ${names} (${esc(reasons[0])}). Nel grafico sono a valore costante.`
          : `Storico non disponibile per: ${missing.map((m) => `${esc(m.p.symbol)} (${esc(m.why)})`).join(', ')}. Nel grafico sono a valore costante.`;
      })();
  b.classList.add('show');
}
function showOverlay(t) { $('overlay-text').textContent = t; $('overlay').classList.add('show'); }
function hideOverlay() { $('overlay').classList.remove('show'); }

/** Current value of the scope using the freshest price of every symbol. */
function scopeValueNow() {
  let v = 0;
  for (const p of scopePositions()) {
    if (!isMarketPos(p)) { if (staticIncluded()) v += p.value; continue; }
    v += p.qty * priceOf(p);
  }
  return v;
}
/** Push live prices into the last bar of the chart (or open a new bar when the bucket rolls). */
function applyLiveToChart() {
  if (!state.agg.length || !state.aggMeta) return;
  const iv = INTERVALS[state.interval];
  // Value now: symbols with history use the live price if newer than their last bar, else their last close.
  const m = state.aggMeta;
  if (m.interval !== state.interval) return; // a rebuild for another interval is in flight
  let v = m.staticValue, freshest = 0;
  for (const x of m.missing) {
    v += x.p.qty * priceOf(x.p);
    const lv = state.live[x.p.symbol]; if (lv) freshest = Math.max(freshest, lv.t);
  }
  for (const s of m.series) {
    // Same price as the KPIs and the table: newest of live tick and any fetched bar.
    v += s.q * priceOf(s.p);
    const lv = state.live[s.p.symbol];
    if (lv) freshest = Math.max(freshest, lv.t);
  }
  const k = bucketStart(nowSec(), iv.sec);
  const last = state.agg[state.agg.length - 1];
  if (k > last.t) {
    if (freshest < k) return; // nothing traded in this bucket yet (e.g. stocks outside market hours)
    const nb = { t: k, o: last.c, h: Math.max(last.c, v), l: Math.min(last.c, v), c: v };
    const ct = Math.max(toChartTime(k), state.chartTimes[state.chartTimes.length - 1] + 1);
    state.agg.push(nb); state.chartTimes.push(ct);
    mainSeries.update(toSeriesPoint(nb, ct));
    updateRealLineTail();
    updateIndicatorsTail();
    renderFlowLines(); // flows booked after the last bar now land on the new one
  } else if (k === last.t) {
    last.c = v; last.h = Math.max(last.h, v); last.l = Math.min(last.l, v);
    mainSeries.update(toSeriesPoint(last, state.chartTimes[state.chartTimes.length - 1]));
    updateRealLineTail();
    updateIndicatorsTail();
  }
  updateLegend();
  updatePeriodKpi();
}

/* ------------------------------------------------------------------ risk: expected shortfall */
/*
 * One-day historical expected shortfall at 95%, the same method as the Portfolio Brief
 * (analytics.risk, var_lookback_days 250): daily simple returns of every symbol over the last
 * 250 days in which all of them have a price, applied to the values at the start of today
 * (qty x reference price of the day change); ES = mean of the P&L at or below the 5% quantile.
 * The grid is New York trading days when the view holds stocks or funds (crypto takes its UTC
 * close of that date), calendar days when it holds crypto only, which trades on weekends too.
 * Days not yet closed when the history was read are left out.
 */
const ES_LOOKBACK = 250, ES_ALPHA = 0.05, ES_MIN_DAYS = 60, ES_FETCH_DAYS = 420;
const utcDate = (tSec) => new Date(tSec * 1000).toISOString().slice(0, 10);
// cut*: dates the loaded closes stop before; want*: dates of the latest load, finished or still running.
const risk = { seq: 0, cutNy: null, cutUtc: null, wantNy: null, wantUtc: null, closes: null };
/** Daily closes of every market position, keyed by date (UTC date of the bar: equal to the New York date for stocks and funds). */
async function loadRiskHistory() {
  const seq = ++risk.seq;
  const now = nowSec();
  const cutNy = nyParts(now).date, cutUtc = utcDate(now);
  risk.wantNy = cutNy; risk.wantUtc = cutUtc;
  const list = positions().filter(isMarketPos);
  const res = await Promise.allSettled(list.map((p) => getBars(p, '1d', now - ES_FETCH_DAYS * 86400, now)));
  if (seq !== risk.seq) return; // a newer load (snapshot, day rollover) is in flight
  const closes = new Map();
  list.forEach((p, i) => {
    const r = res[i];
    const bars = r.status === 'fulfilled' ? r.value.bars : [];
    if (!bars.length) return;
    const m = new Map();
    for (const b of bars) if (isFinite(b.c) && b.c > 0) m.set(utcDate(b.t), b.c);
    closes.set(p.symbol, m);
  });
  Object.assign(risk, { cutNy, cutUtc, closes });
  scheduleFlush();
}
/** Reload when a day closes: a new New York date (trading grid) or a new UTC date (crypto closes). */
function riskStale(tSec = nowSec()) {
  return risk.wantNy != null && (nyParts(tSec).date !== risk.wantNy || utcDate(tSec) !== risk.wantUtc);
}
/** numpy.quantile with the default linear interpolation, on an ascending array. */
function quantileSorted(a, q) {
  const pos = q * (a.length - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, a.length - 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
/**
 * The part of the ES that does not depend on today's prices: the date grid, the forward-filled closes
 * and each symbol's daily return on every day where all of them have one. It only changes with the
 * loaded history, the snapshot and the view, so it is kept between calls (esStats runs on every tick).
 */
const esCache = { key: null, closes: null, snap: null, base: null };
function esReturns(held, cryptoOnly) {
  const cut = cryptoOnly ? risk.cutUtc : risk.cutNy;
  const key = cut + '|' + held.map((p) => p.symbol).join(',');
  if (esCache.closes === risk.closes && esCache.snap === state.snap && esCache.key === key) return esCache.base;
  const grid = new Set();
  for (const p of held) {
    if (!cryptoOnly && p.kind === 'crypto') continue;
    for (const d of risk.closes.get(p.symbol).keys()) if (d < cut) grid.add(d);
  }
  const dates = [...grid].sort();
  // Last close on or before each grid date (forward fill), per symbol.
  const filled = held.map((p) => {
    const m = risk.closes.get(p.symbol);
    const own = [...m.keys()].sort();
    const out = new Array(dates.length).fill(null);
    let j = -1;
    for (let i = 0; i < dates.length; i++) {
      while (j + 1 < own.length && own[j + 1] <= dates[i]) j++;
      if (j >= 0) out[i] = m.get(own[j]);
    }
    return out;
  });
  const rets = [], days = [];
  for (let i = 1; i < dates.length; i++) {
    const r = new Array(held.length);
    let ok = true;
    for (let k = 0; k < held.length; k++) {
      const a = filled[k][i - 1], b = filled[k][i];
      if (a == null || b == null) { ok = false; break; }
      r[k] = b / a - 1;
    }
    if (ok) { rets.push(r); days.push(dates[i]); }
  }
  Object.assign(esCache, { key, closes: risk.closes, snap: state.snap, base: { rets, days } });
  return esCache.base;
}
/** ES and VaR (positive numbers, USD) of the market positions in the current view, or null. */
function esStats() {
  if (!risk.closes) return null;
  const all = scopePositions().filter(isMarketPos);
  const held = all.filter((p) => risk.closes.has(p.symbol) && p.qty);
  if (!held.length) return null;
  const missing = all.filter((p) => !risk.closes.has(p.symbol)).map((p) => p.symbol);
  const cryptoOnly = held.every((p) => p.kind === 'crypto');
  const { rets, days } = esReturns(held, cryptoOnly);
  const V = held.map((p) => p.qty * (prevOf(p) || priceOf(p)));
  // Same sum, in the same order, as before the returns were cached: the results are identical.
  const pnl = rets.map((r) => {
    let v = 0;
    for (let k = 0; k < r.length; k++) v += V[k] * r[k];
    return v;
  });
  const n = Math.min(pnl.length, ES_LOOKBACK);
  if (n < ES_MIN_DAYS) return null;
  const tail = pnl.slice(-n), sorted = [...tail].sort((x, y) => x - y);
  const q = quantileSorted(sorted, ES_ALPHA);
  const worst = sorted.filter((x) => x <= q);
  const es = -worst.reduce((s, x) => s + x, 0) / worst.length;
  return { es, var: -q, n, from: days[days.length - n], to: days[days.length - 1], base: V.reduce((s, x) => s + x, 0), cryptoOnly, missing };
}
/** Today's loss as a share of the expected shortfall, next to the day change. */
function renderEs(day) {
  const box = $('k-es-box'), el = $('k-es');
  const st = esStats();
  if (!st || !(st.es > 0)) {
    setText(el, '—');
    setTitle(box, risk.closes ? 'Expected shortfall non disponibile: storico dei prezzi insufficiente per le posizioni di questa vista.'
      : 'Expected shortfall in calcolo: sto leggendo lo storico giornaliero dei prezzi.');
    return;
  }
  const esTxt = fmtUsd(-st.es);
  if (day < 0) {
    const loss = -day, ratio = loss / st.es;
    const c = ratio >= 1 ? 'down' : loss >= st.var ? 'warn' : '';
    setHtml(el, `<span class="${c}">${(ratio * 100).toFixed(0)}%</span> <span class="muted">di ${esTxt}</span>`);
  } else {
    setHtml(el, `<span class="muted">ES ${esTxt}</span>`);
  }
  const fmtD = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  setTitle(box, [
    `Perdita di oggi in percentuale dell'expected shortfall al 95% a 1 giorno: la perdita media nel 5% dei giorni peggiori.`,
    `ES ${esTxt} (${fmtPct(-st.es / st.base)}), VaR 95% ${fmtUsd(-st.var)} (${fmtPct(-st.var / st.base)}).`,
    `Simulazione storica come nel Portfolio Brief: rendimenti giornalieri di ${st.n} ${st.cryptoOnly ? 'giorni di calendario' : 'giorni di borsa'} (${fmtD(st.from)} – ${fmtD(st.to)}) applicati alle posizioni di inizio giornata (${fmtUsd(st.base)}, CD e liquidità esclusi perché senza rischio di prezzo).`,
    `Giallo: perdita oltre il VaR. Rosso: oltre l'ES.`,
    st.cryptoOnly ? '' : `La variazione del giorno parte dalla mezzanotte: nel weekend e nei festivi si muovono solo le crypto, mentre l'ES è su un giorno di borsa intero.`,
    st.missing.length ? `Senza storico, quindi esclusi (ES sottostimato): ${st.missing.join(', ')}.` : '',
  ].filter(Boolean).join('\n'));
}

/* ------------------------------------------------------------------ KPIs and table */
function updateKpis() {
  const scope = scopePositions();
  let value = 0, day = 0, pnl = 0, prevVal = 0;
  for (const p of scope) {
    if (!isMarketPos(p)) {
      if (!staticIncluded()) continue;
      value += p.value; pnl += p.value - p.cost; prevVal += p.value; continue;
    }
    const px = priceOf(p), pv = prevOf(p);
    value += p.qty * px; pnl += p.qty * px - p.cost;
    if (pv) { day += p.qty * (px - pv); prevVal += p.qty * pv; } else prevVal += p.qty * px;
  }
  let total = 0;
  for (const p of positions()) total += isMarketPos(p) ? p.qty * priceOf(p) : p.value;
  setText($('k-scope-lbl'), SCOPE_LABEL[state.scope]);
  setText($('k-value'), fmtUsd(value, 2));
  const eurRate = BOOT.eurRate ? BOOT.eurRate() : null;
  setText($('k-value-eur'), eurRate ? fmtEur(value / eurRate) : '');
  setHtml($('k-day'), `<span class="${cls(day)}">${fmtSigned(day)} (${fmtPct(prevVal ? day / prevVal : 0)})</span>`);
  renderEs(day);
  setHtml($('k-pnl'), `<span class="${cls(pnl)}">${fmtSigned(pnl)} (${fmtPct(value - pnl ? pnl / (value - pnl) : 0)})</span>`);
  const realized = state.snap.closed != null || isFinite(state.snap.realized) ? scopeRealized() : null;
  setHtml($('k-closed'), realized == null ? '—' : `<span class="${cls(realized)}">${fmtSigned(realized)}</span>`);
  renderPnlBreakdown();
  renderIrr();
  renderTwr();
  renderBench();
  setText($('k-weight'), total ? (value / total * 100).toFixed(1) + '%' + (state.scope === 'all' ? '' : ` di ${fmtUsd(total)}`) : '—');
  renderNetWorth(total);
  document.title = `${fmtUsd(value)} · Portfolio Tracker`;
}
/** Whole portfolio at live prices (CD and cash included, whatever the view) plus the bank accounts from Wallet. */
const fmtEur = (v) => (v == null || !isFinite(v)) ? '' : (v < 0 ? '−€' : '€') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function renderNetWorth(portfolioTotal) {
  const bank = BOOT.bankTotalUsd ? BOOT.bankTotalUsd() : null;
  const box = $('k-nw-box');
  box.hidden = bank == null;
  if (bank == null) return;
  const total = portfolioTotal + bank;
  const eurRate = BOOT.eurRate ? BOOT.eurRate() : null;
  const invested = total > 0 ? `${(portfolioTotal / total * 100).toFixed(1)}% investito` : '';
  setText($('k-nw'), fmtUsd(total, 2));
  setText($('k-nw-sub'), [eurRate ? fmtEur(total / eurRate) : '', invested].filter(Boolean).join(' · '));
  setTitle(box, `Investimenti ${fmtUsd(portfolioTotal, 2)} a prezzi in tempo reale (CD e liquidità inclusi) + conti ${fmtUsd(bank, 2)}` +
    (eurRate ? `. Euro al cambio EURUSD ${eurRate.toFixed(4)}` : '') + (invested ? `. Quota investita: ${invested.replace(' investito', '')} del patrimonio` : ''));
}
/** Closed positions relevant to the current view (all of them are broker lines). */
function scopeClosed() {
  const closed = state.snap.closed || [];
  if (state.scope === 'crypto') return closed.filter((c) => (bySym(c.symbol) || {}).kind === 'crypto');
  if (state.scope === 'custom') return closed.filter((c) => state.custom.has(c.symbol));
  return closed;
}
function scopeRealized() {
  const rows = scopeClosed();
  if ((state.scope === 'all' || state.scope === 'broker') && isFinite(state.snap.realized)) return state.snap.realized;
  return rows.reduce((s, c) => s + (c.pnl || 0), 0);
}
function renderClosed() {
  const rows = [...scopeClosed()].sort((a, b) => Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0));
  const tot = scopeRealized();
  const has = state.snap.closed != null;
  setHtml($('closed-sum'), has
    ? `Posizioni chiuse · <b>${rows.length}</b> ${rows.length === 1 ? 'linea' : 'linee'} · P&amp;L <b class="${cls(tot)}">${fmtSigned(tot, 2)}</b>`
    : 'Posizioni chiuse · non presenti in questo snapshot');
  setHtml($('closed-body'), rows.length ? rows.map((c) => `<tr>
      <td class="l sym">${esc(c.symbol)}</td><td class="num">${fmtQty(c.qty)}</td><td class="num">${fmtUsd(c.proceeds, 2)}</td>
      <td class="num">${fmtUsd(c.cost, 2)}</td><td class="num ${cls(c.pnl)}">${fmtSigned(c.pnl, 2)}</td>
      <td class="num">${c.held ? '<span class="muted">in posizioni</span>' : fmtUsd(c.dividends || 0, 2)}</td>
      <td class="num">${c.held ? '<span class="muted">in posizioni</span>' : fmtUsd(c.interest || 0, 2)}</td>
      <td class="num">${esc(c.last || '—')}</td></tr>`).join('')
    : `<tr><td class="l muted" colspan="8">${has ? 'Nessuna posizione chiusa in questa vista' : 'Importa uno snapshot recente per vederle'}</td></tr>`);
}
/**
 * P&L components for the current view. Open P&L is live; the rest comes from the brief.
 * Fees are tracked per account, not per symbol, so they are left out of a custom selection.
 */
function pnlParts() {
  const scope = scopePositions();
  let open = 0, openCost = 0;
  for (const p of scope) {
    if (!isMarketPos(p)) { if (staticIncluded()) { open += p.value - p.cost; openCost += p.cost; } continue; }
    open += p.qty * priceOf(p) - p.cost; openCost += p.cost;
  }
  const inc = state.snap.income || null;
  const ibs = state.snap.income_by_symbol || {};
  let div = 0, int = 0, fees = 0;
  if (state.scope === 'all' || state.scope === 'broker') {
    div = inc ? inc.dividends : NaN; int = inc ? inc.interest : NaN; fees = inc ? inc.fees : NaN;
  } else if (state.scope === 'custom') {
    for (const sym of state.custom) { const x = ibs[sym]; if (x) { div += x.div || 0; int += x.int || 0; } }
    fees = null;
  }
  const closed = state.snap.closed != null || isFinite(state.snap.realized) ? scopeRealized() : NaN;
  const parts = [
    { k: 'open', l: 'P&L aperto', v: open, c: '#2962ff' },
    { k: 'closed', l: 'P&L chiuso', v: closed, c: '#26a69a' },
    { k: 'div', l: 'Dividendi e distribuzioni', v: div, c: '#7e57c2' },
    { k: 'int', l: 'Interessi', v: int, c: '#f0b429' },
    { k: 'fees', l: 'Commissioni', v: fees == null ? null : -fees, c: '#ef5350' },
  ];
  const known = parts.filter((x) => x.v != null && isFinite(x.v));
  const total = known.reduce((s, x) => s + x.v, 0);
  const closedCost = scopeClosed().reduce((s, c) => s + (isFinite(c.cost) ? c.cost : 0), 0);
  return { parts, total, complete: known.length === parts.length, invested: openCost + closedCost };
}
function renderPnlBreakdown() {
  const { parts, total, complete, invested } = pnlParts();
  const contrib = state.scope === 'all' ? (state.snap.contrib_net ?? (state.snap.history && state.snap.history.contrib ? state.snap.history.contrib[state.snap.history.contrib.length - 1] : null)) : null;
  // Return base: net contributions for the whole portfolio, otherwise the cost basis of open plus closed lines.
  const base = contrib || invested;
  const baseLbl = contrib ? 'sui versamenti netti' : 'sul costo investito (posizioni aperte + chiuse)';
  setHtml($('k-total'), `<span class="${cls(total)}">${fmtSigned(total)}${base ? ` (${fmtPct(total / base)})` : ''}</span>`);
  setTitle($('k-total').parentElement, (complete ? 'P&L aperto + P&L chiuso + dividendi + interessi − commissioni'
    : 'Le commissioni sono per conto, non per titolo: nella selezione di simboli sono escluse') +
    (base ? `\nPercentuale ${baseLbl}: ${fmtUsd(base)}` : ''));
  const gross = parts.reduce((s, x) => s + (x.v != null && isFinite(x.v) ? Math.abs(x.v) : 0), 0) || 1;
  setHtml($('pnl-bar'), parts.filter((x) => x.v != null && isFinite(x.v) && x.v !== 0)
    .map((x) => `<span title="${x.l}: ${fmtSigned(x.v, 2)}" style="width:${(Math.abs(x.v) / gross * 100).toFixed(2)}%;background:${x.c};opacity:${x.v < 0 ? 0.55 : 1}"></span>`).join(''));
  const share = (v) => total ? (v / total * 100).toFixed(1).replace('-', '−') + '%' : '—';
  setHtml($('pnl-items'), parts.map((x) => {
    const ok = x.v != null && isFinite(x.v);
    return `<span class="it"><span class="sw" style="background:${x.c}"></span><span class="muted">${x.l}</span>
      <span class="num ${ok ? cls(x.v) : ''}">${ok ? fmtSigned(x.v) : (x.k === 'fees' && state.scope === 'custom' ? 'non attribuibili' : '—')}</span>
      <span class="num muted">${ok ? share(x.v) : ''}</span></span>`;
  }).join('') + `<span class="it eq">= <b class="num ${cls(total)}">${fmtSigned(total)}</b>${complete ? '' : ' <span class="muted">(senza commissioni)</span>'}</span>`);
}
/* ------------------------------------------------------------------ money-weighted return (XIRR) */
const DAY_MS = 86400000;
const YEAR_DAYS = 365.25; // same year length as the brief's xirr()
const isoDayMs = (iso) => Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
/**
 * Annual rate r that makes the present value of the cash flows zero:
 *   sum_i a_i / (1 + r)^(years from the first flow to flow i) = 0
 * cfs: [{ t: epoch ms, a: amount }] from the investor's view (money put in < 0, value today > 0).
 * Bisection on [-99%, +500%] like the brief; null when the NPV does not change sign there.
 */
function xirr(cfs) {
  if (cfs.length < 2) return null;
  const t0 = cfs.reduce((m, c) => Math.min(m, c.t), Infinity);
  const npv = (r) => cfs.reduce((s, c) => s + c.a / Math.pow(1 + r, (c.t - t0) / DAY_MS / YEAR_DAYS), 0);
  let lo = -0.99, hi = 5, fLo = npv(lo);
  if (!isFinite(fLo) || fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 100 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2, fMid = npv(mid);
    if (fLo * fMid <= 0) hi = mid; else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}
/**
 * External flows of the current view, money in > 0: { list: [{ d: 'YYYY-MM-DD', a }], src } or { why }.
 * The brief (0.8.0+) sends them per account; older snapshots only have the cumulative net
 * contributions of the whole portfolio, whose day-by-day changes are the same flows moved to trading days.
 */
function scopeFlows() {
  if (state.scope === 'custom') return { why: 'I flussi di cassa sono per conto, non per titolo: il TIR di una selezione di simboli non è calcolabile' };
  const f = state.snap.flows;
  if (f) {
    const am = (f[BK] || []).map(([d, a]) => ({ d, a }));
    const cr = (f.crypto || []).map(([d, , a]) => ({ d, a }));
    return { list: state.scope === 'broker' ? am : state.scope === 'crypto' ? cr : am.concat(cr), src: 'flussi del Portfolio Brief' };
  }
  const h = state.snap.history;
  if (state.scope === 'all' && h && h.contrib && h.contrib.length) {
    const list = [];
    let prev = 0;
    h.dates.forEach((d, i) => {
      const c = h.contrib[i];
      if (c == null || !isFinite(c)) return;
      if (Math.abs(c - prev) >= 0.005) list.push({ d, a: c - prev });
      prev = c;
    });
    // flows booked after the last history day (e.g. a weekend deposit) are only in the snapshot's total
    const tail = state.snap.contrib_net;
    if (tail != null && isFinite(tail) && Math.abs(tail - prev) >= 0.005) list.push({ d: state.snap.asof, a: tail - prev });
    return { list, src: 'variazioni dei contributi netti nella serie storica' };
  }
  return { why: 'Questo snapshot non ha i flussi per conto: arrivano con il Portfolio Brief 0.8.0' };
}
/** Live XIRR of the current view: every external flow on its date, today's value (cash and CDs included) as the final inflow. */
function irrStats() {
  const sf = scopeFlows();
  if (!sf.list || !sf.list.length) return { why: sf.why || 'Nessun flusso di cassa in questa vista' };
  let value = 0;
  for (const p of scopePositions()) value += isMarketPos(p) ? p.qty * priceOf(p) : p.value;
  const now = Date.now();
  const cfs = sf.list.map((x) => ({ t: isoDayMs(x.d), a: -x.a })).filter((c) => isFinite(c.t));
  cfs.push({ t: now, a: value });
  const first = sf.list.reduce((m, x) => (x.d < m ? x.d : m), sf.list[0].d);
  return { r: xirr(cfs), first: String(first).slice(0, 10), years: (now - isoDayMs(first)) / DAY_MS / YEAR_DAYS,
           net: sf.list.reduce((s, x) => s + x.a, 0), n: sf.list.length, value, src: sf.src };
}
function renderIrr() {
  const el = $('k-irr'), box = el.parentElement;
  const st = irrStats();
  const m = state.snap.mwr;
  const refKey = { all: 'total', broker: BK, crypto: 'crypto' }[state.scope];
  const ref = m && refKey && m[refKey] != null && isFinite(m[refKey]) ? m[refKey] : null;
  const refAsof = (m && m.asof) || state.snap.asof;
  if (st.why) {
    setHtml(el, ref == null ? '—' : `<span class="${cls(ref)}">${fmtPct(ref)}</span><span class="muted">/anno al ${esc(refAsof)}</span>`);
    setTitle(box, st.why + (ref == null ? '' : `\nValore del Portfolio Brief al ${refAsof}, non aggiornato con i prezzi live`));
    return;
  }
  const short = st.years < 1;
  setHtml(el, st.r == null ? '—'
    : `<span class="${cls(st.r)}">${fmtPct(st.r)}</span><span class="muted">/anno${short ? ' (meno di 1 anno)' : ''}</span>` +
      (ref == null ? '' : ` <span class="muted">· brief ${fmtPct(ref)}</span>`));
  setTitle(box, [
    'Tasso interno di rendimento (money-weighted): il tasso annuo a cui versamenti e prelievi, ciascuno alla sua data, valgono oggi quanto il portafoglio. Pesa di più i periodi in cui c\'era più denaro investito.',
    `Dal ${st.first} (${st.years.toFixed(1).replace('.', ',')} anni) · ${st.n} ${st.n === 1 ? 'flusso' : 'flussi'} · versato netto ${fmtUsd(st.net)} · valore oggi ${fmtUsd(st.value)}`,
    'Il valore include liquidità e CD anche se nascosti. Fonte dei flussi: ' + st.src + '.',
    ref == null ? '' : `Portfolio Brief al ${refAsof}: ${fmtPct(ref)}/anno (prezzi di chiusura di quel giorno).`,
    short ? 'Su meno di un anno il tasso annualizzato amplifica le oscillazioni: va letto con cautela.' : '',
    st.r == null ? 'Nessun tasso tra −99% e +500% annuo azzera i flussi.' : '',
  ].filter(Boolean).join('\n'));
}
/* ------------------------------------------------------------------ time-weighted return (TWR) */
/** Value series of the current view from the snapshot's daily history; null when the history cannot isolate it. */
function scopeHistoryValues(h) {
  if (state.scope === 'all') return h.value;
  if (!h[BK]) return null;
  if (state.scope === 'broker') return h[BK];
  if (state.scope === 'crypto') return h.value.map((v, i) => (v == null || h[BK][i] == null ? null : v - h[BK][i]));
  return null;
}
/** Index of the first ISO date in the sorted array that is >= d (dates.length when none). */
function firstOnOrAfter(dates, d) {
  let lo = 0, hi = dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < d) lo = mid + 1; else hi = mid; }
  return lo;
}
/**
 * TWR index of the current view over the snapshot's history, chained day by day with the brief's
 * modified Dietz formula: r = (V_t - V_t-1 - F_t) / (V_t-1 + F_t / 2), F_t = net external flows of day t.
 * Broker flows come per history day from the brief (history['flow_' + BK], 0.8.1+), where
 * securities received enter at market value; crypto lots land on the first history day on or after
 * their date. Flows dated after the last history day are kept for the live step.
 * Depends only on the snapshot and the view, so it is cached.
 */
const twrCache = { snap: null, scope: null, base: null };
function twrBase() {
  if (twrCache.snap !== state.snap || twrCache.scope !== state.scope) {
    twrCache.snap = state.snap; twrCache.scope = state.scope; twrCache.base = buildTwrBase();
  }
  return twrCache.base;
}
function buildTwrBase() {
  if (state.scope === 'custom') return { why: 'La serie storica e i flussi sono per conto, non per titolo: il TWR di una selezione di simboli non è calcolabile' };
  const h = state.snap.history;
  if (!h || !h.dates || !h.dates.length || !h.value) return { why: 'Lo snapshot non contiene la serie storica del valore' };
  const vals = scopeHistoryValues(h);
  if (!vals) return { why: `La serie storica di questo snapshot non separa ${BROKER} e crypto` };
  const f = state.snap.flows;
  if (!f || !h['flow_' + BK] || h['flow_' + BK].length !== h.dates.length) {
    return { why: 'Questo snapshot non ha i flussi giornalieri della serie storica: arrivano con il Portfolio Brief 0.8.1. Senza, i titoli ricevuti in regalo sembrerebbero rendimento.' };
  }
  const dates = h.dates.map((d) => String(d).slice(0, 10));
  const n = dates.length, flow = new Array(n).fill(0), lastDay = dates[n - 1];
  let pending = 0;
  if (state.scope !== 'crypto') {
    h['flow_' + BK].forEach((a, i) => { flow[i] += a || 0; });
    for (const [d, a] of f[BK] || []) if (String(d).slice(0, 10) > lastDay) pending += a;
  }
  if (state.scope !== 'broker') {
    for (const [d, , a] of f.crypto || []) {
      const i = firstOnOrAfter(dates, String(d).slice(0, 10));
      if (i < n) flow[i] += a; else pending += a;
    }
  }
  const idx = new Array(n).fill(null);
  let level = 1, prev = null, start = -1, last = -1, carry = 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    // A day without a value keeps its flow for the next day that has one: dropped, the money would
    // count as return in the next step.
    if (v == null || !isFinite(v)) { carry += flow[i]; continue; }
    const fl = flow[i] + carry;
    carry = 0;
    if (prev != null && prev + fl / 2 > 1) level *= 1 + (v - prev - fl) / (prev + fl / 2);
    if (start < 0 && (v > 1 || fl > 0)) start = i;
    if (start >= 0) idx[i] = level;
    prev = v; last = i;
  }
  pending += carry; // flows after the last day with a value belong to the live step
  if (start < 0) return { why: 'Nessun valore investito in questa vista' };
  return { dates, idx, start, last, lastValue: vals[last], level, pending };
}
/** Live TWR: the cached history index times one more modified Dietz step from the last history close to the live value. */
function twrStats() {
  const b = twrBase();
  if (b.why) return b;
  let value = 0;
  for (const p of scopePositions()) value += isMarketPos(p) ? p.qty * priceOf(p) : p.value;
  const den = b.lastValue + b.pending / 2;
  const step = den > 1 ? (value - b.lastValue - b.pending) / den : 0;
  const now = Date.now(), I = b.level * (1 + step);
  const since = (iso) => { // TWR from the close of the last history day before iso
    let i = firstOnOrAfter(b.dates, iso) - 1;
    while (i >= 0 && b.idx[i] == null) i--;
    return i >= b.start ? I / b.idx[i] - 1 : null;
  };
  const year = tzParts(now / 1000).y; // the current year in the selected time zone
  const years = (now - isoDayMs(b.dates[b.start])) / DAY_MS / YEAR_DAYS;
  const yearAgo = new Date(now - 365 * DAY_MS).toISOString().slice(0, 10);
  return { total: I - 1, ann: years > 0.5 ? Math.pow(I, 1 / years) - 1 : null, years, first: b.dates[b.start],
           ytd: since(`${year}-01-01`), y1: since(yearAgo), step, lastDate: b.dates[b.last],
           base: b, ytdFrom: `${year}-01-01`, y1From: yearAgo };
}
function renderTwr() {
  const el = $('k-twr'), box = el.parentElement;
  const t = twrStats();
  if (t.why) { setText(el, '—'); setTitle(box, t.why); return; }
  setHtml(el, t.ann == null
    ? `<span class="${cls(t.total)}">${fmtPct(t.total)}</span><span class="muted"> totale</span>`
    : `<span class="${cls(t.ann)}">${fmtPct(t.ann)}</span><span class="muted">/anno${t.years < 1 ? ' (meno di 1 anno)' : ''} · ${fmtPct(t.total, 1)} totale</span>`);
  setTitle(box, [
    'Rendimento time-weighted: quanto avrebbe reso 1 $ investito dal primo giorno e mai toccato. Toglie l\'effetto di versamenti e prelievi, quindi misura la strategia ed è confrontabile con un indice.',
    `Dal ${t.first} (${t.years.toFixed(1).replace('.', ',')} anni) · YTD ${fmtPct(t.ytd, 1)} · 1 anno ${fmtPct(t.y1, 1)}`,
    `Giorno per giorno con il Dietz modificato del brief fino al ${t.lastDate}, poi un ultimo tratto con i prezzi live: ${fmtPct(t.step)}.`,
    'Il valore include liquidità e CD anche se nascosti. I titoli ricevuti in regalo contano come versamento al valore di mercato, come nel brief.',
  ].join('\n'));
}
/* ------------------------------------------------------------------ benchmark TWR */
/**
 * TWR of the brief's risk-matched benchmark over the same days as the view's TWR. The brief sends
 * its TWR index on the history days (history.bench) and the adjusted closes of the last day; the
 * live step is the weighted move of each ticker since then (a dividend going ex in between is missed
 * until the next snapshot). A TWR ignores the flows, so it compares directly with the portfolio's.
 */
function benchStats(t) {
  const bm = state.snap.benchmark, h = state.snap.history;
  if (!bm || !h || !h.bench || h.bench.length !== h.dates.length) return { why: 'Il benchmark arriva con lo snapshot del Portfolio Brief 0.9.0' };
  if (state.scope === 'crypto' || state.scope === 'custom') return { why: `Il benchmark a pari rischio vale per il portafoglio intero e per il conto ${BROKER}` };
  if (t.why) return { why: t.why };
  const B = h.bench, n = B.length, b = t.base;
  let factor = 0, live = true;
  for (const [sym, w] of Object.entries(bm.weights)) {
    const p0 = bm.last_px && bm.last_px[sym], q = benchLive[sym];
    if (!p0) return { why: 'Prezzi del benchmark mancanti nello snapshot' };
    if (!q) live = false;
    factor += w * (q ? q.price / p0 : 1);
  }
  const I = B[n - 1] * factor;
  const since = (iso) => {
    let i = firstOnOrAfter(b.dates, iso) - 1;
    while (i >= 0 && b.idx[i] == null) i--;
    return i >= b.start && B[i] ? I / B[i] - 1 : null;
  };
  const total = I / B[b.start] - 1;
  return { total, ann: t.years > 0.5 ? Math.pow(1 + total, 1 / t.years) - 1 : null, ytd: since(t.ytdFrom), y1: since(t.y1From),
           step: factor - 1, live, name: bm.name, tickers: Object.keys(bm.weights).join(', '), vol: bm.vol, asof: bm.asof };
}
function renderBench() {
  const el = $('k-bench'), box = el.parentElement;
  const t = twrStats(), k = benchStats(t);
  const bm = state.snap.benchmark;
  setText($('k-bench-lbl'), bm && bm.weights ? `Benchmark ${Object.keys(bm.weights).join('+')} (TWR)` : 'Benchmark (TWR)');
  if (k.why) { setText(el, '—'); setTitle(box, k.why); return; }
  const pt = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + ' pt';
  const diff = t.ann != null && k.ann != null ? t.ann - k.ann : t.total - k.total;
  setHtml(el, (k.ann == null
    ? `<span class="${cls(k.total)}">${fmtPct(k.total)}</span><span class="muted"> totale</span>`
    : `<span class="${cls(k.ann)}">${fmtPct(k.ann)}</span><span class="muted">/anno · ${fmtPct(k.total, 1)} totale</span>`) +
    ` <span class="muted">·</span> <span class="${cls(diff)}">${pt(diff)}</span>`);
  setTitle(box, [
    `${k.name}: il benchmark a pari rischio scelto dal Portfolio Brief${k.vol != null ? ` (volatilità a 3 anni ${fmtPct(k.vol, 1).replace('+', '')})` : ''}. Dividendi reinvestiti, nessuna commissione di consulenza.`,
    `Stesso periodo del TWR, dal ${t.first}. Lo scarto colorato è il TWR ${t.ann != null && k.ann != null ? 'annuo ' : ''}della vista meno quello del benchmark: positivo vuol dire che la gestione ha battuto un ETF passivo con rischio simile.`,
    `YTD: vista ${fmtPct(t.ytd, 1)}, benchmark ${fmtPct(k.ytd, 1)} · 1 anno: vista ${fmtPct(t.y1, 1)}, benchmark ${fmtPct(k.y1, 1)}`,
    `Indice del brief fino al ${k.asof}, poi ${k.live ? 'prezzo live di ' + k.tickers : 'ultimo prezzo dello snapshot (prezzo live non ancora arrivato)'}: ${fmtPct(k.step)}.`,
  ].join('\n'));
}
/** First bar of the selected period (0 for Max): the bar holding the period's start. */
function periodStartIndex() {
  const n = state.agg.length;
  if (!n) return 0;
  const iv = INTERVALS[state.interval];
  const from = state.range === 'MAX' ? state.aggMeta && state.aggMeta.maxFrom : rangeStart(state.range, iv, false);
  if (from == null) return 0;
  const s = bucketStart(from, iv.sec);
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (state.agg[mid].t < s) lo = mid + 1; else hi = mid; }
  return Math.min(lo, n - 1);
}
/** Shows the selected period: a zoom on the loaded history, which stays whole. */
function zoomToRange() {
  const n = state.agg.length;
  if (!n) return;
  chart.timeScale().setVisibleLogicalRange({ from: periodStartIndex() - 0.5, to: n - 1 + chart.timeScale().options().rightOffset });
}
function updatePeriodKpi() {
  if (!state.agg.length) { setText($('k-period'), '—'); return; }
  const a = state.agg[periodStartIndex()].o, z = state.agg[state.agg.length - 1].c;
  setHtml($('k-period'), `<span class="${cls(z - a)}">${fmtSigned(z - a)} (${fmtPct(a ? z / a - 1 : 0)})</span> <span class="muted">${RANGE_LABEL[state.range]}</span>`);
}

const COLS = [
  { k: 'sel', l: '', cls: 'l' },
  { k: 'symbol', l: 'Simbolo', cls: 'l' },
  { k: 'name', l: 'Nome', cls: 'l nm' },
  { k: 'qty', l: 'Qtà' },
  { k: 'price', l: 'Prezzo' },
  { k: 'dayPct', l: 'Giorno' },
  { k: 'pnl', l: 'P&L aperto' },
  { k: 'pnlPct', l: '%' },
  { k: 'value', l: 'Valore' },
  { k: 'weight', l: 'Peso' },
  { k: 'src', l: 'Fonte', cls: 'l' },
];
function rowData(p, scopeTotal) {
  const market = isMarketPos(p);
  const price = market ? priceOf(p) : null;
  const value = market ? p.qty * price : p.value;
  const prev = market ? prevOf(p) : null;
  const lv = state.live[p.symbol];
  return {
    p, symbol: p.symbol, name: p.name, qty: market ? p.qty : null, price,
    dayPct: market && prev ? price / prev - 1 : null, dayUsd: market && prev ? p.qty * (price - prev) : null,
    value, weight: scopeTotal && inScopeNow(p) ? value / scopeTotal : null, pnl: value - p.cost, pnlPct: p.cost ? value / p.cost - 1 : null,
    src: !market ? 'fisso' : lv ? lv.src : 'snapshot', dir: lv ? lv.dir : 0,
    mk: marketStatus(p.kind),
  };
}
function renderTable() {
  renderClosed();
  const showAll = state.scope === 'custom';
  const list = showAll ? positions() : scopePositions();
  const visible = list.filter((p) => isMarketPos(p) || staticIncluded() || showAll);
  const scopeTotal = scopePositions().reduce((s, p) => s + (isMarketPos(p) ? p.qty * priceOf(p) : (staticIncluded() ? p.value : 0)), 0);
  const rows = visible.map((p) => rowData(p, scopeTotal));
  const k = state.sortKey, dir = state.sortDir;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === 'string' || typeof y === 'string') return dir * String(x).localeCompare(String(y));
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  setHtml($('thead'), COLS.map((c) => `<th class="${c.cls || ''}" data-k="${c.k}">${c.l}${state.sortKey === c.k ? (state.sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join(''));
  $('tbody').innerHTML = rows.map((r) => {
    const sel = state.scope === 'custom' ? `<input type="checkbox" data-sym="${esc(r.symbol)}" ${state.custom.has(r.symbol) ? 'checked' : ''}>` : '';
    const srcLbl = { live: 'live', poll: 'Yahoo', snapshot: 'snapshot', fisso: 'fisso' }[r.src] || r.src;
    return `<tr data-row="${esc(r.symbol)}">
      <td class="l">${sel}</td>
      <td class="l sym" data-solo="${esc(r.symbol)}" title="Mostra solo questo simbolo"><span class="mk ${r.mk.open === true ? 'open' : r.mk.open === false ? 'closed' : ''}" title="${esc(r.mk.label)}"></span>${esc(r.symbol)}</td>
      <td class="l nm" title="${esc(r.name)}">${esc(r.name)}</td>
      <td class="num">${fmtQty(r.qty)}</td>
      <td class="num" data-price="${esc(r.symbol)}">${r.price == null ? '—' : fmtPrice(r.price)}</td>
      <td class="num ${cls(r.dayPct)}" title="${r.dayUsd == null ? '' : fmtSigned(r.dayUsd, 2)}">${r.dayPct == null ? '—' : fmtPct(r.dayPct)}</td>
      <td class="num ${cls(r.pnl)}">${fmtSigned(r.pnl)}</td>
      <td class="num ${cls(r.pnlPct)}">${r.pnlPct == null ? '—' : fmtPct(r.pnlPct, 1)}</td>
      <td class="num">${fmtUsd(r.value)}</td>
      <td class="num">${r.weight == null ? '—' : (r.weight * 100).toFixed(1) + '%'}</td>
      <td class="l"><span class="src ${esc(r.src)}">${esc(srcLbl)}</span></td></tr>`;
  }).join('');
  const tv = rows.filter((r) => !showAll || state.custom.has(r.symbol));
  const sum = (f) => tv.reduce((s, r) => s + (r[f] || 0), 0);
  setHtml($('tfoot'), `<tr><td></td><td class="l"><b>Totale</b></td><td class="nm"></td><td></td><td></td>
    <td class="num ${cls(sum('dayUsd'))}">${fmtSigned(sum('dayUsd'))}</td><td class="num ${cls(sum('pnl'))}">${fmtSigned(sum('pnl'))}</td><td></td>
    <td class="num"><b>${fmtUsd(sum('value'))}</b></td><td></td><td></td></tr>`);
}
/** Cheap in-place refresh of prices for the symbols that ticked, with a flash. */
function flashPrices(syms) {
  for (const s of syms) {
    const cell = document.querySelector(`[data-price="${CSS.escape(s)}"]`);
    if (!cell) continue;
    const lv = state.live[s];
    cell.classList.remove('flash-up', 'flash-down');
    void cell.offsetWidth;
    if (lv && lv.dir) cell.classList.add(lv.dir > 0 ? 'flash-up' : 'flash-down');
  }
}

/* ------------------------------------------------------------------ render loop */
const dirty = { table: new Set(), chart: false };
let flushPending = false, lastTableRender = 0;
function scheduleFlush() {
  // In the background nothing is drawn: prices keep arriving into state.live and the dirty marks
  // wait, then the visibilitychange handler flushes them all at once.
  if (flushPending || document.hidden) return;
  flushPending = true;
  setTimeout(() => {
    flushPending = false;
    if (dirty.chart) { dirty.chart = false; applyLiveToChart(); }
    updateKpis();
    if (dirty.table.size && Date.now() - lastTableRender > 1000) {
      const syms = [...dirty.table]; dirty.table.clear();
      lastTableRender = Date.now();
      renderTable(); flashPrices(syms);
    } else if (dirty.table.size) scheduleFlush();
  }, 250);
}

/* ------------------------------------------------------------------ toolbar */
function renderSeg(id, items, current, onPick) {
  const el = $(id);
  el.innerHTML = items.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(current) ? 'on' : ''}">${l}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
}
function markSeg(id, current) { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(current)); }
function renderToolbar() {
  markSeg('seg-scope', state.scope);
  renderSeg('seg-interval', Object.keys(INTERVALS).map((k) => [k, INTERVAL_LABEL[k]]), state.interval, (v) => {
    state.interval = v; store.set('interval', v);
    if (INTERVALS[v].intraday && state.valueMode === 'real') { state.valueMode = 'positions'; store.set('valueMode', 'positions'); }
    if (!rangesFor(v).includes(state.range)) state.range = INTERVALS[v].def;
    store.set('range', state.range); renderToolbar(); rebuild(true);
  });
  if (!rangesFor(state.interval).includes(state.range)) { state.range = INTERVALS[state.interval].def; store.set('range', state.range); }
  renderSeg('seg-range', rangesFor(state.interval).map((r) => [r, RANGE_LABEL[r]]), state.range, (v) => {
    // The data already covers every period: zoom, without loading again.
    state.range = v; store.set('range', v); renderToolbar();
    if (!state.agg.length) { rebuild(true); return; }
    zoomToRange(); updatePeriodKpi(); updateLegend();
  });
  markSeg('seg-type', state.chartType);
  markSeg('seg-scale', state.scaleMode);
  $('opt-static').checked = state.includeStatic;
  $('opt-static').disabled = state.scope === 'crypto';
  markSeg('seg-mode', state.valueMode);
  const why = realReason();
  for (const b of $('seg-mode').querySelectorAll('button')) b.style.opacity = b.dataset.v === 'real' && why ? 0.45 : 1;
  $('seg-mode').title = why ? `Storico reale non disponibile: ${why}.` : $('seg-mode').getAttribute('title');
  const contribOk = realActive() && state.scope === 'all';
  $('opt-contrib').checked = state.showContrib;
  $('opt-flows').checked = state.showFlows;
  $('opt-trades').checked = state.showTrades;
  $('opt-contrib').disabled = !contribOk;
  $('lbl-contrib').style.display = state.valueMode === 'real' ? '' : 'none';
  $('lbl-contrib').style.opacity = contribOk ? 1 : 0.4;
  syncRealToggle();
  $('opt-static').disabled = state.scope === 'crypto' || realActive();
  renderPicker();
}
function renderPicker() {
  const pk = $('picker');
  pk.classList.toggle('show', state.scope === 'custom');
  if (state.scope !== 'custom') return;
  const chips = positions().map((p) => `<span class="chip ${state.custom.has(p.symbol) ? 'on' : ''}" data-chip="${esc(p.symbol)}">${esc(p.symbol)}</span>`);
  const acts = [['all', 'Tutti'], ['none', 'Nessuno'], ['equity', 'Azioni ed ETF'], ['fund', 'Fondi comuni'], ['crypto', 'Crypto'], ['static', 'CD e liquidità']]
    .map(([k, l]) => `<span class="chip act" data-act="${k}">${l}</span>`);
  pk.innerHTML = acts.join('') + '<span class="sep"></span>' + chips.join('');
}
$('picker').addEventListener('click', (e) => {
  const c = e.target.closest('[data-chip]'), a = e.target.closest('[data-act]');
  if (c) { const s = c.dataset.chip; state.custom.has(s) ? state.custom.delete(s) : state.custom.add(s); }
  else if (a) {
    const k = a.dataset.act;
    if (k === 'none') state.custom.clear();
    else for (const p of positions()) if (k === 'all' ? isMarketPos(p) : p.kind === k) state.custom.add(p.symbol);
  } else return;
  saveCustom(); renderPicker(); renderTable(); updateKpis(); rebuildDebounced();
});
function saveCustom() { store.set('custom', [...state.custom]); }
let rebuildTimer = null;
function rebuildDebounced() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(() => rebuild(true), 350); }

$('seg-scope').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.scope = b.dataset.v; store.set('scope', state.scope);
  if (state.scope === 'custom' && state.valueMode === 'real') { state.valueMode = 'positions'; store.set('valueMode', 'positions'); }
  if (state.scope === 'custom' && !state.custom.size) for (const p of positions()) if (isMarketPos(p)) state.custom.add(p.symbol);
  renderToolbar(); renderTable(); updateKpis(); rebuild(true);
};
$('seg-type').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.chartType = b.dataset.v; store.set('chartType', state.chartType); markSeg('seg-type', state.chartType); renderSeries(false);
};
$('seg-scale').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.scaleMode = +b.dataset.v; store.set('scaleMode', state.scaleMode); markSeg('seg-scale', state.scaleMode);
  chart.priceScale('right').applyOptions({ mode: state.scaleMode });
  renderIndicators(); // log scale drops overlay values at or below zero; % mode hides overlays
  updateLegend();
};
$('opt-static').onchange = (e) => { state.includeStatic = e.target.checked; store.set('includeStatic', state.includeStatic); renderTable(); updateKpis(); rebuild(false); };
$('opt-contrib').onchange = (e) => { state.showContrib = e.target.checked; store.set('showContrib', state.showContrib); renderRealOverlay(); };
$('opt-flows').onchange = (e) => { state.showFlows = e.target.checked; store.set('showFlows', state.showFlows); renderFlowLines(); updateLegend(); };
$('opt-real').onchange = (e) => { state.showReal = e.target.checked; store.set('showReal', state.showReal); renderRealLine(); updateLegend(); };
$('opt-trades').onchange = (e) => { state.showTrades = e.target.checked; store.set('showTrades', state.showTrades); renderFlowLines(); updateLegend(); };
$('seg-mode').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.valueMode = b.dataset.v; store.set('valueMode', state.valueMode);
  if (state.valueMode === 'real') {
    // The real history is daily: move to a daily view and a scope that has it.
    if (INTERVALS[state.interval].intraday) { state.interval = '1D'; state.range = INTERVALS['1D'].def; store.set('interval', '1D'); store.set('range', state.range); }
    if (state.scope === 'custom') { state.scope = 'all'; store.set('scope', 'all'); renderTable(); updateKpis(); }
    const why = realReason();
    if (why) { const bn = $('banner'); bn.innerHTML = `Storico reale non disponibile: ${esc(why)}.`; bn.classList.add('show'); }
  }
  renderToolbar(); rebuild(true);
};

$('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th'); if (!th || th.dataset.k === 'sel') return;
  if (state.sortKey === th.dataset.k) state.sortDir *= -1; else { state.sortKey = th.dataset.k; state.sortDir = ['symbol', 'name', 'src'].includes(th.dataset.k) ? 1 : -1; }
  renderTable();
});
$('tbody').addEventListener('click', (e) => {
  const cb = e.target.closest('input[data-sym]');
  if (cb) { cb.checked ? state.custom.add(cb.dataset.sym) : state.custom.delete(cb.dataset.sym); saveCustom(); renderPicker(); updateKpis(); renderTable(); rebuildDebounced(); return; }
  const solo = e.target.closest('[data-solo]');
  if (solo) {
    state.scope = 'custom'; state.custom = new Set([solo.dataset.solo]); saveCustom(); store.set('scope', 'custom');
    if (state.valueMode === 'real') { state.valueMode = 'positions'; store.set('valueMode', 'positions'); }
    renderToolbar(); renderTable(); updateKpis(); rebuild(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

/* ------------------------------------------------------------------ settings, import, export */
$('worker-code').value = $('worker-src').textContent.trim();
/** Fills the time zone list: automatic first, then every zone the browser knows. */
function fillTzSelect() {
  const sel = $('set-tz');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
  if (!zones.length) zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Rome', 'UTC'];
  for (const z of [deviceTz(), tzChoice]) if (z && !zones.includes(z)) zones.push(z);
  sel.replaceChildren();
  const auto = document.createElement('option');
  auto.value = ''; auto.textContent = `Automatico: ${deviceTz()} (${tzAbbr(deviceTz())})`;
  sel.append(auto);
  for (const z of [...zones].sort()) { const o = document.createElement('option'); o.value = z; o.textContent = z.replace(/_/g, ' '); sel.append(o); }
  sel.value = tzChoice;
  $('tz-hint').textContent = tzChoice
    ? `Fisso su ${tzChoice}: resta questo anche se ti sposti.`
    : 'Segue il fuso del telefono, che si aggiorna da solo in base a dove ti trovi.';
}
function openSettings() {
  fillTzSelect();
  $('set-proxy').value = state.settings.proxy || DEFAULT_PROXY;
  $('set-token').value = state.settings.token || '';
  $('set-finnhub').value = state.settings.finnhub || DEFAULT_FINNHUB;
  $('set-poll').value = state.settings.pollSec || 30;
  $('conn-info').textContent = BOOT.info();
  $('snap-info').textContent = `Snapshot in uso: ${state.snap.source || state.snap.asof} · ${positions().length} posizioni` + (state.snap === embedded ? ' (dal brief, via Drive)' : ' (importato a mano)');
  $('msg').textContent = '';
  $('modal').classList.add('show');
}
const msg = (t, bad) => { const s = document.createElement('span'); s.className = bad ? 'down' : 'up'; s.textContent = t; $('msg').replaceChildren(s); };
$('btn-settings').onclick = openSettings;
$('pill-clock').onclick = () => { openSettings(); $('set-tz').focus(); };
$('set-tz').onchange = () => {
  tzChoice = validTz($('set-tz').value);
  if (tzChoice) store.set('tz', tzChoice); else store.del('tz');
  fillTzSelect();
  tzChanged();
  tickClock();
};
$('btn-close').onclick = () => $('modal').classList.remove('show');
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.remove('show'); });
$('btn-save').onclick = () => {
  state.settings = {
    // Store only an override: the default stays in the file and follows future rebuilds.
    proxy: normalizeProxy($('set-proxy').value) === normalizeProxy(DEFAULT_PROXY) ? '' : normalizeProxy($('set-proxy').value),
    token: $('set-token').value.trim(),
    finnhub: $('set-finnhub').value.trim() === DEFAULT_FINNHUB ? '' : $('set-finnhub').value.trim(),
    pollSec: Math.max(10, +$('set-poll').value || 30),
  };
  store.set('settings', state.settings);
  $('set-proxy').value = state.settings.proxy || DEFAULT_PROXY;
  state.barCache.clear();
  connectFinnhub(); pollYahoo(); rebuild(true);
  msg('Impostazioni salvate.');
};
$('btn-test').onclick = async () => {
  if (!$('set-proxy').value.trim()) $('set-proxy').value = DEFAULT_PROXY;
  const saved = state.settings.token;
  state.settings.token = $('set-token').value.trim();
  const url = proxyUrl('/v8/finance/chart/SPY?interval=1d&range=5d', $('set-proxy').value);
  state.settings.token = saved;
  msg('Provo ' + url.replace(/token=[^&]+/, 'token=…') + ' …');
  try {
    const j = await fetchJson(url);
    const p = j.chart.result[0].meta.regularMarketPrice;
    msg(`Proxy funzionante: SPY ${fmtPrice(p)}. Premi "Salva e ricarica dati".`);
  } catch (e) {
    const hint = e.status === 403 ? 'il Worker chiede un token' : e.status === 404 ? 'il Worker non ha il codice del proxy (hai premuto Deploy dopo averlo incollato?)'
      : e.status === 429 ? 'Yahoo sta limitando le richieste del Worker, riprova tra qualche minuto' : 'controlla l\'URL del proxy';
    msg(`Proxy non raggiungibile (${e.message}): ${hint}.`, true);
  }
};
$('btn-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('worker-code').value); msg('Codice copiato.'); }
  catch { $('worker-code').select(); msg('Copia non permessa: il testo è selezionato, usa Ctrl/Cmd+C.', true); }
};
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state.snap, null, 1)], { type: 'application/json' });
  const a = $('dl'); a.href = URL.createObjectURL(blob); a.download = `portfolio_snapshot_${state.snap.asof}.json`; a.click();
};
$('btn-reset').onclick = () => { store.del('snapshot'); applySnapshot(embedded, false); msg('Ripristinato lo snapshot del brief.'); };
$('set-file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    let snap;
    if (/\.json$/i.test(f.name)) snap = JSON.parse(await f.text());
    else if (/\.csv$/i.test(f.name)) snap = parseDriveCsv(await f.text(), f.name);
    else snap = await parseBriefXlsx(await f.arrayBuffer(), f.name);
    const problems = validateSnapshot(snap);
    if (problems.fatal) throw new Error(problems.fatal);
    applySnapshot(snap, true);
    msg(`Importate ${snap.positions.length} posizioni al ${snap.asof}.` + (problems.warn.length ? ` Attenzione: ${problems.warn.join('; ')}` : ''), problems.warn.length > 0);
  } catch (err) { msg('Import non riuscito: ' + err.message, true); }
  e.target.value = '';
};
function applySnapshot(snap, persist) {
  state.snap = snap;
  if (persist) store.set('snapshot', snap);
  state.live = {}; state.barCache.clear();
  for (const s of [...state.custom]) if (!bySym(s)) state.custom.delete(s);
  saveCustom();
  $('asof').textContent = `posizioni al ${snap.asof}`;
  connectCoinbase(); connectFinnhub(); pollYahoo(); loadRiskHistory();
  renderToolbar(); renderTable(); updateKpis(); rebuild(true);
}
function validateSnapshot(s) {
  if (!s || !Array.isArray(s.positions) || !s.positions.length) return { fatal: 'nessuna posizione trovata', warn: [] };
  const warn = [];
  let bad = 0;
  for (const p of s.positions) {
    if (!p.symbol || !isFinite(p.value)) { bad++; continue; }
    if (p.kind !== 'static' && (!isFinite(p.qty) || !isFinite(p.price) || Math.abs(p.qty * p.price - p.value) > Math.max(2, 0.02 * Math.abs(p.value)))) bad++;
  }
  if (bad > s.positions.length / 3) return { fatal: `${bad} righe con quantità × prezzo diverso dal valore: i numeri sembrano corrotti (succede con il Google Sheet convertito da Drive). Usa l'XLSX del brief.`, warn };
  if (bad) warn.push(`${bad} righe incoerenti`);
  return { warn };
}

/** Classify a position from the brief's class label and ticker shape. */
function kindOf(symbol, klass) {
  if (/crypto/i.test(klass || '')) return 'crypto';
  if (/liquidit|cd\b/i.test(klass || '') || /^CASH$|^Sweep$/i.test(symbol) || /^[0-9]{5}[A-Z0-9]{4}$/.test(symbol)) return 'static';
  if (/^[A-Z]{4}X$/.test(symbol)) return 'fund'; // US mutual fund tickers: five letters ending in X
  return 'equity';
}
function buildPosition(r) {
  const kind = kindOf(r.symbol, r.cls);
  const qty = +r.qty, price = +r.price, value = +r.value, cost = +r.cost, day = +r.day || 0;
  return {
    symbol: r.symbol === 'CASH' ? 'Sweep' : r.symbol, name: r.name || r.symbol, cls: r.cls || '', account: r.account || '', kind,
    qty: kind === 'static' ? (isFinite(qty) ? qty : null) : qty, price: isFinite(price) ? price : null,
    prev: kind !== 'static' && qty ? price - day / qty : null, value, cost: isFinite(cost) ? cost : value,
  };
}
const headerIndex = (hdr, names) => { for (const n of names) { const i = hdr.findIndex((h) => String(h).trim().toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
function rowsToPositions(hdr, rows) {
  const ix = {
    symbol: headerIndex(hdr, ['Simbolo']), name: headerIndex(hdr, ['Nome']), cls: headerIndex(hdr, ['Classe']), account: headerIndex(hdr, ['Conto']),
    qty: headerIndex(hdr, ['Qtà']), price: headerIndex(hdr, ['Prezzo']), value: headerIndex(hdr, ['Valore']), cost: headerIndex(hdr, ['Costo']), day: headerIndex(hdr, ['Giorno $']),
  };
  if (ix.symbol < 0 || ix.value < 0) throw new Error('colonne Simbolo/Valore non trovate');
  const num = (v) => {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return NaN;
    let t = String(v).trim().replace(/[$\s]/g, '');
    const frac = t.match(/^=(-?\d+)\/(\d+)$/); // drive_export >= 0.3.14 writes "=16834338/100"
    if (frac) return +frac[1] / +frac[2];
    if (t.includes(',') && !t.includes('.')) t = t.replace(',', '.'); // decimal comma (Drive export, Italian locale)
    else t = t.replace(/,/g, '');
    return +t;
  };
  return rows.filter((r) => r && r[ix.symbol]).map((r) => buildPosition({
    symbol: String(r[ix.symbol]).trim(), name: r[ix.name], cls: r[ix.cls], account: r[ix.account],
    qty: num(r[ix.qty]), price: num(r[ix.price]), value: num(r[ix.value]), cost: num(r[ix.cost]), day: num(r[ix.day]),
  }));
}
function historyFromRows(hdr, rows) {
  const d = headerIndex(hdr, ['Data']), v = headerIndex(hdr, ['Valore del portafoglio']), c = headerIndex(hdr, ['Contributi netti']), a = headerIndex(hdr, [BROKER]);
  if (d < 0 || v < 0) return null;
  const toIso = (x) => x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10);
  const num = (x) => { if (typeof x === 'number') return x; const m = String(x ?? '').match(/^=(-?\d+)\/(\d+)$/); if (m) return +m[1] / +m[2]; const t = String(x ?? '').replace(',', '.'); return t === '' ? NaN : +t; };
  const out = { dates: [], value: [], contrib: [], [BK]: a >= 0 ? [] : undefined };
  for (const r of rows) {
    if (!r || r[d] == null || !isFinite(num(r[v]))) continue;
    out.dates.push(toIso(r[d])); out.value.push(num(r[v])); out.contrib.push(c >= 0 ? num(r[c]) : NaN);
    if (a >= 0) out[BK].push(num(r[a]));
  }
  if (!out[BK]) delete out[BK];
  return out.dates.length ? out : null;
}
/** Parse a number written by the brief: plain, "=a/b" (Drive-safe) or with a decimal comma. */
function parseBriefNum(x) {
  if (typeof x === 'number') return x;
  const t = String(x ?? '').trim().replace(/[$\s]/g, '');
  if (!t) return NaN;
  const m = t.match(/^=(-?\d+)\/(\d+)$/);
  if (m) return +m[1] / +m[2];
  if (t.includes(',') && !t.includes('.')) return +t.replace(',', '.');
  return +t.replace(/,/g, '');
}
function closedFromRows(hdr, rows) {
  const ix = { s: headerIndex(hdr, ['Simbolo']), q: headerIndex(hdr, ['Qtà']), pr: headerIndex(hdr, ['Incassi']), c: headerIndex(hdr, ['Costo']),
               p: headerIndex(hdr, ['P&L']), d: headerIndex(hdr, ['Dividendi']), i: headerIndex(hdr, ['Interessi']), l: headerIndex(hdr, ['Ultima uscita']),
               h: headerIndex(hdr, ['Ancora detenuto']) };
  if (ix.s < 0 || ix.p < 0) return undefined;
  return rows.filter((r) => r && r[ix.s]).map((r) => {
    const held = (ix.h >= 0 && /^(s[iì]|yes|true|1)$/i.test(String(r[ix.h] ?? ''))) || /in posizioni/i.test(String(r[ix.d] ?? ''));
    const last = r[ix.l] instanceof Date ? r[ix.l].toISOString().slice(0, 10) : String(r[ix.l] ?? '').slice(0, 10);
    return { symbol: String(r[ix.s]).trim(), qty: parseBriefNum(r[ix.q]), proceeds: parseBriefNum(r[ix.pr]), cost: parseBriefNum(r[ix.c]),
             pnl: parseBriefNum(r[ix.p]), dividends: held ? null : (parseBriefNum(r[ix.d]) || 0), interest: held ? null : (parseBriefNum(r[ix.i]) || 0), held, last };
  });
}
/** Income, fees and net contributions from the brief's summary table (XLSX "Riepilogo" or CSV "## Riepilogo"). */
function incomeFromSummary(rows) {
  const d = summaryValue(rows, 'Dividendi (incluse distribuzioni di plusvalenze)');
  const i = summaryValue(rows, 'Interessi (inclusi maturati sui CD)');
  const f = summaryValue(rows, 'Commissioni (al netto delle retrocessioni)');
  const c = summaryValue(rows, 'Contributi netti');
  const out = {};
  if (d != null && i != null && f != null) out.income = { dividends: d, interest: i, fees: Math.abs(f) };
  if (c != null) out.contrib_net = c;
  // the XLSX and the Drive CSV use different labels for the brief's total XIRR
  const m = summaryValue(rows, 'MWR totale (XIRR, /anno)') ?? summaryValue(rows, 'MWR totale /anno');
  if (m != null) out.mwr = { total: m };
  return out;
}
function summaryValue(rows, label) {
  const row = rows.find((r) => r && String(r[0]).trim() === label);
  const v = row ? parseBriefNum(row[1]) : NaN;
  return isFinite(v) ? v : undefined;
}
const dateFromName = (name) => (name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10);

async function loadSheetJs() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('impossibile caricare il lettore XLSX (serve internet)'));
    document.head.appendChild(s);
  });
  return window.XLSX;
}
async function parseBriefXlsx(buf, name) {
  const XLSX = await loadSheetJs();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = (n) => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true }) : null;
  const pos = sheet('Posizioni');
  if (!pos) throw new Error('foglio "Posizioni" non trovato');
  const positionsArr = rowsToPositions(pos[0], pos.slice(1));
  const hs = sheet('Serie storica');
  const history = hs ? historyFromRows(hs[0], hs.slice(1)) : null;
  const ch = sheet('Chiuse');
  const rs = sheet('Riepilogo');
  return { asof: dateFromName(name), source: `Import ${name}`, positions: positionsArr, history: history || state.snap.history,
           closed: ch ? closedFromRows(ch[0], ch.slice(1)) : undefined, realized: rs ? summaryValue(rs, 'P&L chiuso') : undefined,
           ...(rs ? incomeFromSummary(rs) : {}) };
}
/** CSV written by drive_export.py: stacked sections, each under a "## Title" row. */
function parseDriveCsv(text, name) {
  const rows = parseCsv(text);
  const section = (title) => {
    const i = rows.findIndex((r) => r[0] && r[0].startsWith('## ' + title));
    if (i < 0) return null;
    const hdr = rows[i + 1]; const body = [];
    for (let j = i + 2; j < rows.length && rows[j].some((c) => c !== ''); j++) body.push(rows[j]);
    return { hdr, body };
  };
  const p = section('Posizioni');
  if (!p) throw new Error('sezione "## Posizioni" non trovata');
  const h = section('Serie storica');
  const c = section('Posizioni chiuse');
  const r = section('Riepilogo');
  const asofRow = rows[0] && rows[0][2] ? rows[0][2].replace(/^al\s*/, '') : dateFromName(name);
  return { asof: asofRow, source: `Import ${name}`, positions: rowsToPositions(p.hdr, p.body), history: (h && historyFromRows(h.hdr, h.body)) || state.snap.history,
           closed: c ? closedFromRows(c.hdr, c.body) : undefined, realized: r ? summaryValue([r.hdr, ...r.body], 'P&L chiuso') : undefined,
           ...(r ? incomeFromSummary([r.hdr, ...r.body]) : {}) };
}
function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

/* ------------------------------------------------------------------ boot */
// Test hook: automated browser tests set window.__ptTest before load to reach these helpers.
if (window.__ptTest) Object.assign(window.__ptTest, { localDayTs, localMidnight, bucketStart, toChartTime, nyseCountdown, fmtCountdown });
let lastNyseOpen = null;
let lastTz = TZ();
/** The selected (or, in automatic mode, the device's) time zone changed: midnight moved, rebuild. */
function tzChanged() {
  lastTz = TZ();
  ensureDay(); updateKpis(); renderTable(); rebuild(false);
  window.dispatchEvent(new Event('pt-tz')); // the loader re-renders the bank accounts
}
function tickClock() {
  if (document.hidden) return; // nothing to show; the visibilitychange handler runs it on return
  if (TZ() !== lastTz) tzChanged(); // automatic mode follows the phone when it changes zone
  $('clock').textContent = new Date().toLocaleTimeString('it-IT', { timeZone: TZ() });
  $('clock-tz').textContent = tzAbbr();
  $('pill-clock').title = `Fuso orario: ${TZ()}` + (tzChoice ? ' (scelto nelle impostazioni)' : ' (automatico, dal dispositivo)') + '. Tocca per cambiarlo.';
  if (dayRef.day != null && dayRef.day !== localMidnight()) { ensureDay(); updateKpis(); renderTable(); rebuild(false); }
  if (riskStale()) loadRiskHistory();
  const st = marketStatus('equity');
  $('nyse-dot').className = 'mk ' + (st.open ? 'open' : 'closed');
  $('nyse-txt').textContent = st.open ? 'NYSE aperta' : 'NYSE chiusa';
  const cd = nyseCountdown();
  $('nyse-cd').textContent = cd ? (cd.open ? 'chiude tra ' : 'apre tra ') + fmtCountdown(cd.sec) : '';
  $('pill-nyse').title = st.label;
  if (lastNyseOpen !== null && lastNyseOpen !== st.open) renderTable(); // flip the table dots at the bell
  lastNyseOpen = st.open;
}
tickClock();
setInterval(tickClock, 1000);
// Roll the last bar even when no tick arrives (keeps the time axis honest for idle scopes).
setInterval(() => { if (scopePositions().some((p) => p.kind === 'crypto')) { dirty.chart = true; scheduleFlush(); } }, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tickClock();
  dirty.chart = true; scheduleFlush(); // draw what arrived while in the background
  pollYahoo();
  if (!cbWs || cbWs.readyState > 1) connectCoinbase();
});

$('asof').textContent = `posizioni al ${state.snap.asof}`;
let embeddedPreview = false;
try { embeddedPreview = window.self !== window.top; } catch { embeddedPreview = true; }
if (embeddedPreview) {
  const b = $('banner');
  b.innerHTML = '<b>Stai guardando un\'anteprima.</b> Qui le connessioni ai prezzi sono bloccate: scarica il file e aprilo dal computer con Chrome (doppio clic).';
  b.classList.add('show');
}
renderToolbar();
renderTable();
updateKpis();
refreshStocksPill();
ensureDay();
connectCoinbase();
connectFinnhub();
pollYahoo();
loadDayRefs();
loadRiskHistory();
rebuild(true);
if (!proxyUrl('/') && !embeddedPreview) setTimeout(() => { if (!proxyUrl('/')) { const b = $('banner'); if (!b.classList.contains('show')) { b.innerHTML = 'Per i prezzi e lo storico di azioni, ETF e fondi configura il proxy Yahoo in <b>Impostazioni</b> (codice del Worker incluso). Le crypto sono già in tempo reale.'; b.classList.add('show'); } } }, 1500);

/* ------------------------------------------------------------------ hooks for the loader */
$('btn-refresh').onclick = async () => {
  msg('Controllo lo snapshot su Drive…');
  const r = await BOOT.refresh();
  if (r.ok) openSettings(); // re-reads the snapshot lines; it also clears the message, so set it afterwards
  msg(r.text, !r.ok);
};
$('btn-conn').onclick = () => { $('modal').classList.remove('show'); BOOT.openConnect(); };
return {
  /** A newer snapshot arrived from Drive: it becomes the baseline; a manual import wins only if it is newer still. */
  applyRemote(snap) { embedded = snap; applySnapshot(pickSnapshot(), false); },
  /** New bank balances from Wallet: refresh the net worth. */
  bankChanged() { updateKpis(); },
};
};
