import { NextResponse } from "next/server";
import { ensureFreshToken, getAuthStatus, clearAuth } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // The refresh token is the source of truth: proactively mint a fresh ID token
  // from it whenever the cached one is stale, rather than reporting an expired
  // extension token. No-op (returns the cached token) when it's still valid.
  await ensureFreshToken();
  return NextResponse.json({ ok: true, ...getAuthStatus() });
}

// Allow the UI to forget the extension-provided token.
export async function DELETE() {
  clearAuth();
  return NextResponse.json({ ok: true });
}
