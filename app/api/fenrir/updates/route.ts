import { NextRequest, NextResponse } from "next/server";
import { readUpdates } from "@/lib/fenrirUpdates";
import { fenrirDirByKey } from "@/lib/fenrirLocal";
import { listSubmitted } from "@/lib/autoSubmitLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Repos listed in the active work folder's `updates.json`, each flagged with
 * whether auto-submit has ALREADY sent it.
 *
 * That flag comes from our own durable ledger, never from the account's live
 * submission list: a repo you deleted after it failed is absent from the account
 * but must still count as submitted, or it gets sent again on the next poll.
 */
export async function POST(req: NextRequest) {
  let body: { folder?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const dir = fenrirDirByKey(body.folder);
  const { entries, file, missing, error } = await readUpdates(dir);
  if (error) return NextResponse.json({ ok: false, error, file }, { status: 200 });

  const submitted = await listSubmitted();
  const annotated = entries.map((e) => {
    const rec = submitted[e.key];
    return {
      ...e,
      submitted: Boolean(rec),
      submittedAt: rec?.at,
      submissionId: rec?.submissionId,
    };
  });

  return NextResponse.json({
    ok: true,
    entries: annotated,
    file,
    missing,
    pending: annotated.filter((e) => !e.submitted).length,
    recorded: Object.keys(submitted).length,
  });
}
