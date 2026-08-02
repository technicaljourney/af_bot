import { NextRequest, NextResponse } from "next/server";
import { listConnectedRepos, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List repos already connected to the Gold project. Body: { token? }. */
export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — fall back to the stored token */
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  try {
    const repos = await listConnectedRepos(token);
    return NextResponse.json({ ok: true, repos });
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
