import { NextRequest, NextResponse } from "next/server";
import { submitPatch, reviseFinding, FenrirError } from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Submit a unified-diff patch for one finding (crash) + the task description. */
export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    submissionId?: string;
    findingId?: string;
    patchText?: string;
    patchFileName?: string;
    description?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.submissionId || !body.findingId || !body.patchText?.trim()) {
    return NextResponse.json(
      { ok: false, error: "submissionId, findingId and patchText are required." },
      { status: 400 }
    );
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  const description = body.description?.trim() || undefined;
  try {
    // Set the description first (best-effort), then submit the patch with it too.
    if (description) {
      try {
        await reviseFinding(token, body.findingId, description);
      } catch {
        /* non-fatal — also sent in the patch body */
      }
    }
    const result = await submitPatch(token, {
      submissionId: body.submissionId,
      findingId: body.findingId,
      patchText: body.patchText,
      patchFileName: body.patchFileName?.trim() || "fix.patch",
      description,
    });
    return NextResponse.json({ ok: true, described: !!description, ...result });
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
