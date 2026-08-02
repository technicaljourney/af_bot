import { NextRequest, NextResponse } from "next/server";
import { getSubmission, FenrirError } from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Detail: one submission expanded plus its findings (crashes). */
export async function POST(req: NextRequest) {
  let body: { token?: string; submissionId?: string };
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
    const detail = await getSubmission(token, body.submissionId);
    return NextResponse.json({ ok: true, ...detail });
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
