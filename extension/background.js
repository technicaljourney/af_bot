// Pluto Token Bridge — background service worker (Manifest V3).
//
// Captures the AfterQuery Firebase ID token two ways and forwards the freshest
// one to the local Pluto Submissions app:
//   1. Reads the `Authorization: Bearer <token>` header off AfterQuery's own
//      API requests (webRequest, observe-only).
//   2. Receives tokens read from Firebase's IndexedDB by the content script.
//
// "Freshest" = the token whose JWT `exp` is latest.

// The hosted Pluto app. The token is always forwarded here, regardless of the
// popup's "App URL" field, so it works without changing anything in the popup.
const SERVER_APP_BASE = "http://157.250.198.27:9090";
const DEFAULT_APP_BASE = SERVER_APP_BASE;

let best = { token: null, exp: 0 };

function jwtExp(token) {
  try {
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    const o = JSON.parse(json);
    return typeof o.exp === "number" ? o.exp : 0;
  } catch {
    return 0;
  }
}

async function getAppBases() {
  // App URLs saved in the popup (one per line → array). Falls back to a legacy
  // single `appBase`, then to the hosted server, so it always has a target.
  const { appBases, appBase } = await chrome.storage.local.get(["appBases", "appBase"]);
  if (Array.isArray(appBases) && appBases.length) return appBases;
  if (appBase) return [appBase];
  return [SERVER_APP_BASE];
}

// POST the token to EVERY configured app URL and record a per-URL result.
async function pushToApp(token) {
  const bases = await getAppBases();
  const results = await Promise.all(
    bases.map(async (base) => {
      try {
        const res = await fetch(`${base}/api/auth/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, source: "extension" }),
        });
        return { base, ok: res.ok, status: res.status };
      } catch (e) {
        return { base, ok: false, error: String(e) };
      }
    })
  );
  await chrome.storage.local.set({ lastPush: { at: Date.now(), results } });
}

// Consider a candidate token; keep + forward it if it's newer than what we have.
async function consider(token) {
  if (!token || typeof token !== "string") return;
  const exp = jwtExp(token);
  if (!exp) return;
  const isNew = exp > best.exp || (exp === best.exp && token !== best.token);
  if (!isNew) return;
  best = { token, exp };
  await chrome.storage.local.set({
    token,
    exp,
    capturedAt: Date.now(),
  });
  await pushToApp(token);
}

// 1. Capture from outgoing AfterQuery request headers.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    const auth = headers.find((h) => h.name.toLowerCase() === "authorization");
    if (auth && auth.value && /^Bearer\s+/i.test(auth.value)) {
      consider(auth.value.replace(/^Bearer\s+/i, "").trim());
    }
  },
  { urls: ["https://experts.afterquery.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

// 2. Tokens read from IndexedDB by the content script.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "pluto-token" && msg.token) {
    consider(msg.token);
  }
  if (msg && msg.type === "pluto-resend" && best.token) {
    pushToApp(best.token).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

// Re-push the latest token periodically so a restarted app re-syncs quickly.
chrome.alarms.create("repush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "repush" && best.token) pushToApp(best.token);
});

// On startup, restore the last token and re-push.
chrome.storage.local.get(["token", "exp"]).then(({ token, exp }) => {
  if (token) {
    best = { token, exp: exp || jwtExp(token) };
    pushToApp(token);
  }
});
