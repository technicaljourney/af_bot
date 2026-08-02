import { NextRequest, NextResponse } from "next/server";
import {
  deleteSubmission,
  reviseSubmission,
  deleteFinding,
  reviseFinding,
  reviseFindingPatch,
  reProbeFinding,
  FenrirError,
} from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action =
  | "delete-submission"
  | "revise-submission"
  | "delete-finding"
  | "revise-finding"
  | "revise-finding-patch"
  | "re-probe-finding";

interface Body {
  token?: string;
  action?: Action;
  submissionId?: string;
  findingId?: string;
  description?: string;
  repoUrl?: string;
  ref?: string;
}

/** Unified Fenrir lifecycle actions (delete / revise / re-probe). */
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }
  try {
    let result: unknown;
    switch (body.action) {
      case "delete-submission":
        requireId(body.submissionId, "submissionId");
        result = await deleteSubmission(token, body.submissionId!);
        break;
      case "revise-submission":
        requireId(body.submissionId, "submissionId");
        result = await reviseSubmission(token, body.submissionId!, {
          repoUrl: body.repoUrl,
          ref: body.ref,
        });
        break;
      case "delete-finding":
        requireId(body.findingId, "findingId");
        result = await deleteFinding(token, body.findingId!);
        break;
      case "revise-finding":
        requireId(body.findingId, "findingId");
        if (!body.description?.trim()) throw new BadRequest("description required.");
        result = await reviseFinding(token, body.findingId!, body.description);
        break;
      case "revise-finding-patch":
        requireId(body.findingId, "findingId");
        result = await reviseFindingPatch(token, body.findingId!);
        break;
      case "re-probe-finding":
        requireId(body.findingId, "findingId");
        result = await reProbeFinding(token, body.findingId!);
        break;
      default:
        return NextResponse.json(
          { ok: false, error: `Unknown action: ${body.action}` },
          { status: 400 }
        );
    }
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof BadRequest) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    if (e instanceof FenrirError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

class BadRequest extends Error {}
function requireId(v: string | undefined, name: string): void {
  if (!v || !v.trim()) throw new BadRequest(`${name} required.`);
}
