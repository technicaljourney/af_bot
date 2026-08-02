import { NextRequest, NextResponse } from "next/server";
import { claimTask, RewriteError } from "@/lib/rewrite";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    const result = await claimTask(token);
    return NextResponse.json({ ok: true, task: result?.task ?? null, raw: result });
  } catch (e) {
    if (e instanceof RewriteError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
