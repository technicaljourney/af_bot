import { NextRequest, NextResponse } from "next/server";
import { recordSubmit } from "@/lib/silverStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Count one successful submission for a task in the LOCAL task-stats.json.
 *
 *   POST { taskName, submissionId }
 *
 * Called by the Silver UI after a submit succeeds (manual button and
 * auto-handler both). Purely local bookkeeping — this route never talks to
 * AfterQuery, and the AfterQuery-facing submit route has no stats hooks.
 * Deduped by submissionId, so repeat calls can't inflate the counter.
 */
export async function POST(req: NextRequest) {
  let body: { taskName?: string; submissionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const taskName = (body.taskName || "").trim();
  const submissionId = (body.submissionId || "").trim();
  if (!taskName || !submissionId) {
    return NextResponse.json(
      { ok: false, error: "taskName and submissionId required." },
      { status: 400 }
    );
  }
  try {
    const r = await recordSubmit(taskName, submissionId);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
