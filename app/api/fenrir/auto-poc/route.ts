import { NextRequest, NextResponse } from "next/server";
import { submitPoc, FenrirError } from "@/lib/fenrir";
import { listPreparedPocs, fenrirDirByKey, validateRepoMap } from "@/lib/fenrirLocal";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Submit every prepared PoC for a submission from the local Fenrir/ folder.
 * Each PoC becomes its own task. `dryRun: true` just lists what would be sent.
 */
export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    submissionId?: string;
    repoName?: string;
    folder?: string;
    dryRun?: boolean;
    /** sha256(first16) of PoCs already submitted (from existing findings) — these
     *  are skipped instead of re-submitted (the server would 409 them anyway). */
    skipHashes?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.submissionId || !body.repoName) {
    return NextResponse.json(
      { ok: false, error: "submissionId and repoName are required." },
      { status: 400 }
    );
  }

  const v = await validateRepoMap(body.repoName, fenrirDirByKey(body.folder));
  if (!v.ok) {
    return NextResponse.json({ ok: false, error: `Refusing to submit — ${v.error}` }, { status: 400 });
  }

  const found = await listPreparedPocs(body.repoName, fenrirDirByKey(body.folder));
  if ("error" in found) {
    return NextResponse.json({ ok: false, error: found.error }, { status: 404 });
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      pocs: found.pocs.map((p) => ({ fileName: p.fileName, via: p.via, sha256: p.sha256 })),
    });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }

  const skip = new Set((body.skipHashes ?? []).map((h) => h.toLowerCase()));
  const results: {
    fileName: string;
    ok: boolean;
    error?: string;
    status?: number;
    /** Already submitted for this repo (pre-skipped by hash, or server 409) —
     *  benign, not a failure. */
    already?: boolean;
  }[] = [];
  for (const p of found.pocs) {
    // Already a finding for this repo → don't re-submit (the server would 409).
    if (skip.has(p.sha256.toLowerCase())) {
      results.push({ fileName: p.fileName, ok: false, already: true });
      continue;
    }
    try {
      await submitPoc(token, body.submissionId, p.base64);
      results.push({ fileName: p.fileName, ok: true });
    } catch (e) {
      const msg = e instanceof FenrirError ? e.message : (e as Error).message;
      const status = e instanceof FenrirError ? e.status : undefined;
      // A 409 "already submitted" is not a failure — the PoC was already sent
      // (accepted, still processing, or deduped away). Treat it as already.
      const already = status === 409 || /already submitted/i.test(msg);
      results.push({ fileName: p.fileName, ok: false, error: msg, status, already });
    }
  }
  const submitted = results.filter((r) => r.ok).length;
  const already = results.filter((r) => r.already).length;
  const failed = results.filter((r) => !r.ok && !r.already).length;
  return NextResponse.json({ ok: true, submitted, already, failed, total: results.length, results });
}
