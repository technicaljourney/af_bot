/**
 * Silver project API client.
 *
 * Silver uses tRPC over `experts.afterquery.com/api/trpc/silver.tasks.*` with
 * the standard Bearer-token auth shared with Pluto / Rewrite.
 *
 *   - silver.tasks.drafts.listMine                       — list user's drafts
 *   - silver.tasks.submissions.listForDraft  { draftId } — submissions for a draft
 *   - silver.tasks.submissions.get           { taskId }  — one submission
 *   - silver.tasks.drafts.repoUsage                      — repo saturation
 *
 * tRPC URL format (single-procedure batch):
 *   /api/trpc/<procedure>?batch=1&input=<json-encoded { "0": { json: <input> } }>
 *
 * For procedures that take no input, the meta indicates the value is undefined:
 *   { "0": { "json": null, "meta": { "values": ["undefined"], "v": 1 } } }
 *
 * Response shape: `[{ "result": { "data": { "json": <payload> } } }]`
 */

import { normalizeToken } from "@/lib/afterquery";

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";

export class SilverError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "SilverError";
    this.status = status;
    this.detail = detail;
  }
}

function trpcUrl(procedure: string, input?: unknown): string {
  const inputObj =
    input === undefined
      ? { "0": { json: null, meta: { values: ["undefined"], v: 1 } } }
      : { "0": { json: input } };
  return `${BASE}/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(
    JSON.stringify(inputObj)
  )}`;
}

async function trpcGet<T = unknown>(
  token: string,
  procedure: string,
  input?: unknown
): Promise<T> {
  const t = normalizeToken(token);
  if (!t) throw new SilverError("Missing auth token.");
  let res: Response;
  try {
    res = await fetch(trpcUrl(procedure, input), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new SilverError(`Network error calling ${procedure}: ${(e as Error).message}`);
  }
  return unwrapTrpc<T>(res, procedure);
}

async function trpcPost<T = unknown>(
  token: string,
  procedure: string,
  input: unknown
): Promise<T> {
  const t = normalizeToken(token);
  if (!t) throw new SilverError("Missing auth token.");
  const url = `${BASE}/api/trpc/${procedure}?batch=1`;
  const body = JSON.stringify({ "0": { json: input } });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    throw new SilverError(`Network error calling ${procedure}: ${(e as Error).message}`);
  }
  return unwrapTrpc<T>(res, procedure);
}

async function unwrapTrpc<T>(res: Response, procedure: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    // tRPC batch errors come back as `[{ error: { json: { message, code,
    // data:{ code, httpStatus, path } } } }]`. Pull the inner message so the
    // caller sees something useful instead of just "HTTP 412".
    const fromBatch = extractTrpcBatchError(body);
    throw new SilverError(
      fromBatch?.message ||
        (body as Record<string, unknown>)?.error as string ||
        (body as Record<string, unknown>)?.message as string ||
        `${procedure} HTTP ${res.status}`,
      res.status,
      body
    );
  }
  const arr = body as Array<{ result?: { data?: { json?: T } } }> | null;
  return (arr?.[0]?.result?.data?.json ?? null) as T;
}

/** Pull the user-facing message + tRPC code out of a batched error response. */
function extractTrpcBatchError(
  body: unknown
): { message: string; code?: string; httpStatus?: number } | null {
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    const err = (entry as { error?: { json?: Record<string, unknown> } })?.error
      ?.json;
    if (!err) continue;
    const data = err.data as
      | { code?: string; httpStatus?: number }
      | undefined;
    return {
      message: typeof err.message === "string" ? err.message : JSON.stringify(err),
      code: data?.code,
      httpStatus: data?.httpStatus,
    };
  }
  return null;
}

// ---- Endpoints ------------------------------------------------------------

export async function listMyDrafts(token: string): Promise<unknown[]> {
  // AfterQuery expects an empty-object input here ({}) — NOT the
  // `null + meta.values=["undefined"]` pattern. Sending undefined returns 400.
  const out = await trpcGet<unknown[]>(token, "silver.tasks.drafts.listMine", {});
  return Array.isArray(out) ? out : [];
}

export async function listSubmissionsForDraft(
  token: string,
  draftId: string
): Promise<unknown[]> {
  const out = await trpcGet<unknown[]>(
    token,
    "silver.tasks.submissions.listForDraft",
    { draftId }
  );
  return Array.isArray(out) ? out : [];
}

export async function getSubmission(token: string, taskId: string): Promise<unknown> {
  return trpcGet(token, "silver.tasks.submissions.get", { taskId });
}

export async function repoUsage(token: string): Promise<unknown> {
  // This one DOES use the void-input pattern (undefined meta), unlike listMine.
  return trpcGet(token, "silver.tasks.drafts.repoUsage");
}

/** silver.submission.listMine — returns the user's submitted repositories
 *  with their full metadata (id, repoName, status, language, etc.). This is
 *  the source of truth for mapping a task-name prefix (e.g. "lithos-…") to a
 *  repoId, replacing the manual `repos.json` for the common case. */
export interface SilverRepo {
  id: string;
  repoName: string;
  displayName?: string | null;
  status?: string;
  language?: string;
  zipSizeBytes?: number;
  taskIds?: string[];
  approval?: { imageRef?: string };
}

export async function listMyRepos(token: string): Promise<SilverRepo[]> {
  const out = await trpcGet<SilverRepo[]>(token, "silver.submission.listMine");
  return Array.isArray(out) ? out : [];
}

/** Find the repo whose `repoName` (or `displayName`) is the longest prefix of
 *  the given taskName. Returns null if no repo's name is a prefix at all. */
export function matchRepoByTaskNamePrefix(
  repos: SilverRepo[],
  taskName: string,
  opts: { approvedOnly?: boolean } = {}
): SilverRepo | null {
  const approvedOnly = opts.approvedOnly !== false;
  let best: SilverRepo | null = null;
  let bestLen = 0;
  for (const r of repos) {
    if (approvedOnly && r.status && !/approv/i.test(r.status)) continue;
    const candidates = [r.repoName, r.displayName].filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    for (const name of candidates) {
      // Match either "<repoName>-…" or exact "<repoName>".
      if (taskName === name || taskName.startsWith(name + "-")) {
        if (name.length > bestLen) {
          best = r;
          bestLen = name.length;
        }
      }
    }
  }
  return best;
}

/** silver.bonus.getMyProgress — returns the user's progress including the
 *  list of approved/pending repos (only IDs + status, no names). */
export interface SilverRepoItem {
  id: string;
  status: string;
  createdAtMs?: number;
  kind?: string;
  revoked?: boolean;
}

export interface SilverProgress {
  repos?: {
    approvedCount?: number;
    pendingCount?: number;
    items?: SilverRepoItem[];
  };
  [k: string]: unknown;
}

export async function getMyProgress(token: string): Promise<SilverProgress | null> {
  return trpcGet<SilverProgress>(token, "silver.bonus.getMyProgress");
}

/** silver.tasks.drafts.importFromZip — creates a draft by sending the zip's
 *  unpacked file contents as a `{ "<relpath>": "<utf-8 text>" }` map, plus the
 *  base-commit SHA that pins the repo state. Returns the new draftId.
 *
 *  AfterQuery does NOT accept a base64 zip blob — the web UI unzips client-side
 *  and sends every file as a UTF-8 string keyed by its in-zip relative path
 *  (e.g. "environment/Dockerfile", "tests/config.json", …). The `baseCommit`
 *  is the git SHA the task was authored against; it lives inside the zip in
 *  `tests/config.json` under `base_commit`.
 */
export async function importFromZip(
  token: string,
  args: {
    repoId: string;
    taskName: string;
    baseCommit: string;
    files: Record<string, string>;
  }
): Promise<{ draftId: string } | null> {
  return trpcPost<{ draftId: string }>(
    token,
    "silver.tasks.drafts.importFromZip",
    args
  );
}

/** silver.tasks.submissions.submit — kicks off the validation pipeline for a
 *  draft and returns the new submissionId.
 *
 *  AfterQuery requires the draft's submission metadata to be passed here (it
 *  populates the task.toml fields that the upload step left blank):
 *    - humanSolveTime    e.g. "1h", "30m"
 *    - repoType          e.g. "database", "library"
 *    - requiresInternet  true / false
 *    - taskType          e.g. "bug-fix", "feature"
 *  These come from `<taskName>/task.toml` in the silver dir. */
export async function submitDraft(
  token: string,
  args: {
    draftId: string;
    humanSolveTime: string;
    repoType: string;
    requiresInternet: boolean;
    taskType: string;
  }
): Promise<{ submissionId: string } | null> {
  return trpcPost<{ submissionId: string }>(
    token,
    "silver.tasks.submissions.submit",
    args
  );
}

/** silver.tasks.drafts.delete — removes a draft (and its associated
 *  submission). Used by the auto-handler after writing feedback so the user
 *  can re-import a revised zip cleanly. */
export async function deleteDraft(
  token: string,
  draftId: string
): Promise<{ ok: boolean } | null> {
  return trpcPost<{ ok: boolean }>(token, "silver.tasks.drafts.delete", {
    draftId,
  });
}

// ---- Stage log fetch (rubric review, probe responses) -------------------

/** silver.tasks.submissions.logContent — fetch a stored stage response from
 *  GCS. AfterQuery's pipeline writes each model's verdict / review text to a
 *  GCS blob and stores only a small summary in the submission's pipeline
 *  field; the full prose lives in the `response.json` blob.
 *
 *  The `gcsRef` follows a predictable pattern:
 *    gs://afterqueryai.firebasestorage.app/projects/silver/tasks/<taskId>/<stage>/response.json
 *  which can be constructed via `silverStageGcsRef(taskId, stage)`.
 *
 *  The endpoint returns:
 *    { content: <stringified JSON>, storedAt: <iso timestamp> }
 *  The `content` is itself a JSON-encoded object — for `rubricReview` it
 *  carries `{ response: "<reviewer text>", storedAt: ... }`. */
export interface SilverLogContent {
  content: string;
  storedAt?: string;
}

export async function getSubmissionLogContent(
  token: string,
  taskId: string,
  gcsRef: string
): Promise<SilverLogContent | null> {
  return trpcGet<SilverLogContent>(
    token,
    "silver.tasks.submissions.logContent",
    { taskId, gcsRef }
  );
}

/** Build the GCS reference for a pipeline stage's stored output.
 *
 *  Most stages store a JSON response at `/<stage>/response.json`, but a few
 *  use a different path:
 *    - `taskImageBuild` writes the raw kaniko build log to
 *      `/runs/image-build/log.txt` (one file, plain text).
 *    - `easinessProbe` / `difficultyProbe` write ONE log per run (5 / 10
 *      runs each) at `/runs/<probe>/<runId>/log.txt`. The runId is a UUID
 *      that lives on each entry of the stage's `runs[]` array.
 *
 *  When `runId` is passed for a probe, the per-run log path is returned.
 *  Caller can also bypass everything by passing an explicit `gcsRef` to
 *  the proxy route. */
export function silverStageGcsRef(
  taskId: string,
  stage: string,
  runId?: string
): string {
  const base = `gs://afterqueryai.firebasestorage.app/projects/silver/tasks/${taskId}`;
  if (stage === "taskImageBuild") return `${base}/runs/image-build/log.txt`;
  if (stage === "easinessProbe" && runId)
    return `${base}/runs/easiness-probe/${runId}/log.txt`;
  if (stage === "difficultyProbe" && runId)
    return `${base}/runs/difficulty-probe/${runId}/log.txt`;
  return `${base}/${stage}/response.json`;
}

// ---- Failure-summary extraction ------------------------------------------

export interface SilverFailureSummary {
  taskName: string;
  status: string;
  failedStage: string | null;
  failureKind: string | null;
  failureReason: string | null;
  /** Pruned stage-specific data — *not* the full pipeline blob. */
  stage: Record<string, unknown> | null;
}

/**
 * Pull the meaningful failure detail out of a silver submission. Returns null
 * if there is no failure. Designed to keep the resulting JSON small but
 * actionable (which stage, why, the runs / scores you'd actually want).
 */
export function extractFailureSummary(submission: unknown): SilverFailureSummary | null {
  if (!submission || typeof submission !== "object") return null;
  const s = submission as {
    taskName?: string;
    status?: string;
    pipeline?: Record<string, unknown>;
  };
  const p = s.pipeline;
  if (!p) return null;
  const failedStage = (p.failedStage as string | null | undefined) ?? null;
  const status = s.status ?? "";
  // No failure recorded — nothing to extract.
  if (!failedStage && !/fail|reject|error/i.test(status)) return null;
  return {
    taskName: s.taskName ?? "",
    status,
    failedStage,
    failureKind: (p.failureKind as string | null | undefined) ?? null,
    failureReason: (p.failureReason as string | null | undefined) ?? null,
    stage: failedStage ? compactStage(failedStage, p[failedStage]) : null,
  };
}

function compactStage(name: string, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = pick(o, ["status", "error", "ranAt"]);
  switch (name) {
    case "similarity":
      return {
        ...base,
        ...pick(o, ["nearestDistance", "nearestTaskName", "nearestTaskId", "blocked"]),
        details: Array.isArray(o.details)
          ? (o.details as Array<Record<string, unknown>>).map((d) =>
              pick(d, ["layer", "severity", "score", "message"])
            )
          : null,
      };
    case "gptZeroCheck":
      return {
        ...base,
        ...pick(o, ["threshold", "failOpen", "failOpenReason"]),
        instruction: o.instruction ? pick(o.instruction as Record<string, unknown>, ["passed", "score", "skipped"]) : null,
        referencePlan: o.referencePlan ? pick(o.referencePlan as Record<string, unknown>, ["passed", "score", "skipped"]) : null,
      };
    case "rubricReview":
      return { ...base, ...pick(o, ["decision", "blocked", "costUsd"]) };
    case "taskImageBuild":
      return { ...base, ...pick(o, ["imageRef", "jobName"]) };
    case "oracleCheck":
    case "nullCheck":
      return { ...base, ...pick(o, ["reward", "jobId"]) };
    case "easinessProbe":
    case "difficultyProbe":
      return {
        ...base,
        ...pick(o, ["passed", "attempts", "solveRate", "model"]),
        runs: Array.isArray(o.runs)
          ? (o.runs as Array<Record<string, unknown>>).map((r) =>
              // Keep runId so the auto-handler can build the per-run
              // /runs/<probe>/<runId>/log.txt URL and embed the model's
              // actual solver log in the feedback JSON.
              pick(r, [
                "runIndex",
                "reward",
                "runId",
                "id",
                "jobName",
                "status",
              ])
            )
          : null,
      };
    case "trajectoryReview":
    case "fairnessReview":
      return { ...base, ...pick(o, ["decision", "blocked", "costUsd"]) };
    default:
      return { ...base };
  }
}

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
