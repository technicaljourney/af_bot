/**
 * Server-side auth store for AfterQuery's Firebase token.
 *
 * Two ways to stay authorized:
 *   1. ID-token push (legacy) — the browser extension POSTs a fresh Firebase ID
 *      token to /api/auth/ingest every few minutes. Held in memory only.
 *   2. Refresh-token flow (preferred) — paste a Firebase refresh token + Web API
 *      key ONCE. The server exchanges it for ID tokens at Google's secure-token
 *      endpoint and a background timer re-mints one ~5 min before each expiry, so
 *      `getStoredToken()` always returns a valid token without the extension.
 *      The refresh token + API key are persisted to disk so they survive a
 *      server restart (paste once, stays authorized for weeks).
 *
 * The raw tokens are never sent back to the browser — only metadata via
 * /api/auth/status. Submissions read the ID token here on the server.
 */

import { promises as fs } from "fs";
import { readFileSync } from "fs";
import { request as httpsRequest } from "https";
import path from "path";
import { normalizeToken } from "@/lib/afterquery";

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
/** Re-mint this many ms before the ID token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Where the refresh token + API key persist across restarts. */
const STORE_FILE = path.join(process.cwd(), ".auth-store.json");

export interface StoredAuth {
  token: string | null;
  exp: number | null; // epoch seconds
  email: string | null;
  source: string | null; // "extension" | "manual" | "refresh-token"
  receivedAt: number; // epoch ms
}

interface RefreshCreds {
  refreshToken: string | null;
  apiKey: string | null;
  error: string | null; // last exchange error, if any
}

interface AuthGlobal {
  __plutoAuth?: StoredAuth;
  __plutoRefresh?: RefreshCreds;
  __plutoRefreshTimer?: ReturnType<typeof setTimeout> | null;
  __plutoRefreshInit?: boolean;
}

const g = globalThis as unknown as AuthGlobal;
if (!g.__plutoAuth) {
  g.__plutoAuth = { token: null, exp: null, email: null, source: null, receivedAt: 0 };
}
if (!g.__plutoRefresh) {
  g.__plutoRefresh = { refreshToken: null, apiKey: null, error: null };
}

/** Decode a JWT payload (no verification) to read exp/email. */
export function decodeJwtPayload(token: string): { exp?: number; email?: string } {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const o = JSON.parse(json);
    return { exp: typeof o.exp === "number" ? o.exp : undefined, email: o.email };
  } catch {
    return {};
  }
}

// ── Refresh-token persistence ───────────────────────────────────────────────

function loadPersisted(): void {
  if (g.__plutoRefreshInit) return;
  g.__plutoRefreshInit = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf8");
    const o = JSON.parse(raw) as { refreshToken?: string; apiKey?: string };
    if (o.refreshToken && o.apiKey) {
      g.__plutoRefresh = { refreshToken: o.refreshToken, apiKey: o.apiKey, error: null };
      // Kick off an immediate exchange (and self-scheduling) on boot.
      void exchangeRefreshToken();
    }
  } catch {
    /* no persisted creds — fine */
  }
}

async function persist(): Promise<void> {
  const { refreshToken, apiKey } = g.__plutoRefresh!;
  try {
    if (refreshToken && apiKey) {
      await fs.writeFile(
        STORE_FILE,
        JSON.stringify({ refreshToken, apiKey }, null, 2),
        { mode: 0o600 }
      );
    } else {
      await fs.rm(STORE_FILE, { force: true });
    }
  } catch {
    /* best-effort; in-memory creds still work for this process */
  }
}

// ── Refresh-token exchange ──────────────────────────────────────────────────

function scheduleRefresh(expSeconds: number | null): void {
  if (g.__plutoRefreshTimer) {
    clearTimeout(g.__plutoRefreshTimer);
    g.__plutoRefreshTimer = null;
  }
  if (!expSeconds) return;
  const fireInMs = Math.max(30_000, expSeconds * 1000 - Date.now() - REFRESH_SKEW_MS);
  g.__plutoRefreshTimer = setTimeout(() => {
    void exchangeRefreshToken();
  }, fireInMs);
  // Don't let this timer keep the process alive on its own.
  (g.__plutoRefreshTimer as unknown as { unref?: () => void })?.unref?.();
}

/**
 * POST an x-www-form-urlencoded body over IPv4 (family: 4).
 *
 * Node's global fetch (undici) does NOT fall back from an unreachable IPv6 route
 * the way curl does — on an IPv6-broken network it hangs and fails the
 * secure-token exchange with ETIMEDOUT, so the refresh token "won't load" even
 * though the credential is valid. Pinning to IPv4 via the built-in https client
 * fixes it without adding a dependency.
 */
function postFormIPv4(
  targetUrl: string,
  body: string
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
              try {
                return JSON.parse(text);
              } catch {
                return {};
              }
            },
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("secure-token request timed out")));
    req.end(body);
  });
}

/**
 * Exchange the stored refresh token for a fresh ID token via Google's
 * secure-token endpoint, update the cache, and schedule the next refresh.
 * Returns the new ID token, or null on failure.
 */
export async function exchangeRefreshToken(): Promise<string | null> {
  const { refreshToken, apiKey } = g.__plutoRefresh!;
  if (!refreshToken || !apiKey) return null;
  try {
    const res = await postFormIPv4(
      `${SECURE_TOKEN_URL}?key=${encodeURIComponent(apiKey)}`,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    );
    const data = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      refresh_token?: string;
      error?: { message?: string } | string;
      error_description?: string;
    };
    if (!res.ok || !data.id_token) {
      const msg =
        (typeof data.error === "object" ? data.error?.message : data.error) ||
        data.error_description ||
        `secure-token HTTP ${res.status}`;
      g.__plutoRefresh!.error = msg;
      // A hard auth error (revoked token, bad key) won't fix itself — stop the loop.
      if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|API key/i.test(msg)) {
        if (g.__plutoRefreshTimer) clearTimeout(g.__plutoRefreshTimer);
        g.__plutoRefreshTimer = null;
      } else {
        scheduleRefresh(Math.floor(Date.now() / 1000) + 120); // transient — retry soon
      }
      return null;
    }
    const idToken = data.id_token;
    const { exp, email } = decodeJwtPayload(idToken);
    g.__plutoAuth = {
      token: idToken,
      exp: exp ?? null,
      email: email ?? g.__plutoAuth!.email ?? null,
      source: "refresh-token",
      receivedAt: Date.now(),
    };
    g.__plutoRefresh!.error = null;
    // Firebase may rotate the refresh token; keep the newest.
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      g.__plutoRefresh!.refreshToken = data.refresh_token;
      void persist();
    }
    scheduleRefresh(exp ?? null);
    return idToken;
  } catch (e) {
    g.__plutoRefresh!.error = (e as Error).message;
    scheduleRefresh(Math.floor(Date.now() / 1000) + 120);
    return null;
  }
}

/** Store a refresh token + Web API key, exchange immediately, and persist. */
export async function ingestRefreshToken(
  rawRefreshToken: string,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const refreshToken = rawRefreshToken.trim();
  const key = apiKey.trim();
  if (!refreshToken || !key) return { ok: false, error: "refreshToken and apiKey are required." };
  g.__plutoRefresh = { refreshToken, apiKey: key, error: null };
  await persist();
  const token = await exchangeRefreshToken();
  return token
    ? { ok: true }
    : { ok: false, error: g.__plutoRefresh!.error || "Exchange failed." };
}

/** Forget the refresh token + API key (stops auto-refresh, deletes the file). */
export async function clearRefreshToken(): Promise<void> {
  g.__plutoRefresh = { refreshToken: null, apiKey: null, error: null };
  if (g.__plutoRefreshTimer) clearTimeout(g.__plutoRefreshTimer);
  g.__plutoRefreshTimer = null;
  await persist();
}

// ── ID-token push (extension / manual) ──────────────────────────────────────

/**
 * Store a token if it's newer (later exp) than what we already have.
 * Returns the resulting stored auth.
 */
export function ingestToken(rawToken: string, source = "extension"): StoredAuth {
  loadPersisted();
  // When a refresh token is configured it is the sole source of truth — ignore
  // extension pushes entirely so they can't clobber the refresh-minted token.
  // (A manual paste still overrides, since that's an explicit user action.)
  if (
    source === "extension" &&
    g.__plutoRefresh?.refreshToken &&
    g.__plutoRefresh?.apiKey
  ) {
    return g.__plutoAuth!;
  }
  const token = normalizeToken(rawToken);
  const { exp, email } = decodeJwtPayload(token);
  const current = g.__plutoAuth!;

  const newer =
    !current.token ||
    (exp ?? 0) > (current.exp ?? 0) ||
    ((exp ?? 0) === (current.exp ?? 0) && token !== current.token);

  if (token && newer) {
    g.__plutoAuth = {
      token,
      exp: exp ?? null,
      email: email ?? current.email ?? null,
      source,
      receivedAt: Date.now(),
    };
  }
  return g.__plutoAuth!;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The raw cached ID token for server-side use, or null if none / expired.
 *  Kept valid by the refresh-token timer (or extension pushes). Synchronous so
 *  existing route handlers don't need to change. */
export function getStoredToken(): string | null {
  loadPersisted();
  const a = g.__plutoAuth!;
  if (!a.token) return null;
  if (a.exp && a.exp * 1000 <= Date.now()) return null; // expired
  return a.token;
}

/** Guaranteed-fresh token: returns the cached one if it has >1 min left,
 *  otherwise exchanges the refresh token on the spot. */
export async function ensureFreshToken(): Promise<string | null> {
  loadPersisted();
  const a = g.__plutoAuth!;
  if (a.token && a.exp && a.exp * 1000 > Date.now() + 60_000) return a.token;
  const { refreshToken, apiKey } = g.__plutoRefresh!;
  if (refreshToken && apiKey) {
    const t = await exchangeRefreshToken();
    if (t) return t;
  }
  return getStoredToken();
}

/** Metadata for the UI (never includes the raw tokens). */
export function getAuthStatus(): {
  hasToken: boolean;
  exp: number | null;
  email: string | null;
  source: string | null;
  receivedAt: number;
  expired: boolean;
  hasRefreshToken: boolean;
  refreshError: string | null;
} {
  loadPersisted();
  const a = g.__plutoAuth!;
  const r = g.__plutoRefresh!;
  const expired = Boolean(a.exp && a.exp * 1000 <= Date.now());
  return {
    hasToken: Boolean(a.token) && !expired,
    exp: a.exp,
    email: a.email,
    source: a.source,
    receivedAt: a.receivedAt,
    expired: Boolean(a.token) && expired,
    hasRefreshToken: Boolean(r.refreshToken && r.apiKey),
    refreshError: r.error,
  };
}

export function clearAuth(): void {
  g.__plutoAuth = { token: null, exp: null, email: null, source: null, receivedAt: 0 };
}
