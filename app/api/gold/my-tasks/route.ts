import { NextRequest, NextResponse } from "next/server";
import { listMyTasks, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List the current user's Gold tasks. Body: { token? }. */
export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok — fall back to stored token */
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  try {
    const tasks = await listMyTasks(token);
    return NextResponse.json({ ok: true, tasks });
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
