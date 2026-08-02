import { NextRequest, NextResponse } from "next/server";
import { getUserSubmissions, FeedbackError } from "@/lib/feedback";
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
    const submissions = await getUserSubmissions(token);
    return NextResponse.json({ ok: true, count: submissions.length, submissions });
  } catch (e) {
    if (e instanceof FeedbackError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
