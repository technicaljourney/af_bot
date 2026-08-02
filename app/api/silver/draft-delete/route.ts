import { NextRequest, NextResponse } from "next/server";
import { deleteDraft, SilverError } from "@/lib/silver";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { token?: string; draftId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.draftId) {
    return NextResponse.json({ ok: false, error: "draftId required." }, { status: 400 });
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    const r = await deleteDraft(token, body.draftId);
    return NextResponse.json({ ok: true, result: r });
  } catch (e) {
    if (e instanceof SilverError) {
      // 412 Precondition Failed usually means the draft is in a state
      // AfterQuery won't let us delete (e.g. a submission is still running,
      // or the draft has already been deleted). Pass `detail` through so the
      // caller can see the actual server-side message.
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          status: e.status,
          draftId: body.draftId,
          detail: e.detail,
        },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
