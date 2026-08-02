import { NextRequest, NextResponse } from "next/server";
import { getProfile, getStats, getGithubConnection, FenrirError } from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Contributor header: profile + stats + GitHub connection in one call. */
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
    // Tolerate any one of these failing — the header is best-effort.
    const [profile, stats, github] = await Promise.allSettled([
      getProfile(token),
      getStats(token),
      getGithubConnection(token),
    ]);
    return NextResponse.json({
      ok: true,
      profile: profile.status === "fulfilled" ? profile.value : null,
      stats: stats.status === "fulfilled" ? stats.value : null,
      github: github.status === "fulfilled" ? github.value : null,
    });
  } catch (e) {
    if (e instanceof FenrirError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
