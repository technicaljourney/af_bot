import { NextRequest, NextResponse } from "next/server";
import { scanLocalRepos, normalizeRepoUrl, type LocalRepo } from "@/lib/fenrirRepos";
import { listSubmissions, FenrirError } from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface LocalRepoCandidate extends LocalRepo {
  alreadySubmitted: boolean;
}

/** Scan the local Fenrir/ folder and flag which repos are already submitted. */
export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const repos = await scanLocalRepos();

  // Dedupe against live submissions if we have a token (best-effort).
  let submitted = new Set<string>();
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (token) {
    try {
      const subs = await listSubmissions(token);
      submitted = new Set(
        subs.map((s) => (s.repoUrl ? normalizeRepoUrl(s.repoUrl) : "")).filter(Boolean)
      );
    } catch (e) {
      if (!(e instanceof FenrirError)) throw e;
      // token invalid / network — return repos without dedupe rather than failing.
    }
  }

  const candidates: LocalRepoCandidate[] = repos.map((r) => ({
    ...r,
    alreadySubmitted: r.repoUrl ? submitted.has(normalizeRepoUrl(r.repoUrl)) : false,
  }));

  return NextResponse.json({ ok: true, repos: candidates, deduped: submitted.size > 0 });
}
