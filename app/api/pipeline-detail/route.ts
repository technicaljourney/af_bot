import { NextRequest, NextResponse } from "next/server";
import { getPipelineDetail, buildPipelineView, FeedbackError } from "@/lib/feedback";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { submissionId?: string; token?: string; raw?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.submissionId) {
    return NextResponse.json({ ok: false, error: "submissionId required." }, { status: 400 });
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    const detail = await getPipelineDetail(token, body.submissionId);
    const pipeline = buildPipelineView(detail);
    return NextResponse.json({ ok: true, pipeline, ...(body.raw ? { raw: detail } : {}) });
  } catch (e) {
    if (e instanceof FeedbackError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
