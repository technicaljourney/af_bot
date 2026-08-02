import { NextRequest, NextResponse } from "next/server";
import { recordStageFailure } from "@/lib/silverStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Count one pipeline failure for a task at a given stage.
 *
 *   POST { taskName, submissionId, failedStage }
 *
 * Called by the auto-handler whenever it sees a failed submission. Deduped
 * server-side by submissionId (in `<silverDir>/submission-stats.json`), so
 * the client may call this repeatedly for the same submission — across
 * ticks and page reloads — without inflating the counters.
 */
export async function POST(req: NextRequest) {
  let body: { taskName?: string; submissionId?: string; failedStage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const taskName = (body.taskName || "").trim();
  const submissionId = (body.submissionId || "").trim();
  const failedStage = (body.failedStage || "").trim();
  if (!taskName || !submissionId || !failedStage) {
    return NextResponse.json(
      { ok: false, error: "taskName, submissionId and failedStage required." },
      { status: 400 }
    );
  }
  try {
    const r = await recordStageFailure(taskName, submissionId, failedStage);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
