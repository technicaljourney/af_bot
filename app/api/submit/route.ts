import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getTaskZipDir } from "@/lib/submission";
import { runSubmission, SubmitError } from "@/lib/afterquery";
import { getStoredToken } from "@/lib/authStore";
import { getUserSubmissions } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SubmitBody {
  fileName?: string;
  domain?: string;
  token?: string;
  language?: string;
  version?: string;
}

/** Pipeline-alive states — same submission should never be re-submitted. */
function isAliveStatus(s: string): boolean {
  const x = (s || "").toLowerCase();
  return (
    x.includes("running") ||
    x.includes("progress") ||
    x.includes("queued") ||
    x.includes("ready") ||
    x.includes("approv")
  );
}

export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { fileName, domain, language, version } = body;

  // Prefer an explicitly pasted token; otherwise use the extension-provided one.
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Paste one, or connect the extension." },
      { status: 400 }
    );
  }
  if (!fileName) {
    return NextResponse.json({ ok: false, error: "fileName is required." }, { status: 400 });
  }
  if (!domain || !domain.trim()) {
    return NextResponse.json({ ok: false, error: "Domain is required." }, { status: 400 });
  }

  // Resolve the file safely inside the configured zip directory (no traversal).
  const dir = getTaskZipDir();
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ ok: false, error: "Invalid file name." }, { status: 400 });
  }
  const fullPath = path.join(dir, safeName);
  if (path.dirname(fullPath) !== path.resolve(dir)) {
    return NextResponse.json({ ok: false, error: "File path outside task directory." }, { status: 400 });
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await fs.readFile(fullPath);
  } catch {
    return NextResponse.json(
      { ok: false, error: `Zip not found on disk: ${safeName}` },
      { status: 404 }
    );
  }

  // Pre-flight: refuse if AfterQuery already has ANY submission for this
  // fileName (active or not). For retries, callers must delete the old
  // submission first (e.g. autoTick's deleteAndResubmit does this). Without
  // this gate, a Needs-Review row would let Step 1 race in and create a
  // duplicate (the case that triggered this fix).
  try {
    const existing = await getUserSubmissions(token);
    const same = existing.find((s) => s.fileName === safeName);
    if (same) {
      const alive = isAliveStatus(same.status);
      return NextResponse.json(
        {
          ok: false,
          skipped: true,
          reason: alive ? "already-alive" : "already-exists",
          error: alive
            ? `Skipped: ${safeName} already has an active submission (${same.status}).`
            : `Skipped: ${safeName} already has a submission (${same.status}). Delete it first to re-submit.`,
          existing: { id: same.id, status: same.status },
        },
        { status: 409 }
      );
    }
  } catch {
    // Pre-flight failure (e.g. token expired) shouldn't block the submit attempt;
    // runSubmission below will surface the real error.
  }

  try {
    const result = await runSubmission({
      fileName: safeName,
      fileBytes: new Uint8Array(fileBytes),
      domain,
      token,
      language,
      version,
    });
    return NextResponse.json({ ok: true, fileName: safeName, ...result });
  } catch (e) {
    if (e instanceof SubmitError) {
      return NextResponse.json(
        { ok: false, step: e.step, status: e.status, error: e.message, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
