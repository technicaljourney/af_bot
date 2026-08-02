import { NextRequest, NextResponse } from "next/server";
import { listMyDrafts, SilverError } from "@/lib/silver";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    const drafts = await listMyDrafts(token);
    return NextResponse.json({ ok: true, count: drafts.length, drafts });
  } catch (e) {
    if (e instanceof SilverError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
