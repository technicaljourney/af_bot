function jwt(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
  } catch {
    return null;
  }
}

function fmtLeft(exp) {
  const s = Math.max(0, exp - Math.floor(Date.now() / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Parse the textarea into a clean list of URLs (one per line, trailing "/" stripped).
function parseUrls(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// Populate the App URLs field ONCE on load. Deliberately NOT touched by the
// polling render() below — otherwise the 1s tick would overwrite your edits.
async function initAppUrlsField() {
  const { appBases, appBase } = await chrome.storage.local.get(["appBases", "appBase"]);
  const list =
    Array.isArray(appBases) && appBases.length
      ? appBases
      : appBase
      ? [appBase]
      : ["http://localhost:3137"];
  document.getElementById("appBases").value = list.join("\n");
}

// Refresh the status + last-push lines on a timer. Does not touch the textarea.
async function render() {
  const { token, exp, lastPush } = await chrome.storage.local.get([
    "token",
    "exp",
    "lastPush",
  ]);
  const statusEl = document.getElementById("status");
  const pushEl = document.getElementById("push");

  if (!token) {
    statusEl.innerHTML =
      '<span class="warn">No token captured yet.</span><br><span class="muted">Open and use experts.afterquery.com.</span>';
  } else {
    const claims = jwt(token);
    const e = exp || (claims && claims.exp) || 0;
    const expired = e && e * 1000 <= Date.now();
    const email = claims && claims.email ? claims.email : "";
    statusEl.innerHTML = expired
      ? `<span class="err">Token expired.</span> <span class="muted">${email}</span>`
      : `<span class="ok">Token captured.</span><br><span class="muted">${email} · expires in ${fmtLeft(
          e
        )}</span>`;
  }

  if (lastPush && Array.isArray(lastPush.results)) {
    const when = new Date(lastPush.at).toLocaleTimeString();
    const ok = lastPush.results.filter((r) => r.ok).length;
    const total = lastPush.results.length;
    const failed = lastPush.results.filter((r) => !r.ok).map((r) => r.base);
    pushEl.innerHTML =
      ok === total
        ? `<span class="ok">Synced to ${ok}/${total} app${total === 1 ? "" : "s"}</span> <span class="muted">at ${when}</span>`
        : `<span class="err">Synced ${ok}/${total}</span> <span class="muted">— failed: ${failed.join(
            ", "
          )} (${when})</span>`;
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const list = parseUrls(document.getElementById("appBases").value);
  const appBases = list.length ? list : ["http://localhost:3137"];
  // Keep a legacy single `appBase` in sync (first URL) for back-compat.
  await chrome.storage.local.set({ appBases, appBase: appBases[0] });
  chrome.runtime.sendMessage({ type: "pluto-resend" });
  setTimeout(render, 400);
});

document.getElementById("resend").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "pluto-resend" });
  setTimeout(render, 400);
});

initAppUrlsField();
render();
setInterval(render, 1000);
