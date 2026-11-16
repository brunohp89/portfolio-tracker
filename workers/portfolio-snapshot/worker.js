/**
 * Cloudflare Worker: serves the latest files written by the Portfolio Brief (the tracker's
 * positions snapshot and the brief's dashboard page) from ONE Google Drive folder.
 *
 * The Worker authenticates to Google as a service account. That identity can only see what
 * has been shared with its email address, so sharing a single folder with it (as Viewer)
 * limits the Worker to that folder, whatever this code does.
 *
 * Variables and Secrets (Worker -> Settings):
 *   TOKEN           secret    shared secret; the app sends it as "Authorization: Bearer <TOKEN>"
 *   GOOGLE_SA_KEY   secret    the whole JSON key file of the service account
 *   FOLDER_ID       text      id of the Drive folder shared with the service account
 *   ALLOWED_ORIGIN  text      optional, e.g. https://yourname.github.io (default: any origin)
 *   SNAPSHOT_NAME   text      optional, default portfolio_tracker_snapshot.json
 *   BRIEF_NAME      text      optional, default portfolio_brief.html
 *   WALLET_API_TOKEN secret   BudgetBakers Wallet REST API token (for /wallet)
 *   CREDIT_LIMITS   secret    optional JSON {"<Wallet account name>": limit}; wins over Wallet's limit
 *   PLAID_CLIENT_ID text      Plaid client id (optional: without the Plaid trio /wallet is Wallet only)
 *   PLAID_SECRET    secret    Plaid secret for PLAID_ENV
 *   PLAID_ENV       text      optional, "production" (default) or "sandbox"
 *   PLAID_COUNTRY_CODES text  comma-separated Plaid country codes for Link and the institution search
 *   PLAID_KV        KV        namespace holding the Plaid access tokens, one key per linked bank
 *
 * Endpoints:
 *   GET /            liveness check, no data
 *   GET /snapshot    newest file named SNAPSHOT_NAME in the folder, as JSON
 *   GET /brief       newest file named BRIEF_NAME in the folder, as HTML
 *   GET /check       metadata of both files (for setting things up)
 *   GET /wallet      balance of every BudgetBakers Wallet account (investments excluded),
 *                    credit card utilization and totals; cached in memory for WALLET_TTL_MS.
 *                    ?fresh=1 skips the cache if it is older than WALLET_FORCE_MIN_MS.
 *                    Accounts linked through Plaid replace their Wallet twin (same last 4
 *                    digits) with the bank's live balance, pending transactions included.
 *   POST /plaid/link-token   {itemId?, redirectUri?} -> {linkToken} to open Plaid Link
 *                            (itemId = update mode, to re-authorise a linked bank)
 *   POST /plaid/exchange     {publicToken, institutionName?} -> stores the bank's access token
 *   POST /accounts/rename    {id, name} -> custom display name for an account, kept in PLAID_KV
 *                            ("names") so every device shows it; an empty name restores the original
 *   GET  /labels             private display labels kept in PLAID_KV ("labels"), e.g. the broker's
 *                            name and the snapshot's field name for it, so the public code uses
 *                            placeholders only
 *   GET  /plaid/institutions?q=<name>  read-only search of Plaid's institution list, with the
 *                            products each one supports; links nothing and uses no Item
 * /snapshot and /brief send an ETag; a request carrying it in If-None-Match gets 304 when
 * nothing changed, without downloading the file from Drive.
 */

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/** Files this Worker may serve, by route. Nothing else in the folder is reachable through it. */
const ROUTES = {
  "/snapshot": { envName: "SNAPSHOT_NAME", fallback: "portfolio_tracker_snapshot.json", type: "application/json; charset=utf-8", json: true },
  "/brief": { envName: "BRIEF_NAME", fallback: "portfolio_brief.html", type: "text/html; charset=utf-8", json: false },
};
const MAX_BYTES = 8 * 1024 * 1024;

/** Google access token, reused across requests served by the same isolate. */
let accessCache = { token: "", expiresAt: 0, keyId: "" };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "POST" && path === "/accounts/rename") {
        await requireToken(request, env);
        return json(await renameAccount(env, (await request.json().catch(() => ({}))) || {}), 200, cors);
      }
      if (request.method === "POST" && PLAID_POST_ROUTES[path]) {
        await requireToken(request, env);
        if (!plaidConfigured(env)) throw new HttpError(500, "plaid_not_configured", "set PLAID_CLIENT_ID, PLAID_SECRET and the PLAID_KV binding");
        const input = await request.json().catch(() => ({}));
        return json(await PLAID_POST_ROUTES[path](env, input || {}), 200, cors);
      }
      if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
      if (path === "/") return json({ ok: true, app: "portfolio-snapshot" }, 200, cors);
      if (path !== "/check" && path !== "/wallet" && path !== "/labels" && path !== "/plaid/institutions" && !ROUTES[path]) throw new HttpError(404, "not_found");

      await requireToken(request, env);
      if (path === "/wallet") return json(await walletSummary(env, url.searchParams.get("fresh") === "1"), 200, cors);
      if (path === "/labels") {
        const labels = env.PLAID_KV ? await env.PLAID_KV.get("labels", "json").catch(() => null) : null;
        return json({ ok: true, labels: labels && typeof labels === "object" ? labels : {} }, 200, cors);
      }
      if (path === "/plaid/institutions") {
        if (!plaidConfigured(env)) throw new HttpError(500, "plaid_not_configured", "set PLAID_CLIENT_ID, PLAID_SECRET and the PLAID_KV binding");
        return json(await plaidInstitutions(env, url.searchParams.get("q")), 200, cors);
      }
      const describe = (file) => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime, size: Number(file.size) || null });
      if (path === "/check") {
        const found = {};
        for (const [route, spec] of Object.entries(ROUTES)) {
          const file = await latestFile(env, fileName(env, spec), false);
          found[route.slice(1)] = file ? describe(file) : null;
        }
        return json({ ok: true, ...found }, 200, cors);
      }

      const spec = ROUTES[path];
      const file = await latestFile(env, fileName(env, spec), true);
      const etag = `"${file.id}-${file.md5Checksum || file.modifiedTime}"`;
      const headers = { ...cors, ETag: etag, "Last-Modified": new Date(file.modifiedTime).toUTCString() };
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
      if (Number(file.size) > MAX_BYTES) throw new HttpError(502, "file_too_large");
      const body = await downloadFile(env, file.id);
      if (spec.json) {
        try {
          JSON.parse(body);
        } catch {
          throw new HttpError(502, "snapshot_not_json", "the snapshot file in Drive is not valid JSON");
        }
      }
      return new Response(body, { status: 200, headers: { ...headers, "Content-Type": spec.type } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "internal_error";
      return json({ ok: false, error: code, message: String((err && err.message) || err) }, status, cors);
    }
  },
};

// ---------- responses ----------

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").trim().replace(/\/+$/, "");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, If-None-Match, Content-Type",
    "Access-Control-Expose-Headers": "ETag, Last-Modified",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "private, no-store",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

// ---------- caller authentication ----------

async function requireToken(request, env) {
  if (!env.TOKEN || env.TOKEN.length < 16) throw new HttpError(500, "token_not_configured", "set the TOKEN secret (at least 16 characters)");
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given || !(await sameSecret(given, env.TOKEN))) throw new HttpError(401, "unauthorized");
}

/** Compares two secrets through their digests, in time independent of where they differ. */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- Google service account ----------

function serviceAccount(env) {
  if (!env.GOOGLE_SA_KEY) throw new HttpError(500, "key_not_configured", "set the GOOGLE_SA_KEY secret to the service account JSON key");
  let key;
  try {
    key = JSON.parse(env.GOOGLE_SA_KEY);
  } catch {
    throw new HttpError(500, "key_invalid", "GOOGLE_SA_KEY is not valid JSON: paste the whole key file");
  }
  if (!key.client_email || !key.private_key) throw new HttpError(500, "key_invalid", "GOOGLE_SA_KEY lacks client_email or private_key");
  return key;
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function signedAssertion(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id }));
  const claims = b64urlText(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URI, iat: now, exp: now + 3600 }));
  const pem = key.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new HttpError(500, "key_invalid", "the private_key in GOOGLE_SA_KEY cannot be imported");
  }
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

async function accessToken(env) {
  const key = serviceAccount(env);
  const now = Date.now();
  if (accessCache.token && accessCache.keyId === key.private_key_id && accessCache.expiresAt - 60000 > now) return accessCache.token;
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signedAssertion(key) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new HttpError(502, "google_auth_failed", `Google refused the service account (${res.status}): ${data.error_description || data.error || "no detail"}`);
  }
  accessCache = { token: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) * 1000, keyId: key.private_key_id };
  return accessCache.token;
}

async function driveFetch(env, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  if (res.status === 401) accessCache = { token: "", expiresAt: 0, keyId: "" };
  if (!res.ok) {
    const detail = await res.json().then((j) => j.error && j.error.message).catch(() => "");
    const hint = res.status === 403 ? " (is the Drive API enabled in the Google Cloud project?)" : res.status === 404 ? " (is the folder shared with the service account?)" : "";
    throw new HttpError(502, "drive_error", `Drive answered ${res.status}${detail ? ": " + detail : ""}${hint}`);
  }
  return res;
}

// ---------- file lookup ----------

function fileName(env, spec) {
  return (env[spec.envName] || spec.fallback).trim();
}

/** Newest non-trashed file with this exact name in the folder; null (or a 404 error when `required`) if none. */
async function latestFile(env, name, required) {
  const folder = (env.FOLDER_ID || "").trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folder)) throw new HttpError(500, "folder_not_configured", "set FOLDER_ID to the Drive folder id");
  const quoted = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${folder}' in parents and name = '${quoted}' and trashed = false`,
    orderBy: "modifiedTime desc",
    pageSize: "1",
    fields: "files(id,name,modifiedTime,size,md5Checksum)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await (await driveFetch(env, `${DRIVE_FILES}?${params}`)).json();
  const file = data.files && data.files[0];
  if (!file && required) {
    throw new HttpError(404, "no_snapshot", `no file named ${name} is visible in the folder: either the brief has not written it yet or the folder is not shared with the service account`);
  }
  return file || null;
}

async function downloadFile(env, id) {
  const res = await driveFetch(env, `${DRIVE_FILES}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new HttpError(502, "file_too_large");
  return text;
}
// ---------- BudgetBakers Wallet balances ----------

const WALLET_API = "https://rest.budgetbakers.com/wallet/v1/api";
const WALLET_PAGE = 200;
const WALLET_TTL_MS = 10 * 60 * 1000;
/** Shortest gap between two forced refreshes, to stay well inside Wallet's 300 requests/hour. */
const WALLET_FORCE_MIN_MS = 60 * 1000;
/** Valued by the portfolio tracker from market prices, not from Wallet. */
const WALLET_EXCLUDED_TYPES = new Set(["Investment"]);
/** Credit limits by Wallet account name from the CREDIT_LIMITS secret (kept out of this public code). */
function creditLimitOverrides(env) {
  if (!env.CREDIT_LIMITS) return {};
  try {
    const parsed = JSON.parse(env.CREDIT_LIMITS);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(500, "credit_limits_invalid", "CREDIT_LIMITS is not valid JSON");
  }
}

/** Last summary, reused across requests served by the same isolate. */
let walletCache = { at: 0, body: null };
/** After a 429, Wallet is not called again before this time (its Retry-After). */
let walletBackoffUntil = 0;

const round2 = (n) => Math.round(n * 100) / 100;

async function walletFetch(env, path, params) {
  const url = `${WALLET_API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.WALLET_API_TOKEN}`, Accept: "application/json" } });
  if (res.status === 409) throw new HttpError(503, "wallet_initial_sync", "Wallet is still running its first sync, retry in a few minutes");
  if (res.status === 429) {
    const retryS = Math.max(60, Number(res.headers.get("Retry-After")) || 0);
    walletBackoffUntil = Date.now() + retryS * 1000;
    throw new HttpError(503, "wallet_rate_limited", `Wallet rate limit reached, retry after ${retryS} s`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, "wallet_unauthorized", "Wallet refused WALLET_API_TOKEN");
  if (!res.ok) throw new HttpError(502, "wallet_error", `Wallet answered ${res.status}`);
  return { data: await res.json(), headers: res.headers };
}

async function walletAccounts(env) {
  const accounts = [];
  let headers = null;
  for (let offset = 0; ; ) {
    const page = await walletFetch(env, "accounts", { archived: "false", limit: String(WALLET_PAGE), offset: String(offset) });
    headers = headers || page.headers;
    const items = page.data.accounts || [];
    accounts.push(...items);
    if (!items.length || page.data.nextOffset == null) break;
    offset = Number(page.data.nextOffset);
  }
  return { accounts, headers };
}

const YAHOO_EURUSD = "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=5d";

/** EURUSD from Yahoo Finance, the same source the brief uses; null if Yahoo does not answer. */
async function yahooEurUsd() {
  try {
    const res = await fetch(YAHOO_EURUSD, {
      headers: {
        // Same headers as the yahoo-proxy Worker: Yahoo refuses requests without a browser agent.
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const meta = (await res.json()).chart.result[0].meta;
    const rate = Number(meta.regularMarketPrice);
    if (!(rate > 0.5 && rate < 2.5)) return null; // sanity bounds for EURUSD
    const at = Number(meta.regularMarketTime) * 1000;
    const iso = new Date(at || Date.now()).toISOString();
    return { rate, asOf: iso.slice(0, 10), at: iso, source: "yahoo" };
  } catch {
    return null;
  }
}

/** EURUSD from Wallet's conversion of the latest EUR record (rate of that record's date): fallback only. */
async function walletEurUsd(env, accounts) {
  const ids = accounts.filter((a) => a.currencyCode === "EUR").map((a) => a.id).slice(0, 10);
  if (!ids.length) return null;
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  try {
    const { data } = await walletFetch(env, "records", {
      accountId: ids.join(","), convertTo: "USD", sortBy: "-recordDate", limit: "1", recordDate: `gte.${since}`,
    });
    const rec = data.records && data.records[0];
    const rate = rec && rec.convertedAmount && Number(rec.convertedAmount.ratio);
    return rate ? { rate, asOf: rec.recordDate.slice(0, 10), source: "wallet" } : null;
  } catch {
    return null;
  }
}

function walletAccount(a, limits) {
  const bal = a.balance || {};
  // rawCurrentBalance is the signed ledger value; Wallet's display formula for bank-synced
  // cards applies -abs(), which would turn an overpayment into debt.
  const raw = Number(bal.rawCurrentBalance ?? bal.currentBalance ?? 0);
  const last = a.recordStats && a.recordStats.recordDate && a.recordStats.recordDate.max;
  const mask = /(\d{4})$/.exec(a.bankAccountNumber || "");
  const out = {
    id: a.id,
    name: a.name,
    type: a.accountType,
    currency: a.currencyCode,
    source: "wallet",
    mask: mask ? mask[1] : null,
    bankSync: !!a.isBankSync,
    balance: round2(raw),
    lastRecordDate: last ? last.slice(0, 10) : null,
    // Wallet exposes no "last bank sync" field: the account document's last change is the closest
    // proxy (it moves on each sync round). Only meaningful for bank-synced accounts.
    lastSync: a.isBankSync && a.updatedAt ? a.updatedAt : null,
    credit: null,
  };
  if (a.accountType === "CreditCard") {
    const owed = round2(Math.max(0, -raw));
    const limit = Number(limits[a.name]) || Number(bal.creditLimit) || null;
    out.credit = {
      owed,
      limit,
      available: limit ? round2(limit - owed) : null,
      utilizationPct: limit ? Math.round((1000 * owed) / limit) / 10 : null,
    };
  }
  return out;
}

const WALLET_LAST_KEY = "wallet:last";

/**
 * Last successful Wallet read, so a Wallet outage does not hide the Plaid balances: memory first,
 * then PLAID_KV (survives new isolates). Written at most once per WALLET_TTL_MS.
 */
let walletLast = { at: 0, accounts: null };
async function saveWalletLast(env, accounts) {
  walletLast = { at: Date.now(), accounts };
  if (env.PLAID_KV) await env.PLAID_KV.put(WALLET_LAST_KEY, JSON.stringify(walletLast)).catch(() => {});
}
async function loadWalletLast(env) {
  if (walletLast.accounts || !env.PLAID_KV) return walletLast;
  const saved = await env.PLAID_KV.get(WALLET_LAST_KEY, "json").catch(() => null);
  if (saved && Array.isArray(saved.accounts)) walletLast = saved;
  return walletLast;
}

async function walletSummary(env, force) {
  if (!env.WALLET_API_TOKEN) throw new HttpError(500, "wallet_not_configured", "set the WALLET_API_TOKEN secret");
  const age = Date.now() - walletCache.at;
  if (walletCache.body && age < (force ? WALLET_FORCE_MIN_MS : WALLET_TTL_MS)) return walletCache.body;
  const plaidOn = plaidConfigured(env);
  const limits = creditLimitOverrides(env);
  // Plaid and FX run alongside Wallet: the slowest source sets the response time, not their sum.
  const sidePromise = Promise.all([yahooEurUsd(), plaidSummary(env, limits, force)]);
  sidePromise.catch(() => {}); // awaited below; avoids an unhandled rejection on the early returns

  let all = null;
  let headers = null;
  let walletError = null;
  if (Date.now() < walletBackoffUntil) {
    // Never call Wallet again while it asked us to wait.
    walletError = { code: "wallet_rate_limited", message: `retry after ${Math.ceil((walletBackoffUntil - Date.now()) / 1000)} s` };
  } else {
    try {
      ({ accounts: all, headers } = await walletAccounts(env));
      await saveWalletLast(env, all);
    } catch (err) {
      walletError = { code: (err instanceof HttpError && err.code) || "wallet_error", message: String((err && err.message) || err) };
    }
  }
  let walletStale = null;
  if (walletError) {
    // Without Plaid there is nothing fresh to show: keep the old behaviour (last answer, else error).
    if (!plaidOn) {
      if (walletCache.body) return walletCache.body;
      throw new HttpError(walletError.code === "wallet_rate_limited" ? 503 : 502, walletError.code, walletError.message);
    }
    const last = await loadWalletLast(env);
    all = last.accounts || [];
    walletStale = last.accounts ? new Date(last.at).toISOString() : null;
  }
  const kept = all.filter((a) => !WALLET_EXCLUDED_TYPES.has(a.accountType) && !a.isInvestmentAccount);
  const [yfx, plaid] = await sidePromise;
  const fx = yfx || (walletError ? null : await walletEurUsd(env, kept));
  const accounts = mergeAccounts(kept.map((a) => walletAccount(a, limits)), plaid.accounts);
  // Custom names last, so CREDIT_LIMITS and the Wallet/Plaid matching keep using the original names.
  const names = await loadNames(env);
  for (const a of accounts) {
    const custom = names[a.id] || (a.walletId && names[a.walletId]);
    if (custom) { a.originalName = a.name; a.name = custom; }
  }

  const byCurrency = {};
  for (const a of accounts) byCurrency[a.currency] = round2((byCurrency[a.currency] || 0) + a.balance);
  let total = null;
  if (fx && Object.keys(byCurrency).every((c) => c === "USD" || c === "EUR")) {
    const usd = (byCurrency.USD || 0) + (byCurrency.EUR || 0) * fx.rate;
    total = { usd: round2(usd), eur: round2(usd / fx.rate) };
  }
  const cards = accounts.filter((a) => a.credit && a.credit.limit);
  const owed = cards.reduce((s, a) => s + a.credit.owed, 0);
  const limit = cards.reduce((s, a) => s + a.credit.limit, 0);

  const body = {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataChangedAt: headers && headers.get("X-Last-Data-Change-At"),
    syncInProgress: headers ? headers.get("X-Sync-In-Progress") === "true" : null,
    pendingIncluded: accounts.some((a) => a.pending && a.pending.known),
    fx,
    plaid: { configured: plaid.configured, items: plaid.items, pendingDays: PLAID_PENDING_DAYS },
    // Wallet outage: Plaid accounts are fresh, Wallet-only accounts come from staleSince (or are missing).
    wallet: { ok: !walletError, error: walletError, staleSince: walletStale, accounts: kept.length },
    accounts,
    totals: { byCurrency, ...(total || {}) },
    credit: limit ? { owed: round2(owed), limit: round2(limit), utilizationPct: Math.round((1000 * owed) / limit) / 10 } : null,
  };
  walletCache = { at: Date.now(), body };
  return body;
}

// ---------- Plaid: live balances and pending transactions straight from the banks ----------

const PLAID_HOSTS = { production: "https://production.plaid.com", sandbox: "https://sandbox.plaid.com" };
const PLAID_ITEM_PREFIX = "item:";
/** Pending transactions are looked up in this window; they rarely stay pending longer. */
const PLAID_PENDING_DAYS = 14;
const PLAID_POST_ROUTES = { "/plaid/link-token": plaidLinkToken, "/plaid/exchange": plaidExchange };

const plaidConfigured = (env) => !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.PLAID_KV);

/** Country codes for Plaid Link and the institution search, from PLAID_COUNTRY_CODES (kept out of the code). */
function plaidCountries(env) {
  const codes = String(env.PLAID_COUNTRY_CODES || "").split(",").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (!codes.length) throw new HttpError(500, "plaid_countries_not_configured", "set PLAID_COUNTRY_CODES, e.g. a comma-separated list of country codes");
  return codes;
}

async function plaidCall(env, path, body, timeoutMs) {
  const host = PLAID_HOSTS[(env.PLAID_ENV || "production").trim()] || PLAID_HOSTS.production;
  let res;
  try {
    res = await fetch(host + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID.trim(), "PLAID-SECRET": env.PLAID_SECRET.trim() },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    if (!(e && (e.name === "TimeoutError" || e.name === "AbortError"))) throw e;
    const err = new HttpError(504, "plaid_timeout", `Plaid did not answer ${path} within ${timeoutMs / 1000} s`);
    err.plaidCode = "TIMEOUT";
    err.plaidMessage = err.message;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(502, "plaid_error", `${data.error_code || res.status}: ${data.error_message || "Plaid refused the request"}`);
    err.plaidCode = data.error_code || null;
    err.plaidMessage = data.display_message || data.error_message || null;
    throw err;
  }
  return data;
}

async function plaidItems(env) {
  const list = await env.PLAID_KV.list({ prefix: PLAID_ITEM_PREFIX });
  const items = await Promise.all(list.keys.map((k) => env.PLAID_KV.get(k.name, "json")));
  return items.filter(Boolean);
}

/** Link token for Plaid Link: a new bank, or update mode for an already linked one (itemId). */
async function plaidLinkToken(env, input) {
  const body = { client_name: "Portfolio Tracker", language: "en", country_codes: plaidCountries(env), user: { client_user_id: "owner" } };
  if (input.itemId) {
    const item = await env.PLAID_KV.get(PLAID_ITEM_PREFIX + String(input.itemId), "json");
    if (!item) throw new HttpError(404, "plaid_item_not_found", "no linked bank with this id");
    body.access_token = item.accessToken;
  } else {
    body.products = ["transactions"];
    body.transactions = { days_requested: 30 };
  }
  if (typeof input.redirectUri === "string" && /^https:\/\/[^\s]+$/.test(input.redirectUri)) body.redirect_uri = input.redirectUri;
  const data = await plaidCall(env, "/link/token/create", body);
  return { ok: true, linkToken: data.link_token, expiration: data.expiration };
}

/** Swaps Link's one-time public token for the bank's access token and keeps it in KV only. */
async function plaidExchange(env, input) {
  if (typeof input.publicToken !== "string" || !input.publicToken) throw new HttpError(400, "bad_request", "publicToken missing");
  const ex = await plaidCall(env, "/item/public_token/exchange", { public_token: input.publicToken });
  let institutionId = null;
  try {
    institutionId = (await plaidCall(env, "/item/get", { access_token: ex.access_token })).item.institution_id || null;
  } catch { /* the name from Link is enough */ }
  const institutionName = typeof input.institutionName === "string" ? input.institutionName.slice(0, 80) : null;
  const item = { itemId: ex.item_id, accessToken: ex.access_token, institutionId, institutionName, linkedAt: new Date().toISOString() };
  await env.PLAID_KV.put(PLAID_ITEM_PREFIX + ex.item_id, JSON.stringify(item));
  walletCache = { at: 0, body: null };
  plaidCache = { at: 0, items: null, accounts: null };
  await env.PLAID_KV.delete(PLAID_CACHE_KEY).catch(() => {});
  return { ok: true, itemId: ex.item_id, institutionName };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Asks Plaid to fetch this bank's transactions now (asynchronous: new items show up on a later read). */
async function plaidTxRefresh(env, item, prev, today) {
  const at = (prev && prev.txRefreshAt) || 0;
  const blockedUntil = (prev && prev.txRefreshBlockedUntil) || 0;
  if (today < blockedUntil || today - at < PLAID_TX_REFRESH_MIN_MS) {
    return { at, blockedUntil, error: (prev && prev.txRefreshError) || null };
  }
  try {
    await plaidCall(env, "/transactions/refresh", { access_token: item.accessToken }, PLAID_CALL_TIMEOUT_MS);
    return { at: today, blockedUntil: 0, error: null, requested: true };
  } catch (err) {
    const error = { code: err.plaidCode || "plaid_error", message: err.plaidMessage || String(err.message) };
    // Not enabled for this Plaid account (e.g. a plan without the add-on): stop asking for a day.
    const notEnabled = /PRODUCT|NOT_AUTHORIZED|NOT_ENABLED|NOT_ALLOWED/.test(error.code) || /not (authorized|enabled)|add-on/i.test(error.message);
    return { at: today, blockedUntil: notEnabled ? today + PLAID_TX_REFRESH_BLOCK_MS : 0, error };
  }
}

/** Raw balances kept with the Item status, so a recent real-time read can be reused without asking the bank again. */
const rawBalances = (accounts) => (accounts || []).map((a) => ({
  account_id: a.account_id, balances: a.balances, type: a.type, subtype: a.subtype, mask: a.mask, name: a.name, official_name: a.official_name,
}));

/** Live balances (from the bank) and the pending transactions of one linked bank. */
async function plaidItemData(env, item, prev, force) {
  const today = Date.now();
  // Real-time balance (/accounts/balance/get) is rate limited to 5/min and 30/hour per Item in
  // Production (BALANCE_LIMIT). Use it at most once per PLAID_LIVE_MIN_MS per Item, never while a
  // BALANCE_LIMIT block is on, and fall back to /accounts/get (Plaid's cached balances) otherwise.
  // A real-time read younger than PLAID_LIVE_MIN_MS is fresher than Plaid's cache: its balances are
  // reused, while the transactions are always read again.
  const blockedUntil = (prev && prev.liveBlockedUntil) || 0;
  const lastLive = (prev && prev.liveAt) || 0;
  const reuseLive = !!(prev && prev.ok && prev.balanceLive && prev.raw && prev.raw.length && today - lastLive < PLAID_LIVE_MIN_MS);
  const tryLive = !reuseLive && today >= blockedUntil && today - lastLive >= PLAID_LIVE_MIN_MS;
  let liveError = null;
  const ms = {};
  const timed = (key, promise) => {
    const t0 = Date.now();
    return promise.finally(() => { ms[key] = Date.now() - t0; });
  };
  const balanceRead = (async () => {
    if (reuseLive) return { data: { accounts: prev.raw }, live: true, reused: true };
    if (tryLive) {
      // The real-time read waits for the bank and can take tens of seconds: past PLAID_LIVE_TIMEOUT_MS
      // Plaid's cached balances are used instead (no block: the next read tries live again).
      try {
        return { data: await timed("live", plaidCall(env, "/accounts/balance/get", { access_token: item.accessToken }, PLAID_LIVE_TIMEOUT_MS)), live: true };
      } catch (err) {
        liveError = err;
      }
    }
    return { data: await timed("cached", plaidCall(env, "/accounts/get", { access_token: item.accessToken }, PLAID_CALL_TIMEOUT_MS)), live: false };
  })();
  const [balRead, tx, itemInfo, refresh] = await Promise.allSettled([
    balanceRead,
    timed("tx", plaidCall(env, "/transactions/get", {
      access_token: item.accessToken,
      start_date: isoDay(today - PLAID_PENDING_DAYS * 86400000),
      end_date: isoDay(today + 86400000),
      options: { count: 500 },
    }, PLAID_CALL_TIMEOUT_MS)),
    timed("item", plaidCall(env, "/item/get", { access_token: item.accessToken }, PLAID_CALL_TIMEOUT_MS)),
    force ? timed("refresh", plaidTxRefresh(env, item, prev, today)) : Promise.resolve(null),
  ]);
  // Last time Plaid refreshed this bank's data (balances from /accounts/get come from the same refresh).
  const txStatus = itemInfo.status === "fulfilled" && itemInfo.value.status && itemInfo.value.status.transactions;
  const live = balRead.status === "fulfilled" && balRead.value.live;
  const bal = balRead.status === "fulfilled" ? { status: "fulfilled", value: balRead.value.data } : balRead;
  const reused = live && balRead.value.reused;
  const liveAt = live ? (reused ? lastLive : today) : lastLive;
  // Balances: time of the real-time read, or of Plaid's last refresh. Transactions (and so the
  // pending list) only change when Plaid refreshes them, whatever the balance read: txUpdatedAt.
  const txUpdatedAt = (txStatus && txStatus.last_successful_update) || (prev && prev.txUpdatedAt) || null;
  const lastSync = live ? new Date(liveAt).toISOString() : txUpdatedAt || new Date(today).toISOString();
  const rf = (refresh.status === "fulfilled" && refresh.value) || {
    at: (prev && prev.txRefreshAt) || 0, blockedUntil: (prev && prev.txRefreshBlockedUntil) || 0, error: (prev && prev.txRefreshError) || null,
  };
  const status = {
    itemId: item.itemId,
    institution: item.institutionName,
    ok: bal.status === "fulfilled",
    error: null,
    pendingKnown: tx.status === "fulfilled",
    accounts: 0,
    lastSync,
    txUpdatedAt,
    txRefreshAt: rf.at,
    txRefreshRequested: !!rf.requested,
    txRefreshBlockedUntil: rf.blockedUntil,
    txRefreshError: rf.error,
    balanceLive: live,
    liveAt,
    liveBlockedUntil: liveError && liveError.plaidCode === "BALANCE_LIMIT" ? today + PLAID_LIVE_BLOCK_MS : blockedUntil,
    raw: live ? rawBalances(bal.value.accounts) : null,
    liveTimedOut: !!(liveError && liveError.plaidCode === "TIMEOUT"),
    ms, // duration of each Plaid call, for diagnosing slow refreshes
  };
  if (bal.status !== "fulfilled") {
    status.error = { code: bal.reason.plaidCode || "plaid_error", message: bal.reason.plaidMessage || String(bal.reason.message) };
    return { status, accounts: [] };
  }
  const pending = new Map();
  const lastPosted = new Map();
  if (tx.status === "fulfilled") {
    const txs = tx.value.transactions || [];
    // Guard 1: a posted transaction names the pending one it replaced; never count both.
    const replaced = new Set(txs.filter((t) => !t.pending && t.pending_transaction_id).map((t) => t.pending_transaction_id));
    for (const t of txs) {
      if (t.pending && replaced.has(t.transaction_id)) continue;
      if (t.pending) {
        const p = pending.get(t.account_id) || { out: 0, count: 0 };
        p.out += Number(t.amount) || 0; // Plaid: positive amount = money leaving the account
        p.count += 1;
        pending.set(t.account_id, p);
      } else if (!lastPosted.has(t.account_id) || t.date > lastPosted.get(t.account_id)) {
        lastPosted.set(t.account_id, t.date);
      }
    }
  }
  const accounts = (bal.value.accounts || [])
    .filter((a) => a.type !== "investment")
    .map((a) => ({ ...plaidAccount(a, item, pending.get(a.account_id), tx.status === "fulfilled", lastPosted.get(a.account_id)), lastSync, txUpdatedAt, balanceLive: live, itemId: item.itemId }));
  status.accounts = accounts.length;
  return { status, accounts };
}

function plaidAccount(a, item, pend, pendingKnown, lastDate) {
  const b = a.balances || {};
  const isCredit = a.type === "credit";
  const current = Number(b.current ?? b.available ?? 0);
  const posted = isCredit ? -current : current; // credit: Plaid's current is the amount owed
  const out = pend ? pend.out : 0;
  const computed = round2(posted - out);
  // Guard 2 (report only): compare with the bank's own figure that should include pending items
  // (credit: limit - available; depository: available). Balances alone cannot tell "the bank already
  // counts this pending" from "the bank's available figure ignores pending" (some card issuers do the
  // latter), so a listed pending is never removed here: a mismatch is only reported. Pending items
  // are dropped solely on hard evidence, i.e. guard 1 (pending_transaction_id).
  let implied = null;
  if (isCredit) {
    if (b.limit != null && b.available != null) implied = -(Number(b.limit) - Number(b.available));
  } else if (b.available != null) {
    implied = Number(b.available);
  }
  const balance = computed;
  let check = "unverified";
  if (implied != null && isFinite(implied)) check = Math.abs(implied - computed) < 0.005 ? "ok" : "differs";
  const acc = {
    id: "plaid:" + a.account_id,
    name: [item.institutionName, a.official_name || a.name].filter(Boolean).join(" · "),
    type: isCredit ? "CreditCard" : a.subtype === "savings" ? "Savings" : "CurrentAccount",
    currency: b.iso_currency_code || b.unofficial_currency_code || "USD",
    source: "plaid",
    institution: item.institutionName,
    mask: a.mask || null,
    bankSync: true,
    balance,
    postedBalance: round2(posted),
    pending: {
      known: pendingKnown,
      amount: round2(balance - posted),
      listed: round2(-out),
      count: pend ? pend.count : 0,
      check,
      bankImplied: implied != null && isFinite(implied) ? round2(implied) : null,
    },
    lastRecordDate: lastDate || null,
    credit: null,
  };
  if (isCredit) {
    const owed = round2(Math.max(0, -balance));
    const limit = Number(b.limit) || null;
    acc.credit = { owed, limit, available: limit ? round2(limit - owed) : null, utilizationPct: limit ? Math.round((1000 * owed) / limit) / 10 : null };
  }
  return acc;
}

const PLAID_CACHE_KEY = "plaid:summary";
/** At most one real-time balance read per Item in this window (Plaid allows 30 per hour). */
const PLAID_LIVE_MIN_MS = 5 * 60 * 1000;
/** After a BALANCE_LIMIT answer, no real-time read for that Item during this window. */
const PLAID_LIVE_BLOCK_MS = 60 * 60 * 1000;
/** Longest wait for a real-time balance read before falling back to Plaid's cached balances. */
const PLAID_LIVE_TIMEOUT_MS = 8 * 1000;
/** Longest wait for any other Plaid call. */
const PLAID_CALL_TIMEOUT_MS = 12 * 1000;
/** At most one /transactions/refresh per Item in this window (Plaid allows 2/min and 120/hour). */
const PLAID_TX_REFRESH_MIN_MS = 5 * 60 * 1000;
/** When /transactions/refresh is refused as not enabled, it is not tried again for this long. */
const PLAID_TX_REFRESH_BLOCK_MS = 24 * 60 * 60 * 1000;
/** Plaid answers shared by every Worker isolate (memory first, then KV), so Plaid is called at most
 * once per WALLET_TTL_MS (WALLET_FORCE_MIN_MS when forced) whatever the number of devices. */
let plaidCache = { at: 0, items: null, accounts: null };

async function plaidFresh(env, force) {
  const maxAge = force ? WALLET_FORCE_MIN_MS : WALLET_TTL_MS;
  if (plaidCache.items && Date.now() - plaidCache.at < maxAge) return plaidCache;
  const shared = await env.PLAID_KV.get(PLAID_CACHE_KEY, "json").catch(() => null);
  if (shared && shared.items && Date.now() - shared.at < maxAge) return (plaidCache = shared);
  // The previous answer carries, per Item, the last real-time read and any BALANCE_LIMIT block.
  const prev = [plaidCache, shared].filter((c) => c && c.items).sort((a, b) => b.at - a.at)[0];
  const prevById = new Map(((prev && prev.items) || []).map((s) => [s.itemId, s]));
  const results = await Promise.all((await plaidItems(env)).map((item) => plaidItemData(env, item, prevById.get(item.itemId), force)));
  plaidCache = { at: Date.now(), items: results.map((r) => r.status), accounts: results.flatMap((r) => r.accounts) };
  await env.PLAID_KV.put(PLAID_CACHE_KEY, JSON.stringify(plaidCache)).catch(() => {});
  return plaidCache;
}

async function plaidSummary(env, limits, force) {
  if (!plaidConfigured(env)) return { configured: false, items: [], accounts: [] };
  const fresh = await plaidFresh(env, force);
  // A limit set in CREDIT_LIMITS (by the Wallet name, applied in mergeAccounts) wins; keep Plaid's otherwise.
  const accounts = fresh.accounts.map((a) => ({ ...a, _limits: limits }));
  // Raw balances (kept for reusing a recent real-time read) stay in the Worker.
  return { configured: true, items: fresh.items.map(({ raw, ...s }) => s), accounts };
}

/**
 * Plaid accounts replace their Wallet twin (bank-synced, same currency, same last 4 digits) and
 * keep its name; Plaid accounts with no twin are added; everything else stays from Wallet.
 */
function mergeAccounts(walletAccounts, plaidAccounts) {
  const used = new Set();
  const merged = walletAccounts.map((w) => {
    const twin = w.bankSync && w.mask ? plaidAccounts.find((p) => !used.has(p.id) && p.mask === w.mask && p.currency === w.currency) : null;
    if (!twin) return w;
    used.add(twin.id);
    const limits = twin._limits || {};
    const acc = { ...twin, name: w.name, walletId: w.id };
    if (acc.credit) {
      const limit = Number(limits[w.name]) || acc.credit.limit || (w.credit && w.credit.limit) || null;
      acc.credit = { ...acc.credit, limit, available: limit ? round2(limit - acc.credit.owed) : null, utilizationPct: limit ? Math.round((1000 * acc.credit.owed) / limit) / 10 : null };
    }
    delete acc._limits;
    return acc;
  });
  for (const p of plaidAccounts) {
    if (used.has(p.id)) continue;
    const acc = { ...p };
    delete acc._limits;
    merged.push(acc);
  }
  return merged;
}

/** Read-only lookup in Plaid's institution list: which institutions match and what they support. */
async function plaidInstitutions(env, query) {
  const q = String(query || "").trim().slice(0, 80);
  if (q.length < 2) throw new HttpError(400, "bad_request", "q must have at least 2 characters");
  const data = await plaidCall(env, "/institutions/search", {
    query: q,
    country_codes: plaidCountries(env),
    products: null,
    options: { include_optional_metadata: false },
  });
  return {
    ok: true,
    query: q,
    institutions: (data.institutions || []).slice(0, 10).map((i) => ({
      id: i.institution_id,
      name: i.name,
      products: i.products || [],
      oauth: !!i.oauth,
    })),
  };
}

// ---------- Custom account names (shared by every device) ----------

const NAMES_KEY = "names";
const NAME_MAX = 60;

async function loadNames(env) {
  if (!env.PLAID_KV) return {};
  const names = await env.PLAID_KV.get(NAMES_KEY, "json").catch(() => null);
  return names && typeof names === "object" ? names : {};
}

/** Sets (or, with an empty name, clears) the display name of one account, by its /wallet id. */
async function renameAccount(env, input) {
  if (!env.PLAID_KV) throw new HttpError(500, "names_not_configured", "the PLAID_KV binding is needed to store account names");
  const id = typeof input.id === "string" ? input.id.trim().slice(0, 200) : "";
  if (!id) throw new HttpError(400, "bad_request", "id missing");
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  const names = await loadNames(env);
  if (name) names[id] = name;
  else delete names[id];
  await env.PLAID_KV.put(NAMES_KEY, JSON.stringify(names));
  walletCache = { at: 0, body: null };
  return { ok: true, id, name: name || null };
}
