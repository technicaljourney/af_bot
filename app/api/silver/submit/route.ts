import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  importFromZip,
  submitDraft,
  listMyDrafts,
  listMyRepos,
  matchRepoByTaskNamePrefix,
  SilverError,
  SilverRepo,
} from "@/lib/silver";
import { getStoredToken } from "@/lib/authStore";
import { getReposJsonCandidates, getSilverTaskDir, readReposJson } from "@/lib/silverDir";
import {
  readTaskMeta,
  feedbackJsonPath,
  isReadyStatus,
  isFailedStatus,
  isScaffoldPath,
  SilverTaskMeta,
} from "@/lib/silverTaskMeta";
import {
  normalizeSolveTime,
  normalizeRepoType,
  normalizeTaskType,
} from "@/lib/silverTaskList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Silver submit chain (folder + task.toml based):
 *   0. Guards: `<silverDir>/<taskName>.feedback.json` exists → already
 *      handled, skip. Duplicate live draft → skip.
 *   1. `<silverDir>/<taskName>/task.toml` is REQUIRED — its presence is the
 *      "task is ready" marker and its [metadata] section carries the
 *      submission metadata (human_solve_time, task_type, repo_type) plus
 *      [environment].allow_internet. An optional [metadata].status blocks
 *      when not "Ready"/"Pending"; "Failed" → never auto-retry.
 *   2. Walk `<silverDir>/<taskName>/` and collect the SCAFFOLD files as
 *        { "<relpath>": "<utf-8 text>" }.
 *      Scaffold = task.toml, instruction.md, reference_plan.md and the
 *      environment/, solution/, tests/ trees. Authoring material in the
 *      same folder (dossier.md, *.pre-humanize*.md, *.bak, drafts) is
 *      NEVER uploaded.
 *   3. Pull `baseCommit` from tests/config.json.
 *   4. Resolve repoId  (a) body.repoId
 *                      (b) optional task.toml `repo` hint matched by name
 *                      (c) auto-match repo-name prefix of taskName
 *                      (d) repos.json fallback.
 *   5. Metadata from task.toml (body enum overrides win).
 *   6. POST silver.tasks.drafts.importFromZip → { draftId }
 *   7. Wait 5 s.
 *   8. POST silver.tasks.submissions.submit  → { submissionId }
 *
 * The `fileName` body field is accepted as an alias for `taskName` so the
 * existing Silver UI keeps working without changes.
 */
export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    fileName?: string; // legacy alias for taskName
    taskName?: string;
    repoId?: string;
    humanSolveTime?: string;
    repoType?: string;
    taskType?: string;
    requiresInternet?: boolean;
  };
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

  const rawName = (body.taskName || body.fileName || "").trim();
  if (!rawName) {
    return NextResponse.json(
      { ok: false, error: "taskName (or fileName) required." },
      { status: 400 }
    );
  }
  const taskName = rawName.replace(/\.zip$/i, "");
  const safe = path.basename(taskName);
  if (safe !== taskName || !safe || safe.startsWith(".")) {
    return NextResponse.json({ ok: false, error: "Invalid taskName." }, { status: 400 });
  }

  const dir = getSilverTaskDir();
  const taskDir = path.join(dir, safe);
  if (path.dirname(taskDir) !== path.resolve(dir)) {
    return NextResponse.json(
      { ok: false, error: "Path outside silver dir." },
      { status: 400 }
    );
  }

  // 0a. Feedback guard — `<taskName>.feedback.json` means the auto-handler
  //     already left feedback for this task. The user deletes the file when
  //     they're ready to retry (after revising the folder).
  const feedbackPath = feedbackJsonPath(safe);
  try {
    await fs.access(feedbackPath);
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "feedback-json-exists",
      fileName: safe,
      taskName: safe,
      feedbackPath,
      message:
        `Skipped "${safe}" — ${safe}.feedback.json exists in the silver dir. ` +
        `Delete it to allow a retry.`,
    });
  } catch {
    /* no feedback file → continue */
  }

  // 0b. Duplicate guard — if a draft for this taskName already exists, skip.
  try {
    const existing = await listMyDrafts(token);
    const dupe = (existing as Array<Record<string, unknown>>).find(
      (d) => typeof d?.taskName === "string" && (d.taskName as string) === safe
    );
    if (dupe) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "duplicate-draft",
        fileName: safe,
        taskName: safe,
        draftId: typeof dupe.id === "string" ? dupe.id : null,
        status: typeof dupe.status === "string" ? dupe.status : null,
        message: `Draft for "${safe}" already exists — skipped upload.`,
      });
    }
  } catch (e) {
    console.warn("silver listMyDrafts (dup check) failed:", (e as Error).message);
  }

  // 1. task.toml — required. Its presence is the "ready" signal and it
  //    carries the submission metadata.
  let meta: SilverTaskMeta | null;
  try {
    meta = await readTaskMeta(safe);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `task.toml unreadable: ${(e as Error).message}` },
      { status: 400 }
    );
  }
  if (!meta) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Task "${safe}" is not ready — no task.toml in ${taskDir}. ` +
          `Only folders with a task.toml are submittable.`,
      },
      { status: 400 }
    );
  }
  // 1a. Optional status guards. "Failed" is the human reviewer's verdict —
  //     never auto-retry. Any other non-ready status (e.g. "Hold") blocks
  //     too, with its own skip reason.
  if (isFailedStatus(meta.status)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "status-failed",
      fileName: safe,
      taskName: safe,
      status: meta.status,
      message:
        `Skipped "${safe}" — task.toml status = "${meta.status}". ` +
        `Remove it (or set "Ready") to allow another attempt.`,
    });
  }
  if (!isReadyStatus(meta.status)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "status-blocked",
      fileName: safe,
      taskName: safe,
      status: meta.status,
      message:
        `Skipped "${safe}" — task.toml status = "${meta.status}". ` +
        `Remove it (or set "Ready") to allow submitting.`,
    });
  }

  // 2. Walk the task folder and collect the scaffold files as utf-8
  //    strings. Non-scaffold paths (dossier.md, *.pre-humanize*.md, *.bak,
  //    drafts, logs) are authoring material and are never uploaded.
  let files: Record<string, string>;
  let totalBytes = 0;
  try {
    const st = await fs.stat(taskDir);
    if (!st.isDirectory()) {
      return NextResponse.json(
        { ok: false, error: `Not a directory: ${taskDir}` },
        { status: 400 }
      );
    }
    files = {};
    await walkScaffold(taskDir, "", files, (bytes) => {
      totalBytes += bytes;
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        { ok: false, error: `Task folder not found: ${taskDir}` },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { ok: false, error: `Read task folder: ${(e as Error).message}` },
      { status: 500 }
    );
  }
  if (Object.keys(files).length === 0) {
    return NextResponse.json(
      { ok: false, error: `No scaffold files found in: ${taskDir}` },
      { status: 400 }
    );
  }

  // 3. baseCommit from tests/config.json.
  let baseCommit = "";
  try {
    const cfgRaw = files["tests/config.json"];
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw) as { base_commit?: string };
      if (typeof cfg.base_commit === "string") baseCommit = cfg.base_commit.trim();
    }
  } catch {
    /* fall through */
  }
  if (!baseCommit) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Couldn't extract baseCommit from ${safe}. ` +
          `Expected tests/config.json with a non-empty "base_commit" field.`,
      },
      { status: 400 }
    );
  }

  // 4. Resolve repoId.
  let repoId = body.repoId?.trim() || "";
  let resolvedFrom: "body" | "task-toml-repo" | "auto-match" | "repos.json" | null =
    repoId ? "body" : null;
  let matchedRepoName: string | null = null;
  if (!repoId) {
    try {
      const repos = await listMyRepos(token);
      // (b) Optional task.toml repo hint — exact match first, against
      //     approved repos.
      if (meta.repo) {
        const byName = matchRepoByName(repos, meta.repo);
        if (byName?.id) {
          repoId = byName.id;
          matchedRepoName = byName.repoName;
          resolvedFrom = "task-toml-repo";
        }
      }
      // (c) Fallback: longest repo-name prefix of the task name
      //     ("verba-aggregations" → repo "verba").
      if (!repoId) {
        const match = matchRepoByTaskNamePrefix(repos, safe);
        if (match?.id) {
          repoId = match.id;
          matchedRepoName = match.repoName;
          resolvedFrom = "auto-match";
        }
      }
    } catch (e) {
      console.warn("silver listMyRepos failed:", (e as Error).message);
    }
  }
  if (!repoId) {
    try {
      repoId = (await resolveRepoIdFromConfig(safe)) || "";
      if (repoId) resolvedFrom = "repos.json";
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `repos.json: ${(e as Error).message}` },
        { status: 500 }
      );
    }
  }
  if (!repoId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `No repoId for "${safe}". No approved repo matches the task-name ` +
          `prefix${meta.repo ? ` or the task.toml repo hint ${JSON.stringify(meta.repo)}` : ""}, ` +
          `and no mapping in repos.json ` +
          `(checked: ${getReposJsonCandidates().join(", ")}).`,
      },
      { status: 400 }
    );
  }

  // 5. Submission metadata from task.toml (body enum overrides win). The
  //    toml values are already enum-shaped ("2h", "feature", "dev-tooling")
  //    but the normalizers also tolerate descriptive forms.
  const humanSolveTime =
    normalizeSolveTime(body.humanSolveTime) ??
    normalizeSolveTime(meta.estimatedSolveTime);
  const repoType =
    normalizeRepoType(body.repoType) ?? normalizeRepoType(meta.repoType);
  const taskType =
    normalizeTaskType(body.taskType) ?? normalizeTaskType(meta.taskType);
  const requiresInternet =
    typeof body.requiresInternet === "boolean"
      ? body.requiresInternet
      : meta.requiresInternet ?? false;
  const missing: string[] = [];
  if (!humanSolveTime) missing.push(`humanSolveTime (raw: ${JSON.stringify(meta.estimatedSolveTime)})`);
  if (!repoType) missing.push(`repoType (raw: ${JSON.stringify(meta.repoType)})`);
  if (!taskType) missing.push(`taskType (raw: ${JSON.stringify(meta.taskType)})`);
  if (missing.length) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Missing / unmappable submission metadata for "${safe}": ${missing.join(", ")}. ` +
          `Either fix [metadata] in ${safe}/task.toml or pass enum overrides in the body. ` +
          `Allowed: humanSolveTime ∈ {30m,1h,2h,4h,8h+}; ` +
          `repoType ∈ {web-app,data-infra,dev-tooling,distributed-systems,ml,database,other}; ` +
          `taskType ∈ {bug-fix,feature,refactor,perf,other}.`,
      },
      { status: 400 }
    );
  }

  // 6. importFromZip → draftId
  let draftId: string;
  try {
    const r = await importFromZip(token, {
      repoId,
      taskName: safe,
      baseCommit,
      files,
    });
    if (!r?.draftId) {
      return NextResponse.json(
        { ok: false, step: "importFromZip", error: "no draftId in response" },
        { status: 502 }
      );
    }
    draftId = r.draftId;
  } catch (e) {
    if (e instanceof SilverError) {
      return NextResponse.json(
        { ok: false, step: "importFromZip", error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, step: "importFromZip", error: (e as Error).message },
      { status: 500 }
    );
  }

  // 7. Pause before submit so the draft is queryable.
  await new Promise((res) => setTimeout(res, 5000));

  // 8. submitDraft → submissionId
  let submissionId: string;
  try {
    // Non-null assertions are safe: the `missing.length` guard above returns
    // early unless all three resolved to a valid enum value.
    const r = await submitDraft(token, {
      draftId,
      humanSolveTime: humanSolveTime!,
      repoType: repoType!,
      requiresInternet,
      taskType: taskType!,
    });
    if (!r?.submissionId) {
      return NextResponse.json(
        { ok: false, step: "submitDraft", draftId, error: "no submissionId in response" },
        { status: 502 }
      );
    }
    submissionId = r.submissionId;
  } catch (e) {
    if (e instanceof SilverError) {
      return NextResponse.json(
        { ok: false, step: "submitDraft", draftId, error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, step: "submitDraft", draftId, error: (e as Error).message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    fileName: safe,
    taskName: safe,
    repoId,
    repoName: matchedRepoName,
    resolvedFrom,
    baseCommit,
    fileCount: Object.keys(files).length,
    totalBytes,
    humanSolveTime,
    repoType,
    taskType,
    requiresInternet,
    draftId,
    submissionId,
  });
}

/** Recursive walk that adds only SCAFFOLD files under `absRoot` to `out`,
 *  keyed by forward-slash relative path. See isScaffoldPath() for the
 *  whitelist. Skips symlinks. */
async function walkScaffold(
  absRoot: string,
  relPrefix: string,
  out: Record<string, string>,
  onBytes: (b: number) => void
): Promise<void> {
  const here = relPrefix ? path.join(absRoot, relPrefix) : absRoot;
  const entries = await fs.readdir(here, { withFileTypes: true });
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    const abs = path.join(absRoot, rel);
    if (e.isDirectory()) {
      // Descend only into scaffold dirs (test with a probe child path).
      if (isScaffoldPath(`${rel}/x`)) {
        await walkScaffold(absRoot, rel, out, onBytes);
      }
    } else if (e.isFile() && isScaffoldPath(rel)) {
      const buf = await fs.readFile(abs);
      onBytes(buf.length);
      out[rel] = buf.toString("utf8");
    }
  }
}

/** Exact (case-insensitive) repoName / displayName match among approved
 *  repos — used for the optional task.toml `repo` hint. */
function matchRepoByName(repos: SilverRepo[], name: string): SilverRepo | null {
  const want = name.trim().toLowerCase();
  for (const r of repos) {
    if (r.status && !/approv/i.test(r.status)) continue;
    const candidates = [r.repoName, r.displayName].filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    if (candidates.some((c) => c.trim().toLowerCase() === want)) return r;
  }
  return null;
}

async function resolveRepoIdFromConfig(taskName: string): Promise<string | null> {
  const found = await readReposJson();
  if (!found) return null;
  const raw = found.raw;
  const cfg = JSON.parse(raw) as unknown;
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg as Record<string, unknown>;

  if (typeof c.byTask === "object" && c.byTask) {
    const v = (c.byTask as Record<string, unknown>)[taskName];
    if (typeof v === "string") return v;
  }
  if (typeof c.byPrefix === "object" && c.byPrefix) {
    const bp = c.byPrefix as Record<string, unknown>;
    for (const [prefix, repoId] of Object.entries(bp)) {
      if (taskName.startsWith(prefix) && typeof repoId === "string") return repoId;
    }
  }
  if (typeof c.default === "string") return c.default;

  for (const [maybeRepoId, val] of Object.entries(c)) {
    if (Array.isArray(val) && val.includes(taskName) && /^[A-Za-z0-9]+$/.test(maybeRepoId)) {
      return maybeRepoId;
    }
  }

  const flat = c[taskName];
  if (typeof flat === "string") return flat;

  return null;
}
