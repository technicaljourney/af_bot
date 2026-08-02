import { NextRequest, NextResponse } from "next/server";
import { archiveTask, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Archive (delete) a Gold task. Body: { submissionId, token? }. */
export async function POST(req: NextRequest) {
  let body: { submissionId?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const submissionId = (body.submissionId || "").trim();
  if (!submissionId) {
    return NextResponse.json({ ok: false, error: "submissionId is required." }, { status: 400 });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  try {
    const result = await archiveTask(token, submissionId);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof GoldError) {
      return NextResponse.json(
        { ok: false, error: e.message, detail: e.detail },
        { status: e.status && e.status >= 400 ? e.status : 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
