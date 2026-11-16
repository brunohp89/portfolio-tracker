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
 *
 * Endpoints:
 *   GET /            liveness check, no data
 *   GET /snapshot    newest file named SNAPSHOT_NAME in the folder, as JSON
 *   GET /brief       newest file named BRIEF_NAME in the folder, as HTML
 *   GET /check       metadata of both files (for setting things up)
 *   GET /wallet      balance of every BudgetBakers Wallet account (investments excluded),
 *                    credit card utilization and totals; cached in memory for WALLET_TTL_MS
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
      if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (path === "/") return json({ ok: true, app: "portfolio-snapshot" }, 200, cors);
      if (path !== "/check" && path !== "/wallet" && !ROUTES[path]) throw new HttpError(404, "not_found");

      await requireToken(request, env);
      if (path === "/wallet") return json(await walletSummary(env), 200, cors);
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, If-None-Match",
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

const round2 = (n) => Math.round(n * 100) / 100;

async function walletFetch(env, path, params) {
  const url = `${WALLET_API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.WALLET_API_TOKEN}`, Accept: "application/json" } });
  if (res.status === 409) throw new HttpError(503, "wallet_initial_sync", "Wallet is still running its first sync, retry in a few minutes");
  if (res.status === 429) throw new HttpError(503, "wallet_rate_limited", `Wallet rate limit reached, retry after ${res.headers.get("Retry-After") || "?"} s`);
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

/** EURUSD from Wallet's conversion of the latest EUR record (rate of that record's date). */
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
    return rate ? { rate, asOf: rec.recordDate.slice(0, 10) } : null;
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
  const out = {
    id: a.id,
    name: a.name,
    type: a.accountType,
    currency: a.currencyCode,
    bankSync: !!a.isBankSync,
    balance: round2(raw),
    lastRecordDate: last ? last.slice(0, 10) : null,
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

async function walletSummary(env) {
  if (!env.WALLET_API_TOKEN) throw new HttpError(500, "wallet_not_configured", "set the WALLET_API_TOKEN secret");
  if (walletCache.body && Date.now() - walletCache.at < WALLET_TTL_MS) return walletCache.body;

  const { accounts: all, headers } = await walletAccounts(env);
  const kept = all.filter((a) => !WALLET_EXCLUDED_TYPES.has(a.accountType) && !a.isInvestmentAccount);
  const limits = creditLimitOverrides(env);
  const accounts = kept.map((a) => walletAccount(a, limits));
  const fx = await walletEurUsd(env, kept);

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
    pendingIncluded: false,
    fx,
    accounts,
    totals: { byCurrency, ...(total || {}) },
    credit: limit ? { owed: round2(owed), limit: round2(limit), utilizationPct: Math.round((1000 * owed) / limit) / 10 } : null,
  };
  walletCache = { at: Date.now(), body };
  return body;
}
