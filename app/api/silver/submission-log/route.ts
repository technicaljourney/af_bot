import { NextRequest, NextResponse } from "next/server";
import {
  getSubmissionLogContent,
  silverStageGcsRef,
  SilverError,
} from "@/lib/silver";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fetch a stored pipeline-stage response blob for a submission.
 *
 *   POST { submissionId, stage, gcsRef?, token? }
 *
 *   stage examples: "rubricReview", "easinessProbe", "difficultyProbe",
 *   "gptZeroCheck", "similarity"
 *
 * If `gcsRef` is omitted, it's reconstructed from `submissionId` + `stage`
 * via the canonical pattern
 *   gs://afterqueryai.firebasestorage.app/projects/silver/tasks/<id>/<stage>/response.json
 *
 * Returns:
 *   { ok: true, taskId, stage, gcsRef, storedAt,
 *     content: <raw string from AfterQuery>,
 *     parsed:  <JSON.parse(content) or null> }
 *
 * `parsed` is what the auto-handler embeds in the feedback JSON — for
 * `rubricReview` that's `{ response: "<reviewer text>", storedAt: ... }`.
 */
export async function POST(req: NextRequest) {
  let body: { token?: string; submissionId?: string; stage?: string; gcsRef?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.submissionId || typeof body.submissionId !== "string") {
    return NextResponse.json(
      { ok: false, error: "submissionId required." },
      { status: 400 }
    );
  }
  if (!body.stage || typeof body.stage !== "string") {
    return NextResponse.json(
      { ok: false, error: "stage required (e.g. 'rubricReview')." },
      { status: 400 }
    );
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }

  const taskId = body.submissionId.trim();
  const stage = body.stage.trim();
  const gcsRef = body.gcsRef?.trim() || silverStageGcsRef(taskId, stage);

  let log;
  try {
    log = await getSubmissionLogContent(token, taskId, gcsRef);
  } catch (e) {
    if (e instanceof SilverError) {
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          status: e.status,
          taskId,
          stage,
          gcsRef,
          detail: e.detail,
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }

  if (!log) {
    return NextResponse.json({
      ok: true,
      taskId,
      stage,
      gcsRef,
      content: null,
      parsed: null,
      storedAt: null,
    });
  }

  // `content` is a stringified JSON blob — parse it once on this side so the
  // caller doesn't have to re-stringify before embedding in the feedback JSON.
  let parsed: unknown = null;
  if (typeof log.content === "string" && log.content.length > 0) {
    try {
      parsed = JSON.parse(log.content);
    } catch {
      parsed = null;
    }
  }

  return NextResponse.json({
    ok: true,
    taskId,
    stage,
    gcsRef,
    storedAt: log.storedAt ?? null,
    content: log.content ?? null,
    parsed,
  });
}
