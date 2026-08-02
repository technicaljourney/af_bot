# Pluto Submissions

A small Next.js app that submits the task zips in `../task_zip/` to AfterQuery's
Pluto project with one click — replicating the browser "Upload Task Submission"
flow (Domain + zip + Python, testing skipped).

## How it works

The browser never calls AfterQuery directly (that would hit CORS). Instead the
Next.js server proxies the four-step upload flow per submission:

1. `POST /api/projects/pluto/harbor/get-upload-url` → signed GCS `uploadUrl` + `rawStoragePath`
2. `PUT <uploadUrl>` → raw zip bytes (`Content-Type: application/zip`)
3. `POST /api/projects/pluto/harbor/upload-file` → processed `fileUrl`
4. `POST /api/projects/pluto/create-submission` → `submissionId`
   (`language: Python`, `testStatus: skipped`, `version: Pluto v2`)

The domain for each task is pre-filled from `submission.md` and stays editable.

## Setup

```bash
npm install
npm run dev   # http://localhost:3137  (port 3000 was busy on this machine)
```

Config lives in `.env.local`:

- `TASK_ZIP_DIR` — folder with the zips + `submission.md` (absolute path).
- `AFTERQUERY_BASE` — API host (default `https://experts.afterquery.com`).
- `AFTERQUERY_PROJECT` — project slug (default `pluto`).
- `DEFAULT_LANGUAGE` / `DEFAULT_VERSION` — submission defaults.

## Auth token

AfterQuery uses a Firebase Bearer JWT. Two ways to provide it:

### Automatic — browser extension (recommended)

Load the unpacked extension in [extension/](extension/) (see its README). While
you're signed into `experts.afterquery.com`, it captures the token (from request
headers + Firebase IndexedDB), keeps it fresh, and POSTs it to
`/api/auth/ingest`. The app holds it in server memory and uses it for every
submission — no pasting. The Authentication line shows **✓ via extension · email
· NNm left**.

> A web app on `localhost` cannot read another origin's token directly (browser
> origin isolation), which is why this is a small extension rather than in-page
> code.

### Manual — paste a token

Click **Paste token manually** and paste the token from DevTools (Network → any
`experts.afterquery.com` request → `authorization` header). A pasted token
overrides the extension. The decoder tolerates a `Bearer `/`authorization:`
prefix, quotes, and whitespace, and shows a live expiry countdown.

## Usage

- Each row has its own **Submit** button.
- Tick rows and use **Submit selected** to batch-submit (runs sequentially).
- Search/filter by group, status, or "not in submission.md".
