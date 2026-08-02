import { NextRequest, NextResponse } from "next/server";
import { getMyProgress, listMyRepos, SilverError } from "@/lib/silver";
import { getStoredToken } from "@/lib/authStore";
import { getReposJsonCandidates, readReposJson } from "@/lib/silverDir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns:
 *   - `repos`: from silver.bonus.getMyProgress (only IDs + status — AfterQuery
 *     doesn't expose repo names through this endpoint).
 *   - `mapping`: contents of `<project_root>/repos.json` (or legacy
 *     `<silverDir>/repos.json`) if present, which the user maintains to map
 *     a taskName (or a prefix) to a repoId.
 *
 * mapping shapes accepted (auto-detected):
 *   { "<repoId>": ["<taskName1>", "<taskName2>", ...] }
 *   { "<taskName>": "<repoId>" }
 *   { "default": "<repoId>", "byTask": { "<taskName>": "<repoId>" } }
 *   { "default": "<repoId>", "byPrefix": { "lithos-": "<repoId>" } }
 */
export async function POST(req: NextRequest) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }

  // Primary: silver.submission.listMine — returns the user's full repo list
  // with names (id, repoName, displayName, status, language, taskIds, …).
  // Secondary: silver.bonus.getMyProgress — counts + abbreviated repo info.
  let repos: unknown[] = [];
  let progress: unknown = null;
  try {
    repos = await listMyRepos(token);
  } catch (e) {
    if (e instanceof SilverError) {
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  // getMyProgress is best-effort — surface failures but don't bail.
  try {
    progress = await getMyProgress(token);
  } catch (e) {
    progress = { error: (e as Error).message };
  }

  // Optional local mapping for the auto-handler.
  let mapping: unknown = null;
  let mapPath: string | null = null;
  try {
    const found = await readReposJson();
    if (found) {
      mapPath = found.path;
      mapping = JSON.parse(found.raw);
    }
  } catch (e) {
    // mapping file exists but is unreadable — surface that to the UI
    mapping = { error: (e as Error).message };
    mapPath = getReposJsonCandidates()[0];
  }

  // Compact projection of repos for UI consumption — strip the large
  // `commitShaSample` and `dockerImage.versions[*].judge` blobs.
  const reposCompact = (repos as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    repoName: r.repoName,
    displayName: r.displayName,
    status: r.status,
    language: r.language,
    zipSizeBytes: r.zipSizeBytes,
    fileCount: r.fileCount,
    taskIds: r.taskIds,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  return NextResponse.json({
    ok: true,
    repos: reposCompact,
    progress,
    mapping,
    mappingPath: mapPath,
  });
}
