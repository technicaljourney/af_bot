import { NextRequest, NextResponse } from "next/server";
import { submitRewrite, RewriteError } from "@/lib/rewrite";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { token?: string; taskId?: string; rewriteText?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.taskId) {
    return NextResponse.json({ ok: false, error: "taskId required." }, { status: 400 });
  }
  if (typeof body.rewriteText !== "string" || !body.rewriteText.trim()) {
    return NextResponse.json({ ok: false, error: "rewriteText required." }, { status: 400 });
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    const data = await submitRewrite(token, body.taskId, body.rewriteText);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    if (e instanceof RewriteError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
