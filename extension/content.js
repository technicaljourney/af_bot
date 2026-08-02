// Pluto Token Bridge — content script on experts.afterquery.com.
//
// Reads the current Firebase ID token (and refresh token) from the page's
// IndexedDB (`firebaseLocalStorageDb`) and sends it to the background worker.
// Firebase rewrites this store ~5 min before expiry, so polling it keeps the
// token fresh even while the tab sits idle and makes no API requests.

function readFirebaseToken() {
  return new Promise((resolve) => {
    let finish = (v) => {
      finish = () => {};
      resolve(v);
    };
    try {
      const req = indexedDB.open("firebaseLocalStorageDb");
      req.onerror = () => finish(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains("firebaseLocalStorage")) return finish(null);
          const store = db
            .transaction("firebaseLocalStorage", "readonly")
            .objectStore("firebaseLocalStorage");
          const all = store.getAll();
          all.onerror = () => finish(null);
          all.onsuccess = () => {
            let best = null;
            for (const row of all.result || []) {
              const v = row && row.value;
              const stm = v && v.stsTokenManager;
              if (stm && stm.accessToken) {
                const exp = Number(stm.expirationTime) || 0;
                if (!best || exp > best.exp) {
                  best = { token: stm.accessToken, exp, email: v.email };
                }
              }
            }
            finish(best);
          };
        } catch {
          finish(null);
        }
      };
    } catch {
      finish(null);
    }
  });
}

async function tick() {
  const info = await readFirebaseToken();
  if (info && info.token) {
    chrome.runtime.sendMessage({ type: "pluto-token", token: info.token });
  }
}

tick();
setInterval(tick, 20000);
