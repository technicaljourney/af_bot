# Pluto Token Bridge (browser extension)

Forwards your AfterQuery Firebase auth token to the local Pluto Submissions app
so you never have to paste it. Captures it two ways and always keeps the freshest:

1. **Request header** — reads `Authorization: Bearer …` off AfterQuery's own API
   calls (`webRequest`, observe-only).
2. **Firebase IndexedDB** — a content script reads the current ID token from
   `firebaseLocalStorageDb` every ~20s. Firebase rewrites this ~5 min before
   expiry, so the token stays fresh even when the tab is idle.

The freshest token (latest JWT `exp`) is POSTed to `<app>/api/auth/ingest`.

## Install (Chrome / Edge / Brave)

1. Go to `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → select this `extension/` folder.
3. Open <https://experts.afterquery.com> and sign in. The extension captures the
   token on the first request / IndexedDB read.
4. Open the Pluto app (default `http://localhost:3137`). The Authentication line
   should show **✓ via extension · your-email · NNm left**.

Click the extension icon for a popup showing capture + sync status. If your app
runs on a different port, set the **App URL** there and click **Save URL**.

## Notes

- Permissions: `webRequest` + host access to `experts.afterquery.com` (to read
  the token) and `http://localhost/*` + `http://127.0.0.1/*` (to push it to the
  app on any port).
- The token is sent only to the host you configure (your local app). It is held
  in the app's server memory and never re-exposed to the page.
- A token pasted manually in the app overrides the extension.
