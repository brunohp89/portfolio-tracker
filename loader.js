/* Loader: connection settings, snapshot download and cache, then starts the tracker. */
(() => {
'use strict';
const LS = { conn: 'pt.conn', remote: 'pt.remote', wallet: 'pt.wallet', extra: 'pt.extra', extras: 'pt.extras', extrasSynced: 'pt.extrasSynced', labels: 'pt.labels' };
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const el = (id) => document.getElementById(id);
const RECHECK_MS = 10 * 60 * 1000;

let conn = read(LS.conn);       // { url, token }
let remote = read(LS.remote);   // { etag, modified, checkedAt, snap }
let app = null;
let busy = null;

const LOCAL_PAGE = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
function cleanUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/(snapshot|check)$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    const local = LOCAL_PAGE && p.protocol === 'http:' && (p.hostname === 'localhost' || p.hostname === '127.0.0.1');
    if (p.protocol !== 'https:' && !local) return '';
    return p.origin + p.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}
const validSnap = (s) => !!s && typeof s.asof === 'string' && Array.isArray(s.positions) && s.positions.length > 0;
const configOf = (s) => JSON.stringify((s && s.config) || {});
const fmtWhen = (ms) => ms ? new Date(ms).toLocaleString('it-IT', { timeZone: TZ(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'mai';

/** @returns {Promise<{changed: boolean, snap?: object, etag?: string, modified?: number}>} */
async function download(c, etag) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    const headers = { Authorization: 'Bearer ' + c.token };
    if (etag) headers['If-None-Match'] = etag;
    res = await fetch(c.url + '/snapshot', { headers, cache: 'no-store', signal: ctrl.signal });
  } catch {
    throw { code: navigator.onLine === false ? 'offline' : 'network' };
  } finally { clearTimeout(timer); }
  if (res.status === 304) return { changed: false };
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw { code: (body && body.error) || 'http', message: (body && body.message) || 'HTTP ' + res.status };
  if (!validSnap(body)) throw { code: 'bad_snapshot' };
  return { changed: true, snap: body, etag: res.headers.get('ETag') || '', modified: Date.parse(res.headers.get('Last-Modified') || '') || Date.now() };
}

function errorText(err) {
  switch (err && err.code) {
    case 'offline': return 'Sei offline.';
    case 'unauthorized': return 'Token rifiutato dal Worker.';
    case 'no_snapshot': return 'Il Worker risponde, ma nella cartella non vede ancora nessuno snapshot: arriva con il prossimo Portfolio Brief (oppure la cartella non è condivisa con il service account).';
    case 'bad_snapshot': case 'snapshot_not_json': return 'Lo snapshot ricevuto non è valido.';
    case 'network': return 'Worker non raggiungibile: controlla la rete e l\'URL (e ALLOWED_ORIGIN, se l\'hai impostato).';
    default: return 'Il Worker ha risposto con un errore: ' + ((err && err.message) || (err && err.code) || 'sconosciuto') + '.';
  }
}

function info() {
  if (!conn) return 'Nessun collegamento: le posizioni vengono solo da file importati.';
  if (!remote) return 'Collegato, nessuno snapshot scaricato.';
  return `Snapshot del brief al ${remote.snap.asof}, scritto su Drive il ${fmtWhen(remote.modified)}, ultimo controllo ${fmtWhen(remote.checkedAt)}.`;
}

/** Checks Drive for a newer snapshot and applies it. Never throws. */
function refresh() {
  if (busy) return busy;
  busy = (async () => {
    if (!conn) return { ok: false, text: 'Nessun collegamento configurato.' };
    try {
      const r = await download(conn, remote && remote.etag);
      if (!r.changed) {
        remote.checkedAt = Date.now(); write(LS.remote, remote);
        return { ok: true, text: `Nessuna novità: lo snapshot è ancora quello al ${remote.snap.asof}.` };
      }
      const configChanged = !!remote && configOf(remote.snap) !== configOf(r.snap);
      remote = { etag: r.etag, modified: r.modified, checkedAt: Date.now(), snap: r.snap };
      write(LS.remote, remote);
      if (app && configChanged) { location.reload(); return { ok: true, text: 'Nuove impostazioni: ricarico.' }; }
      if (app) app.applyRemote(r.snap);
      renderMonefy();
      return { ok: true, text: `Posizioni aggiornate al ${r.snap.asof}.` };
    } catch (err) {
      return { ok: false, text: errorText(err) };
    }
  })();
  busy.finally(() => { busy = null; });
  return busy;
}

function start() {
  el('boot-msg').hidden = true;
  el('connect').classList.remove('show');
  app = window.startTracker({ snapshot: remote.snap, refresh, openConnect, info, bankTotalUsd, eurRate, labels: labels || {} });
  renderWallet();
  refreshWallet();
}

function openConnect(message) {
  const c = el('connect');
  c.classList.toggle('over', !!app);
  el('conn-cancel').hidden = !app;
  el('conn-url').value = conn ? conn.url : '';
  el('conn-token').value = '';
  el('conn-token').placeholder = conn ? 'Lascia vuoto per tenere quello attuale' : '';
  el('connect-msg').innerHTML = '';
  if (message) setMsg(message, true);
  c.classList.add('show');
}
function setMsg(text, bad) {
  const s = document.createElement('span'); s.className = bad ? 'down' : 'up'; s.textContent = text;
  el('connect-msg').replaceChildren(s);
}
el('conn-cancel').onclick = () => el('connect').classList.remove('show');
el('connect-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = cleanUrl(el('conn-url').value);
  const token = el('conn-token').value.trim() || (conn && conn.url === url ? conn.token : '');
  if (!url) { setMsg('Serve un indirizzo https, ad esempio https://portfolio-snapshot.tuonome.workers.dev', true); return; }
  if (!token) { setMsg('Inserisci il token.', true); return; }
  const btn = el('conn-submit');
  btn.disabled = true; btn.textContent = 'Collegamento…';
  try {
    const r = await download({ url, token }, '');
    conn = { url, token }; write(LS.conn, conn);
    const hadApp = !!app;
    const configChanged = !!remote && configOf(remote.snap) !== configOf(r.snap);
    remote = { etag: r.etag, modified: r.modified, checkedAt: Date.now(), snap: r.snap };
    write(LS.remote, remote);
    if (hadApp && configChanged) { location.reload(); return; }
    if (hadApp) { app.applyRemote(r.snap); el('connect').classList.remove('show'); } else { if (!labels) await loadLabels(); start(); }
  } catch (err) {
    setMsg(errorText(err), true);
  } finally { btn.disabled = false; btn.textContent = 'Collega'; }
});

// ---------- bank accounts (BudgetBakers Wallet through the Worker's /wallet route) ----------
let wallet = read(LS.wallet);   // { data, fetchedAt }
let walletErr = '';
let walletBusy = false;
/** A bank-synced account not synced for longer than this gets the alarm icon. */
const SYNC_ALARM_MS = 24 * 60 * 60 * 1000;
const fmtSyncDay = (iso) => iso ? new Date(iso).toLocaleDateString('it-IT', { timeZone: TZ(), day: '2-digit', month: '2-digit' }) : '—';
/** Time if today, else the day: when Plaid last refreshed a bank's transactions (pending list included). */
const fmtTxWhen = (iso) => {
  const d = new Date(iso);
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: TZ() });
  return day(d) === day(new Date()) ? d.toLocaleTimeString('it-IT', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' }) : fmtSyncDay(iso);
};

const fmtMoney = (v, cur) => {
  if (v == null || !isFinite(v)) return '—';
  const sym = cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur + ' ';
  return (v < 0 ? '−' : '') + sym + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDay = (iso) => iso ? new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('it-IT', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }) : '—'; // a date, not an instant
const fmtWhole = (v, cur) => fmtMoney(v, cur).replace(/\.\d{2}$/, '');
/** "owed / limit · pct" cell; the amounts are hidden on narrow screens, the percentage stays. */
function creditCell(c, cur) {
  const td = document.createElement('td');
  td.className = 'num';
  if (!c || !c.limit) return td;
  const amt = document.createElement('span');
  amt.className = 'cr-amt';
  amt.textContent = `${fmtWhole(c.owed, cur)} / ${fmtWhole(c.limit, cur)} · `;
  td.append(amt, `${c.utilizationPct.toFixed(1)}%`);
  td.title = `Usati ${fmtMoney(c.owed, cur)} su ${fmtMoney(c.limit, cur)}`;
  return td;
}

function walletErrorText(err) {
  switch (err && err.code) {
    case 'offline': return 'sei offline';
    case 'not_found': return 'il Worker non ha ancora la route /wallet';
    case 'wallet_not_configured': return 'manca il secret WALLET_API_TOKEN nel Worker';
    case 'wallet_unauthorized': return 'Wallet ha rifiutato il token (WALLET_API_TOKEN)';
    case 'wallet_rate_limited': return 'limite di richieste di Wallet raggiunto, riprovo più tardi';
    case 'wallet_initial_sync': return 'Wallet sta ancora facendo la prima sincronizzazione';
    case 'unauthorized': return 'token rifiutato dal Worker';
    default: return (err && (err.message || err.code)) || 'errore sconosciuto';
  }
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/** Manual accounts [{ id, name, amount, currency }]: kept by the Worker (PLAID_KV "manual") so every
 * device shares them; this browser keeps a copy (pt.extras) to start without network. */
const validExtra = (x) => !!x && typeof x.amount === 'number' && isFinite(x.amount) && (x.currency === 'USD' || x.currency === 'EUR');
const newExtraId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let extras = (() => {
  const list = read(LS.extras);
  if (Array.isArray(list)) return list.filter(validExtra).map((x) => ({ ...x, id: String(x.id || newExtraId()) }));
  const single = read(LS.extra); // the single manual account of earlier versions
  return validExtra(single) ? [{ id: newExtraId(), name: single.name || 'Conto manuale', amount: single.amount, currency: single.currency }] : [];
})();
function saveExtras() {
  write(LS.extras, extras);
  try { localStorage.removeItem(LS.extra); } catch { /* storage unavailable */ }
}
if (read(LS.extra)) saveExtras(); // finish the migration once

/** Reads only the shared manual accounts (a KV read, no bank call): used when the balances are recent
 * enough to skip /wallet, so a change made on another device still shows at once. */
async function syncManual() {
  if (!conn) return;
  try {
    const res = await fetch(conn.url + '/accounts/manual', { headers: { Authorization: 'Bearer ' + conn.token }, cache: 'no-store' });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok || !Array.isArray(out.accounts)) return;
    const before = JSON.stringify(extras);
    await adoptServerManual(out.accounts);
    if (JSON.stringify(extras) !== before) renderWallet();
  } catch { /* offline: keep the local copy */ }
}
/** Sends one change to the Worker and adopts the list it answers with (the shared one). */
async function manualOp(body) {
  const r = await workerPost('/accounts/manual', body);
  extras = r.accounts.filter(validExtra);
  saveExtras();
  return r;
}
/**
 * Adopts the shared list from /wallet. The first time (per browser), accounts that only exist in this
 * browser (created before the sync existed) are uploaded first, so nothing is lost.
 */
async function adoptServerManual(list) {
  if (!read(LS.extrasSynced)) {
    const missing = extras.filter((x) => !list.some((s) => s.id === x.id));
    try {
      for (const x of missing) list = (await workerPost('/accounts/manual', { op: 'upsert', account: x })).accounts;
      write(LS.extrasSynced, true);
    } catch { return; } // keep the local list; retried at the next refresh
  }
  extras = list.filter(validExtra);
  saveExtras();
}
/** Manual accounts as rows of the Conti table. */
const extraRows = () => extras.map((x) => ({
  id: 'local:' + x.id, localId: x.id, name: x.name, type: 'Manual', currency: x.currency, bankSync: false,
  balance: x.amount, lastRecordDate: null, credit: null, local: true,
}));
const round2 = (n) => Math.round(n * 100) / 100;

/** Worker totals plus the manual accounts (converted at the Worker's EURUSD rate). */
function accountTotals(d) {
  const t = d.totals || {};
  const byCurrency = { ...(t.byCurrency || {}) };
  let usd = isFinite(t.usd) ? t.usd : null, eur = isFinite(t.eur) ? t.eur : null;
  const rate = d.fx && d.fx.rate;
  for (const x of extras) {
    byCurrency[x.currency] = round2((byCurrency[x.currency] || 0) + x.amount);
    if (usd != null && rate) {
      usd = round2(usd + (x.currency === 'USD' ? x.amount : x.amount * rate));
      eur = round2(usd / rate);
    }
  }
  return { byCurrency, usd, eur };
}

/** EURUSD from the Worker (Yahoo Finance, refreshed with the accounts); null if unknown. */
function eurRate() {
  const fx = wallet && wallet.data && wallet.data.fx;
  return fx && fx.rate > 0 ? fx.rate : null;
}

/** Bank accounts total in USD for the net worth KPI; null until Wallet answered once. */
function bankTotalUsd() {
  return wallet && wallet.data ? accountTotals(wallet.data).usd : null;
}

/** Accepts 1250.5, 1250,5, 1.250,50 and 1,250.50: the last separator is the decimal one. */
function parseAmount(text) {
  let t = String(text || '').trim().replace(/[\s'€$]/g, '').replace(/^[−–]/, '-');
  const dec = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
  if (dec >= 0) t = t.slice(0, dec).replace(/[.,]/g, '') + '.' + t.slice(dec + 1);
  return t;
}

const EXTRA_HINT = 'Condivisi tra tutti i dispositivi: entrano nei totali dei conti e nel patrimonio totale. Usa ✎ per modificarli e ✕ per eliminarli.';
/** Amount typed in a field: a number rounded to cents, or null (empty or invalid). */
function readAmount(input) {
  const raw = parseAmount(input.value);
  const amount = raw ? Number(raw) : NaN;
  return isFinite(amount) ? round2(amount) : null;
}
// Phone decimal keypads have no minus key: this button flips the sign of the amount.
const flipSign = (input) => {
  const v = input.value.trim();
  input.value = /^[-−–]/.test(v) ? v.replace(/^[-−–]\s*/, '') : '-' + v;
};
el('extra-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = readAmount(el('extra-amount'));
  if (amount == null) { el('extra-hint').textContent = 'Importo non valido: usa un numero, ad esempio 1250.50'; return; }
  const name = el('extra-name').value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Conto manuale';
  const btn = el('extra-form').querySelector('button[type=submit]');
  btn.disabled = true;
  el('extra-hint').textContent = 'Salvo…';
  try {
    await manualOp({ op: 'upsert', account: { id: newExtraId(), name, amount, currency: el('extra-cur').value } });
    el('extra-name').value = ''; el('extra-amount').value = '';
    el('extra-hint').textContent = `Aggiunto "${name}", visibile su tutti i dispositivi. ` + EXTRA_HINT;
  } catch (e) {
    el('extra-hint').textContent = 'Non salvato: ' + e.message;
  } finally { btn.disabled = false; }
  renderWallet();
});
el('extra-sign').onclick = () => flipSign(el('extra-amount'));

/** Manual account being edited in place (its id), if any. */
let extraEditing = null;
async function deleteExtra(id) {
  const x = extras.find((e) => e.id === id);
  if (!x || !confirm(`Eliminare il conto manuale "${x.name}" (${fmtMoney(x.amount, x.currency)}) da tutti i dispositivi?`)) return;
  try {
    await manualOp({ op: 'delete', id });
    if (extraEditing === id) extraEditing = null;
    el('extra-hint').textContent = `Eliminato "${x.name}".`;
  } catch (e) {
    el('extra-hint').textContent = 'Non eliminato: ' + e.message;
  }
  renderWallet();
}
/** Row under a manual account to change its name, amount and currency. */
function extraEditorRow(id) {
  const x = extras.find((e) => e.id === id);
  const tr = document.createElement('tr');
  tr.className = 'txd';
  const td = document.createElement('td');
  td.colSpan = 5;
  const form = document.createElement('form');
  form.className = 'xed';
  form.autocomplete = 'off';
  const name = Object.assign(document.createElement('input'), { value: x.name, maxLength: 40, placeholder: 'Nome' });
  name.setAttribute('aria-label', 'Nome del conto');
  const sign = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sec', textContent: '±', title: 'Cambia segno (per un debito)' });
  const amount = Object.assign(document.createElement('input'), { value: String(x.amount), inputMode: 'decimal', placeholder: 'Importo' });
  amount.setAttribute('aria-label', 'Importo');
  const cur = document.createElement('select');
  for (const c of ['USD', 'EUR']) cur.append(Object.assign(document.createElement('option'), { value: c, textContent: c }));
  cur.value = x.currency;
  const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'btn', textContent: 'Salva' });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sec', textContent: 'Annulla' });
  const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sec bad', textContent: 'Elimina' });
  const msg = Object.assign(document.createElement('div'), { className: 'txn' });
  sign.onclick = () => flipSign(amount);
  cancel.onclick = () => { extraEditing = null; renderWallet(); };
  del.onclick = () => deleteExtra(id);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = readAmount(amount);
    if (v == null) { msg.textContent = 'Importo non valido: usa un numero, ad esempio 1250.50'; msg.classList.add('down'); return; }
    const next = { ...x, name: name.value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Conto manuale', amount: v, currency: cur.value };
    save.disabled = true; msg.classList.remove('down'); msg.textContent = 'Salvo…';
    try {
      await manualOp({ op: 'upsert', account: next });
    } catch (e) {
      save.disabled = false; msg.classList.add('down'); msg.textContent = 'Non salvato: ' + e.message;
      return;
    }
    extraEditing = null;
    el('extra-hint').textContent = `Aggiornato "${next.name}".`;
    renderWallet();
  };
  form.append(name, sign, amount, cur, save, cancel, del);
  td.append(form, msg);
  tr.append(td);
  setTimeout(() => { amount.focus(); amount.select(); }, 0);
  return tr;
}
function toggleExtraEditor(id) {
  extraEditing = extraEditing === id ? null : id;
  renderWallet();
}

/**
 * Valore Monefy, as the owner defined it: a plain numeric sum with NO currency conversion. Each
 * account's balance is added in its own currency as a bare number (euro accounts as euro numbers,
 * dollar accounts as dollar numbers, manual account included), plus the broker's deposits minus its
 * withdrawals in dollars as they are (its dated external flows in the brief's snapshot). The result
 * mixes currencies on purpose, so it is shown without a currency symbol.
 */
const MONEFY_NEGATIVE = new Set(['DCA', 'HSA']);
function renderMonefy() {
  const box = el('monefy');
  const d = wallet && wallet.data;
  const flows = remote && remote.snap && remote.snap.flows;
  const key = labels && labels.brokerKey;
  const list = flows && key ? flows[key] : null;
  if (!d || !Array.isArray(list)) { box.hidden = true; return; }
  // The same rows as the Conti table (names, order, manual account), each in its own currency.
  // Owner's rule: the manual accounts named exactly DCA and HSA count as negative here (only here).
  const rows = [...d.accounts, ...extraRows().map((a) => (MONEFY_NEGATIVE.has(a.name) ? { ...a, balance: -Math.abs(a.balance) } : a))];
  rows.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base', numeric: true }));
  const accounts = rows.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
  const net = list.reduce((sum, row) => sum + (Number(row[1]) || 0), 0);
  const total = Math.round((accounts + net) * 100) / 100;
  const plain = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  el('monefy-val').textContent = plain(total);
  box.title = 'Somma senza conversioni dei saldi dei conti, ciascuno nella sua valuta, più i versamenti netti del broker in USD';
  const parts = el('monefy-parts');
  parts.replaceChildren();
  const line = (label, value, cls) => {
    const l = document.createElement('span'); l.textContent = label;
    const v = document.createElement('span'); v.className = 'n'; v.textContent = value;
    if (cls) { l.classList.add(cls); v.classList.add(cls); }
    parts.append(l, v);
  };
  for (const a of rows) line(a.name, fmtMoney(a.balance, a.currency));
  line(`Versamenti netti ${(labels && labels.broker) || 'broker'}`, fmtMoney(net, 'USD'));
  line('Somma (senza conversioni)', plain(total), 'sum');
  box.hidden = false;
}

function renderWallet() {
  if (app && app.bankChanged) app.bankChanged();
  renderMonefy();
  const wrap = el('wallet-wrap');
  if (!wallet && !walletErr) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const body = el('wallet-body'), foot = el('wallet-foot'), sum = el('wallet-sum');
  body.replaceChildren(); foot.replaceChildren();
  const d = wallet && wallet.data;
  if (d) {
    const today = Date.now();
    const rows = [...d.accounts, ...extraRows()];
    const accounts = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base', numeric: true }));
    for (const a of accounts) {
      const tr = document.createElement('tr');
      const name = cell('', 'l');
      const kind = a.source === 'plaid' ? 'p' : (a.bankSync && !a.local) ? 'w' : 'm';
      const tag = document.createElement('span');
      tag.className = 'tag ' + kind;
      tag.textContent = kind.toUpperCase();
      const ren = document.createElement('button');
      ren.type = 'button'; ren.className = 'ren'; ren.textContent = '✎';
      ren.title = a.local ? 'Modifica nome e importo' : 'Rinomina';
      ren.setAttribute('aria-label', ren.title + ' ' + a.name);
      ren.onclick = () => (a.local ? toggleExtraEditor(a.localId) : renameAccount(a));
      name.append(tag, ren);
      const syncOld = a.bankSync && !a.local && a.lastSync && today - Date.parse(a.lastSync) > SYNC_ALARM_MS;
      // Plaid: a fresh real-time balance can hide transactions (and pending items) not refreshed for days.
      const txOld = a.source === 'plaid' && a.txUpdatedAt && today - Date.parse(a.txUpdatedAt) > SYNC_ALARM_MS;
      if (syncOld || txOld) {
        const al = document.createElement('span');
        al.className = 'alarm'; al.textContent = '⚠️';
        al.title = (syncOld
          ? `Non si sincronizza dal ${new Date(a.lastSync).toLocaleString('it-IT', { timeZone: TZ() })}`
          : `Movimenti non aggiornati da Plaid dal ${new Date(a.txUpdatedAt).toLocaleString('it-IT', { timeZone: TZ() })}`)
          + ': controlla il collegamento' + (a.source === 'plaid' ? ' in Plaid (Riconnetti)' : ' in Wallet');
        name.append(al);
      }
      name.append(a.name);
      name.title = a.name + (a.originalName ? ` (nome originale: ${a.originalName})` : '') + (a.local ? ' (conto manuale, condiviso tra i dispositivi)' : a.source === 'plaid' ? ' (dalla banca via Plaid)' : a.bankSync ? ' (via Wallet)' : ' (inserito a mano in Wallet)');
      const bal = cell(fmtMoney(a.balance, a.currency), 'num' + (a.balance < 0 ? ' down' : ''));
      if (a.pending && (a.pending.count || a.pending.unlisted)) {
        const pd = a.pending;
        const p = document.createElement('span');
        p.className = 'pend';
        p.textContent = `in sospeso ${fmtMoney(pd.amount, a.currency)}` + (pd.check === 'ok' ? ' ✓' : pd.check === 'differs' ? ' ?' : pd.check === 'inferred' ? ' ≈' : '');
        const why = {
          ok: 'Verificati con il saldo disponibile della banca.',
          differs: `Il valore della banca che dovrebbe includere i pending è ${fmtMoney(pd.bankImplied, a.currency)}, diverso da questo saldo: la banca può non includere i pending nel disponibile, oppure ci sono somme bloccate o pending non ancora nell'elenco di Plaid. I pending elencati restano conteggiati.`,
          unverified: 'La banca non fornisce il saldo disponibile: pending non verificabili.',
          inferred: `Include ${fmtMoney(pd.unlisted, a.currency)} di trattenute che la banca conta nel credito disponibile ma Plaid non elenca come movimenti (ricavate da limite − disponibile).`,
        }[pd.check] || '';
        bal.title = `Contabilizzato ${fmtMoney(a.postedBalance, a.currency)}, ${pd.count} movimenti in sospeso elencati. ${why}`;
        bal.append(p);
      }
      tr.append(name, bal);
      tr.append(creditCell(a.credit, a.currency));
      tr.append(cell(fmtDay(a.lastRecordDate), 'num last'));
      const sync = cell('', 'num sync');
      if (a.source === 'plaid' && a.balanceLive) {
        const dot = document.createElement('span');
        dot.className = 'live'; dot.textContent = '●';
        sync.append(dot);
      }
      sync.append(fmtSyncDay(a.lastSync));
      if (a.lastSync) sync.title = `Ultima sincronizzazione: ${new Date(a.lastSync).toLocaleString('it-IT', { timeZone: TZ() })}` + (a.source === 'plaid' ? (a.balanceLive ? ' (saldo letto in tempo reale dalla banca)' : ' (saldo e movimenti dall\'ultimo aggiornamento di Plaid)') : ' (ultima modifica registrata da Wallet)');
      if (a.source === 'plaid' && a.txUpdatedAt) {
        const tx = document.createElement('span');
        tx.className = 'txu';
        tx.textContent = 'mov. ' + fmtTxWhen(a.txUpdatedAt);
        sync.append(tx);
        sync.title += `. Movimenti e pending aggiornati da Plaid: ${new Date(a.txUpdatedAt).toLocaleString('it-IT', { timeZone: TZ() })}`;
      }
      tr.append(sync);
      body.append(tr);
      if (!a.local) {
        tr.classList.add('acc');
        tr.title = 'Tocca per gli ultimi movimenti';
        tr.onclick = (ev) => { if (!ev.target.closest('button')) toggleTx(a); };
        if (txOpen.has(a.id)) { tr.classList.add('open'); body.append(txDetailRow(a)); }
      } else {
        // Manual account: ✕ in the (empty) sync column deletes it, tapping the row edits it.
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'xdel'; del.textContent = '✕';
        del.title = 'Elimina'; del.setAttribute('aria-label', 'Elimina ' + a.name);
        del.onclick = () => deleteExtra(a.localId);
        sync.replaceChildren(del);
        tr.classList.add('acc');
        tr.title = 'Tocca per modificare nome e importo';
        tr.onclick = (ev) => { if (!ev.target.closest('button')) toggleExtraEditor(a.localId); };
        if (extraEditing === a.localId) { tr.classList.add('open'); body.append(extraEditorRow(a.localId)); }
      }
    }
    const t = accountTotals(d);
    const addFoot = (label, value, creditTd, kind) => {
      const tr = document.createElement('tr');
      tr.className = kind;
      tr.append(cell(label, 'l'), cell(value, 'num'), creditTd || cell('', 'num'), cell('', 'last'), cell('', 'sync'));
      foot.append(tr);
    };
    for (const [cur, v] of Object.entries(t.byCurrency || {})) addFoot('Conti in ' + cur, fmtMoney(v, cur), null, 'sub');
    if (t.usd != null) {
      addFoot('Totale in USD', fmtMoney(t.usd, 'USD'), creditCell(d.credit, 'USD'), 'grand');
      addFoot('Totale in EUR', fmtMoney(t.eur, 'EUR'), null, 'grand');
    }
    sum.innerHTML = '';
    sum.append('Conti ');
    if (t.usd != null) { const b = document.createElement('b'); b.className = 'num'; b.textContent = fmtMoney(t.usd, 'USD'); sum.append(b); }
  }
  const parts = [];
  if (d) {
    if (d.wallet && !d.wallet.ok) {
      const e = d.wallet.error || {};
      parts.push(`Wallet non risponde (${e.code || 'errore'}): i conti Plaid sono aggiornati, ` + (d.wallet.staleSince
        ? `i conti W/M sono all'ultima lettura riuscita del ${fmtWhen(Date.parse(d.wallet.staleSince))}.`
        : 'i conti W/M non sono disponibili e mancano dai totali.'));
    }
    parts.push(d.dataChangedAt
      ? `Dati di Wallet modificati il ${fmtWhen(Date.parse(d.dataChangedAt))}, scaricati il ${fmtWhen(wallet.fetchedAt)}.`
      : `Scaricati il ${fmtWhen(wallet.fetchedAt)}.`);
    parts.push(d.pendingIncluded
      ? 'Conti collegati con Plaid: saldo della banca con i movimenti in sospeso inclusi; gli altri dai movimenti registrati in Wallet.'
      : 'Saldi calcolati da Wallet sui movimenti registrati.');
    if (d.fx) parts.push(d.fx.source === 'yahoo'
      ? `Cambio EURUSD ${d.fx.rate.toFixed(4)} da Yahoo Finance (${fmtWhen(Date.parse(d.fx.at))}).`
      : `Cambio EURUSD ${d.fx.rate.toFixed(4)} di Wallet al ${fmtDay(d.fx.asOf)} (Yahoo non disponibile).`);
  }
  if (walletErr) parts.push(`Aggiornamento non riuscito: ${walletErr}.`);
  el('wallet-info').textContent = parts.join(' ');
  renderPlaidItems(d && d.plaid);
  el('wallet-info').classList.toggle('down', (!!walletErr && !d) || !!(d && d.wallet && !d.wallet.ok));
}

/**
 * Downloads the balances from the Worker; the Worker caches Wallet's answer for 10 minutes.
 * force skips both caches (the Worker still allows at most one forced read a minute).
 */
async function refreshWallet(force) {
  if (!conn || walletBusy) return;
  if (!force && wallet && Date.now() - wallet.fetchedAt < RECHECK_MS && !walletErr) { renderWallet(); syncManual(); return; }
  walletBusy = true;
  const ctrl = new AbortController();
  // The Worker bounds every Plaid call (live balance 8 s, others 12 s); Wallet runs alongside.
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    let res;
    try {
      res = await fetch(conn.url + '/wallet' + (force ? '?fresh=1' : ''), { headers: { Authorization: 'Bearer ' + conn.token }, cache: 'no-store', signal: ctrl.signal });
    } catch { throw { code: navigator.onLine === false ? 'offline' : 'network', message: 'Worker non raggiungibile' }; }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.ok) throw { code: (body && body.error) || 'http', message: (body && body.message) || 'HTTP ' + res.status };
    wallet = { data: body, fetchedAt: Date.now() };
    walletErr = '';
    write(LS.wallet, wallet);
    if (Array.isArray(body.manual)) await adoptServerManual(body.manual);
    for (const id of txOpen) loadTx(id); // open details follow the new balances
  } catch (err) {
    walletErr = walletErrorText(err);
  } finally {
    clearTimeout(timer);
    walletBusy = false;
    renderWallet();
  }
}

// ---------- latest transactions of one account (tap on a row of the Conti table) ----------
const txOpen = new Set();     // ids of the accounts whose detail is open
const txData = new Map();     // id -> { at, body } | { at, error } | { loading: true }
const TX_STALE_MS = 60 * 1000;

function toggleTx(a) {
  if (txOpen.has(a.id)) { txOpen.delete(a.id); renderWallet(); return; }
  txOpen.add(a.id);
  const have = txData.get(a.id);
  if (!have || (!have.loading && Date.now() - have.at > TX_STALE_MS)) loadTx(a.id);
  renderWallet();
}

async function loadTx(id) {
  if (!conn) return;
  txData.set(id, { loading: true });
  try {
    let res;
    try {
      res = await fetch(conn.url + '/accounts/transactions?id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + conn.token }, cache: 'no-store' });
    } catch { throw new Error('Worker non raggiungibile'); }
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok) throw new Error(res.status === 404 && out && out.error === 'not_found' ? 'il Worker non ha ancora questa funzione' : (out && out.message) || 'HTTP ' + res.status);
    txData.set(id, { at: Date.now(), body: out });
  } catch (e) {
    txData.set(id, { at: Date.now(), error: e.message });
  }
  renderWallet();
}

const TX_LABEL = { pending: 'in sospeso', excluded: 'escluso', uncleared: 'non confermato', hold: 'dal disponibile' };
const TX_HELP = {
  pending: 'In sospeso: aggiunto al saldo contabilizzato della banca.',
  excluded: 'Pending già sostituito dal movimento contabilizzato: non conteggiato, per non contarlo due volte.',
  posted: 'Contabilizzato: già compreso nel saldo della banca.',
  uncleared: 'Registrato in Wallet ma non ancora confermato dalla banca: conta nel saldo di Wallet.',
  hold: 'Somma che la banca trattiene sul credito disponibile (limite − disponibile − debito) senza che Plaid elenchi il movimento: conteggiata come in sospeso.',
};

/** Detail row under an account: how the balance is made and its latest transactions. */
function txDetailRow(a) {
  const tr = document.createElement('tr');
  tr.className = 'txd';
  const td = document.createElement('td');
  td.colSpan = 5;
  tr.append(td);
  const st = txData.get(a.id);
  // Amounts in a note stay on one line ("−$120.50" never splits after the sign).
  const note = (text, cls) => {
    const d = document.createElement('div');
    d.className = 'txn' + (cls ? ' ' + cls : '');
    for (const [i, part] of text.split(/([−-]?[$€][\d,.]*\d)/).entries()) {
      if (!part) continue;
      if (i % 2) { const n = document.createElement('span'); n.className = 'nw'; n.textContent = part; d.append(n); } else d.append(part);
    }
    td.append(d);
  };
  if (!st || st.loading) { note('Carico i movimenti…'); return tr; }
  if (st.error) { note('Movimenti non disponibili: ' + st.error, 'down'); return tr; }
  const d = st.body;
  const cur = a.currency || d.currency;
  if (d.source === 'plaid') {
    note(`Saldo = contabilizzato dalla banca ${fmtMoney(d.posted, cur)} + in sospeso ${fmtMoney(d.pending, cur)}`
      + (d.unlisted ? ` (di cui trattenute non elencate ${fmtMoney(d.unlisted, cur)})` : '')
      + ` = ${fmtMoney(d.balance, cur)}. I movimenti contabilizzati sono già nel saldo della banca: si aggiungono solo quelli in sospeso.`);
    if (d.asOf) note(`Movimenti degli ultimi ${d.windowDays} giorni, aggiornati da Plaid il ${new Date(d.asOf).toLocaleString('it-IT', { timeZone: TZ() })}.`, 'muted');
  } else {
    note('Saldo calcolato da Wallet come somma di tutti i movimenti registrati: qui gli ultimi ' + (d.transactions || []).length + '.');
  }
  const list = (d.unlisted ? [{ date: null, name: 'Trattenuta non elencata da Plaid', amount: d.unlisted, status: 'hold' }] : [])
    .concat(d.transactions || []);
  if (!list.length) { note(d.transactions ? 'Nessun movimento nel periodo.' : 'Movimenti non ancora letti: aggiorna.', 'muted'); return tr; }
  const box = document.createElement('div');
  box.className = 'txl';
  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'txr ' + t.status;
    row.title = TX_HELP[t.status] || '';
    const day = document.createElement('span'); day.className = 'txdt'; day.textContent = fmtDay(t.date);
    const nm = document.createElement('span'); nm.className = 'txnm';
    const nt = document.createElement('span'); nt.className = 'txnt'; nt.textContent = t.name || '(senza descrizione)';
    nm.append(nt);
    const label = TX_LABEL[t.status] || (t.transfer ? 'trasferimento' : '');
    if (label) { const b = document.createElement('span'); b.className = 'txb'; b.textContent = label; nm.append(b); }
    const amt = document.createElement('span'); amt.className = 'txam' + (t.amount > 0 ? ' up' : '');
    amt.textContent = (t.amount > 0 ? '+' : '') + fmtMoney(t.amount, cur);
    row.append(day, nm, amt);
    box.append(row);
  }
  td.append(box);
  return tr;
}

// ---------- Plaid Link: connect a bank, or re-authorise one (update mode) ----------
const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const PLAID_STATE = 'pt.plaidLink';   // link token kept across the bank's OAuth redirect
const plaidMsg = (text, bad) => { const o = el('wallet-refresh-msg'); o.textContent = text; o.classList.toggle('down', !!bad); };

function loadPlaid() {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = PLAID_SCRIPT;
    sc.onload = resolve;
    sc.onerror = () => reject(new Error('non riesco a caricare Plaid Link'));
    document.head.append(sc);
  });
}

async function workerPost(path, body) {
  let res;
  try {
    res = await fetch(conn.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch { throw new Error('Worker non raggiungibile'); }
  const out = await res.json().catch(() => null);
  if (!res.ok || !out || !out.ok) throw new Error((out && out.message) || 'HTTP ' + res.status);
  return out;
}

function startLink(token, itemId, receivedRedirectUri) {
  const handler = window.Plaid.create({
    token,
    receivedRedirectUri: receivedRedirectUri || undefined,
    onSuccess: async (publicToken, meta) => {
      try { localStorage.removeItem(PLAID_STATE); } catch { /* storage unavailable */ }
      try {
        // Update mode keeps the same access token: nothing to exchange.
        if (!itemId) await workerPost('/plaid/exchange', { publicToken, institutionName: meta && meta.institution && meta.institution.name });
        plaidMsg(itemId ? 'Banca ricollegata.' : `Collegata: ${(meta && meta.institution && meta.institution.name) || 'banca'}.`);
        lastForced = 0;
        await refreshWallet(true);
      } catch (e) { plaidMsg('Collegamento non salvato: ' + e.message, true); }
    },
    onExit: (err) => {
      try { localStorage.removeItem(PLAID_STATE); } catch { /* storage unavailable */ }
      if (err) plaidMsg('Plaid: ' + (err.display_message || err.error_message || err.error_code), true);
    },
  });
  handler.open();
}

async function openPlaid(itemId) {
  if (!conn) return;
  if (!itemId && !confirm('Ogni banca collegata usa 1 dei 10 collegamenti gratuiti di Plaid, anche se poi la scolleghi. Collega ogni banca una volta sola. Continuare?')) return;
  plaidMsg('Apro Plaid…');
  try {
    const redirectUri = location.origin + location.pathname;
    let r;
    try { r = await workerPost('/plaid/link-token', { itemId, redirectUri }); } catch (e) {
      // Redirect URI not registered in the Plaid dashboard: OAuth banks then use a popup instead.
      if (!/redirect/i.test(e.message)) throw e;
      r = await workerPost('/plaid/link-token', { itemId });
    }
    try { localStorage.setItem(PLAID_STATE, JSON.stringify({ linkToken: r.linkToken, itemId: itemId || null, at: Date.now() })); } catch { /* storage unavailable */ }
    await loadPlaid();
    plaidMsg('');
    startLink(r.linkToken, itemId);
  } catch (e) { plaidMsg('Plaid: ' + e.message, true); }
}
el('plaid-link').onclick = () => openPlaid(null);

/** Read-only check of Plaid's institution list: links nothing and uses no Item. */
el('plaid-search').onclick = async () => {
  if (!conn) return;
  const q = (prompt('Nome dell\'istituto da cercare in Plaid', '') || '').trim();
  if (q.length < 2) return;
  plaidMsg('Cerco…');
  try {
    let res;
    try {
      res = await fetch(conn.url + '/plaid/institutions?q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + conn.token }, cache: 'no-store' });
    } catch { throw new Error('Worker non raggiungibile'); }
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok) throw new Error((out && out.message) || 'HTTP ' + res.status);
    if (!out.institutions.length) { plaidMsg(`Plaid: nessun istituto trovato per "${q}".`); return; }
    plaidMsg(out.institutions.map((i) => `${i.name}: ${i.products.join(', ') || 'nessun prodotto'}${i.oauth ? ' (OAuth)' : ''}`).join(' · '));
  } catch (e) { plaidMsg('Plaid: ' + e.message, true); }
};

function renderPlaidItems(plaid) {
  const box = el('plaid-items');
  box.replaceChildren();
  el('plaid-link').hidden = !(plaid && plaid.configured);
  el('plaid-search').hidden = !(plaid && plaid.configured);
  if (!plaid || !plaid.items || !plaid.items.length) return;
  for (const it of plaid.items) {
    const row = document.createElement('div');
    row.className = 'it';
    const label = document.createElement('span');
    label.textContent = `${it.institution || 'Banca'} (Plaid): ` + (it.ok
      ? `${it.accounts} ${it.accounts === 1 ? 'conto' : 'conti'}${it.pendingKnown ? '' : ', movimenti in sospeso non ancora disponibili'}`
      : `errore ${it.error && it.error.code}, mostro i dati di Wallet`);
    if (!it.ok) label.className = 'bad';
    if (it.ok && it.txRefreshError) {
      const w = document.createElement('span');
      w.className = 'bad';
      w.textContent = ` · aggiornamento movimenti su richiesta non disponibile (${it.txRefreshError.code})`;
      w.title = it.txRefreshError.message || '';
      label.append(w);
    }
    row.append(label);
    if (!it.ok && it.error && /LOGIN|CONSENT|EXPIRED|PENDING_DISCONNECT|PENDING_EXPIRATION/.test(it.error.code || '')) {
      const b = document.createElement('button');
      b.className = 'btn sec'; b.type = 'button'; b.textContent = 'Riconnetti';
      b.onclick = () => openPlaid(it.itemId);
      row.append(b);
    }
    box.append(row);
  }
}

/** Renames an account for every device (Worker), or a local manual account in this browser. */
async function renameAccount(a) {
  const input = prompt(`Nuovo nome per "${a.name}" (vuoto = nome originale${a.originalName ? ': ' + a.originalName : ''})`, a.name);
  if (input === null) return;
  const name = input.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (a.local) {
    const x = extras.find((e) => e.id === a.localId);
    if (x) {
      try { await manualOp({ op: 'upsert', account: { ...x, name: name || 'Conto manuale' } }); } catch (e) { plaidMsg('Rinomina non riuscita: ' + e.message, true); }
      renderWallet();
    }
    return;
  }
  try {
    const r = await workerPost('/accounts/rename', { id: a.id, name });
    // Show it at once; the next refresh brings the same name from the Worker on every device.
    for (const acc of wallet.data.accounts) {
      if (acc.id !== a.id) continue;
      if (r.name) { acc.originalName = acc.originalName || acc.name; acc.name = r.name; }
      else if (acc.originalName) { acc.name = acc.originalName; delete acc.originalName; }
    }
    write(LS.wallet, wallet);
    renderWallet();
    plaidMsg(r.name ? `Rinominato in "${r.name}".` : 'Ripristinato il nome originale.');
  } catch (e) { plaidMsg('Rinomina non riuscita: ' + e.message, true); }
}

// Dates in the accounts table follow the selected time zone.
window.addEventListener('pt-tz', () => { if (wallet || walletErr) renderWallet(); });
if (window.__ptTest) Object.assign(window.__ptTest, { fmtDay, fmtTxWhen });

const FORCE_COOLDOWN_MS = 60 * 1000;
/** Second forced read after asking Plaid to refresh the transactions (more than FORCE_COOLDOWN_MS). */
const TX_RECHECK_MS = 90 * 1000;
let lastForced = 0;
let txRecheckTimer = 0;
el('wallet-refresh').onclick = async () => {
  const btn = el('wallet-refresh'), out = el('wallet-refresh-msg');
  const wait = Math.ceil((lastForced + FORCE_COOLDOWN_MS - Date.now()) / 1000);
  if (wait > 0) { out.textContent = `Riprova tra ${wait} s (limite di richieste di Wallet).`; return; }
  lastForced = Date.now();
  const before = wallet && wallet.data && wallet.data.dataChangedAt;
  btn.disabled = true; btn.textContent = 'Aggiorno…'; out.textContent = '';
  await refreshWallet(true);
  btn.disabled = false; btn.textContent = 'Aggiorna ora';
  const after = wallet && wallet.data && wallet.data.dataChangedAt;
  if (walletErr) { out.textContent = ''; return; }
  // What this press did, bank by bank: Plaid first (it is where new transactions come from).
  const items = (wallet.data.plaid && wallet.data.plaid.items) || [];
  const names = (list) => list.map((it) => it.institution || 'banca').join(', ');
  const asked = items.filter((it) => it.txRefreshRequested);
  const throttled = items.filter((it) => it.txRefreshThrottled);
  const slow = items.filter((it) => it.liveLate);
  const msg = [];
  if (asked.length) msg.push(`Chiesto a Plaid di riscaricare i movimenti (${names(asked)}).`);
  if (throttled.length) {
    const at = Math.max(...throttled.map((it) => it.txRefreshAt || 0));
    msg.push(`Movimenti già richiesti a Plaid alle ${new Date(at).toLocaleTimeString('it-IT', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' })} (${names(throttled)}): al massimo una volta ogni 5 minuti per banca.`);
  }
  if (slow.length) msg.push(`Saldo in tempo reale in arrivo in background (${names(slow)}).`);
  if (items.length && !asked.length && !throttled.length) msg.push('Saldi Plaid riletti.');
  msg.push(after && after !== before ? 'Wallet aggiornato.' : 'Wallet senza novità (si sincronizza quando apri la sua app).');
  // Plaid fetches the transactions asynchronously after /transactions/refresh, and slow banks finish in
  // the background: read again shortly after.
  if (asked.length || slow.length) {
    msg.push(`Ricontrollo tra ${TX_RECHECK_MS / 1000} s.`);
    clearTimeout(txRecheckTimer);
    txRecheckTimer = setTimeout(async () => {
      lastForced = Date.now();
      await refreshWallet(true);
      if (!walletErr) out.textContent = 'Plaid ricontrollato: movimenti e saldi in background inclusi.';
    }, TX_RECHECK_MS);
  }
  out.textContent = msg.join(' ');
};

// ---------- private labels (e.g. the broker's real name), served by the Worker from its KV ----------
let labels = read(LS.labels);   // { broker, brokerKey }
/** Downloads the labels; resolves true when they changed. Never throws. */
async function loadLabels() {
  if (!conn) return false;
  try {
    const res = await fetch(conn.url + '/labels', { headers: { Authorization: 'Bearer ' + conn.token }, cache: 'no-store' });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok || !out.labels) return false;
    const changed = JSON.stringify(out.labels) !== JSON.stringify(labels || {});
    labels = out.labels;
    write(LS.labels, labels);
    return changed;
  } catch { return false; }
}

// ---------- boot ----------
if (remote && !validSnap(remote.snap)) remote = null;
if (conn && !(typeof conn.token === 'string' && cleanUrl(conn.url) === conn.url)) conn = null;
if (remote && labels) {
  start();            // open at once on the cached copy, then look for a newer one
  refresh();
  loadLabels().then((changed) => { if (changed) location.reload(); });
} else if (remote) {
  loadLabels().finally(() => { start(); refresh(); });
} else if (conn) {
  el('boot-msg').hidden = false;
  refresh().then(async (r) => {
    if (remote) {
      const had = !!labels;
      if (!had) await loadLabels();
      start();
      if (had) loadLabels().then((changed) => { if (changed) location.reload(); });
    } else { el('boot-msg').hidden = true; openConnect(r.text); }
  });
} else {
  openConnect();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app && conn && Date.now() - ((remote && remote.checkedAt) || 0) > RECHECK_MS) refresh();
});
setInterval(() => { if (!document.hidden && app && conn && Date.now() - ((remote && remote.checkedAt) || 0) > 3 * RECHECK_MS) refresh(); }, RECHECK_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && app) refreshWallet(); });
// Back from a bank's OAuth page: resume Plaid Link with the token saved before leaving.
if (/[?&]oauth_state_id=/.test(location.search) && conn) {
  const back = location.href;
  history.replaceState(null, '', location.pathname);
  const st = read(PLAID_STATE);
  if (st && st.linkToken && Date.now() - st.at < 30 * 60 * 1000) loadPlaid().then(() => startLink(st.linkToken, st.itemId, back)).catch((e) => plaidMsg('Plaid: ' + e.message, true));
}
setInterval(() => { if (!document.hidden && app) refreshWallet(); }, RECHECK_MS);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
})();
