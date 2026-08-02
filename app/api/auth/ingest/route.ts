import { NextRequest, NextResponse } from "next/server";
import { ingestToken, getAuthStatus } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Extension fetches with host permissions bypass CORS, but allow it explicitly
// so a manual curl / other localhost tooling works too.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  let body: { token?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400, headers: CORS });
  }
  if (!body.token || !body.token.trim()) {
    return NextResponse.json({ ok: false, error: "token required." }, { status: 400, headers: CORS });
  }
  ingestToken(body.token, body.source || "extension");
  const status = getAuthStatus();
  return NextResponse.json({ ok: true, status }, { headers: CORS });
}
