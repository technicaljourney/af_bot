import { NextRequest, NextResponse } from "next/server";
import { submitPatch, reviseFinding, FenrirError } from "@/lib/fenrir";
import { resolveFindingPatch, fenrirDirByKey, validateRepoMap } from "@/lib/fenrirLocal";
import { analyzeDescription } from "@/lib/fenrirTaskDesc";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Auto-patch one finding from the local Fenrir/ folder:
 *   1. resolve <repo>'s patch for this finding index,
 *   2. submit it,
 *   3. set the description (only if it passes the 600-char / 80-word / 1–3
 *      sentence gate — otherwise leave it for manual editing).
 *
 * `dryRun: true` just reports what WOULD be submitted (for the status view).
 */
export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    submissionId?: string;
    findingId?: string;
    findingIndex?: number;
    repoName?: string;
    folder?: string;
    crashText?: string;
    dryRun?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.submissionId || !body.findingId || !body.repoName) {
    return NextResponse.json(
      { ok: false, error: "submissionId, findingId and repoName are required." },
      { status: 400 }
    );
  }

  // Prefer the explicit array position (finding ids aren't always ":<index>" —
  // some are hashes); fall back to parsing the id, then 0.
  const parsed = Number(body.findingId.split(":")[1]);
  const findingIndex =
    typeof body.findingIndex === "number"
      ? body.findingIndex
      : Number.isFinite(parsed)
      ? parsed
      : 0;

  // Refuse to submit if the repo's fenrir.map.json is broken / references
  // missing files.
  const v = await validateRepoMap(body.repoName, fenrirDirByKey(body.folder));
  if (!v.ok) {
    return NextResponse.json({ ok: false, error: `Refusing to submit — ${v.error}` }, { status: 400 });
  }

  const match = await resolveFindingPatch(
    body.repoName,
    findingIndex,
    fenrirDirByKey(body.folder),
    body.crashText
  );
  if ("error" in match) {
    return NextResponse.json({ ok: false, error: match.error }, { status: 404 });
  }
  const { patchText, patchFileName, description, via } = match.resolved;

  // AfterQuery REQUIRES a task description, so always submit it with the patch.
  // The quality gate is advisory only (warn, never skip — a missing description
  // is a hard reject, an imperfect one is not).
  const descCheck = description ? analyzeDescription(description) : null;
  const descWarn = !description
    ? "no description found in <repo>_submission/ — AfterQuery requires one"
    : descCheck && !descCheck.ok
    ? "description may fail AfterQuery's quality check (too long / fix-revealing)"
    : null;

  if (body.dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, patchFileName, via, hasDescription: !!description, descWarn });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }

  try {
    // Set the description first (best-effort), then submit the patch WITH it —
    // so it's present whichever field the API reads.
    if (description) {
      try {
        await reviseFinding(token, body.findingId, description);
      } catch {
        /* non-fatal — also sent in the submit-patch body below */
      }
    }
    await submitPatch(token, {
      submissionId: body.submissionId,
      findingId: body.findingId,
      patchText,
      patchFileName,
      description: description || undefined,
    });
    return NextResponse.json({
      ok: true,
      patchFileName,
      via,
      described: !!description,
      descWarn,
    });
  } catch (e) {
    if (e instanceof FenrirError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
