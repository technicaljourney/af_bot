import { NextRequest, NextResponse } from "next/server";
import {
  ingestRefreshToken,
  clearRefreshToken,
  getAuthStatus,
} from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Store a Firebase refresh token + Web API key; the server exchanges it for
 *  ID tokens and keeps them fresh automatically. */
export async function POST(req: NextRequest) {
  let body: { refreshToken?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.refreshToken?.trim() || !body.apiKey?.trim()) {
    return NextResponse.json(
      { ok: false, error: "refreshToken and apiKey are required." },
      { status: 400 }
    );
  }
  const result = await ingestRefreshToken(body.refreshToken, body.apiKey);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, status: getAuthStatus() });
}

/** Forget the refresh token (stops auto-refresh). */
export async function DELETE() {
  await clearRefreshToken();
  return NextResponse.json({ ok: true, status: getAuthStatus() });
}
