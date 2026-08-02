/**
 * Read-only AfterQuery feedback API:
 *   POST /api/projects/<proj>/get-user-submissions        -> { submissions: [...] }
 *   POST /api/projects/<proj>/harbor/get-pipeline-detail  -> { harborPipeline: {...} }
 *
 * These fetch the signed-in user's own submissions and review verdicts; they do
 * not create or modify anything.
 */

import { normalizeToken } from "@/lib/afterquery";

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";
const PROJECT = process.env.AFTERQUERY_PROJECT || "pluto";

export class FeedbackError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "FeedbackError";
    this.status = status;
    this.detail = detail;
  }
}

async function authedPost(path: string, token: string, body: unknown): Promise<any> {
  const t = normalizeToken(token);
  if (!t) throw new FeedbackError("Missing auth token.");
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/projects/${PROJECT}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
  } catch (e) {
    throw new FeedbackError(`Network error calling ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new FeedbackError(json?.error || json?.message || `${path} HTTP ${res.status}`, res.status, json);
  }
  return json;
}

export interface SubmissionRow {
  id: string;
  fileName: string;
  domain: string;
  status: string;
  rejectionCount: number;
  language: string;
  version: string;
  submittedAt: string | null;
  lastUpdated: string | null;
  harborSubmissionId: string | null;
  stage: string | null;
}

export async function getUserSubmissions(token: string): Promise<SubmissionRow[]> {
  const j = await authedPost("get-user-submissions", token, {});
  const list: any[] = Array.isArray(j?.submissions) ? j.submissions : Array.isArray(j) ? j : [];
  return list.map((s) => ({
    id: s.id,
    fileName: s.fileName,
    domain: s.domain ?? "",
    status: s.status ?? s._dbStatus ?? "",
    rejectionCount: s.rejectionCount ?? 0,
    language: s.language ?? "",
    version: s.version ?? "",
    submittedAt: s.submittedAt ?? null,
    lastUpdated: s.lastUpdated ?? null,
    harborSubmissionId: s.harborSubmissionId ?? null,
    stage: s.harborPipeline?.status ?? s.harborPipeline?.pipelineStage ?? null,
  }));
}

export async function getPipelineDetail(token: string, submissionId: string): Promise<any> {
  return authedPost("harbor/get-pipeline-detail", token, { submissionId });
}

export async function deleteSubmission(
  token: string,
  submissionId: string,
  harborSubmissionId?: string | null
): Promise<any> {
  // Best-guess endpoint (override with AFTERQUERY_DELETE_PATH if AfterQuery differs).
  const path = process.env.AFTERQUERY_DELETE_PATH || "delete-submission";
  return authedPost(path, token, { submissionId, harborSubmissionId: harborSubmissionId ?? undefined });
}

/**
 * Rerun a specific stage of the harbor pipeline for an existing submission.
 *   POST /api/projects/<proj>/harbor/retry-stage  { submissionId, stage }
 *     -> { success, message, stage, harborSubmissionId, usedRerunBudget }
 * Used to recover from infrastructure errors (e.g. executor couldn't start
 * Docker) without losing the submission.
 */
export async function retryStage(
  token: string,
  submissionId: string,
  stage: string
): Promise<any> {
  return authedPost("harbor/retry-stage", token, { submissionId, stage });
}

// ---- Pipeline view (mirrors AfterQuery's "Harbor Pipeline" card) -----------

export type StageStatus = "done" | "running" | "pending" | "failed" | "skipped";

export interface StageView {
  key: string;
  label: string;
  status: StageStatus;
  costUsd: number | null;
  summary: string | null;
  detail: unknown | null;
  /** Best-effort error/stalled/retry message extracted from the stage data. */
  error: string | null;
  /** "attempt N of M" if the stage is retrying. */
  retryNote: string | null;
}

export interface PipelineView {
  overallStatus: string | null;
  pipelineStage: string | null;
  completed: boolean;
  failed: boolean;
  currentStep: number;
  totalSteps: number;
  spentUsd: number | null;
  failure: string | null;
  /** Human-readable failure message (also shown when retrying). */
  failureMessage: string | null;
  /** True when the pipeline failed but will retry automatically. */
  retrying: boolean;
  retryAttempt: number | null;
  retryMax: number | null;
  stages: StageView[];
  feedbackMarkdown: string;
  pipelineKeys: string[];
}

// The 8 pipeline stages, in order, with candidate field names + cost tokens.
const STAGE_DEFS: { label: string; cands: string[]; costTokens: string[] }[] = [
  { label: "Similarity & Diversity", cands: ["similarityAnalysis"], costTokens: ["similarity", "diversity"] },
  { label: "CI Checks", cands: ["ciChecks"], costTokens: ["ci_check", "cichecks", "ci-"] },
  { label: "Quality Check (11 criteria)", cands: ["qualityCheck"], costTokens: ["quality_check", "qualitycheck"] },
  { label: "Validation pre-flight (pytest collect)", cands: ["validationPreflight"], costTokens: ["validation_preflight", "preflight"] },
  { label: "Oracle / NOP Validation", cands: ["harborValidation"], costTokens: ["oracle", "nop", "harbor_validation"] },
  { label: "Easiness Prefilter (Sonnet 4.6)", cands: ["easinessPrefilter", "sonnetPrefilter", "prefilter", "easiness"], costTokens: ["sonnet_prefilter", "prefilter", "easiness", "sonnet"] },
  { label: "Opus 4.7 Difficulty Probe", cands: ["difficultyProbe", "opusProbe", "difficulty"], costTokens: ["difficulty_probe", "difficulty", "opus"] },
  { label: "Agent Quality Check", cands: ["agentQualityCheck", "agentQuality", "agentCheck"], costTokens: ["agent_quality", "agent"] },
];

const HEAVY_KEYS = new Set([
  "instructionSkeleton",
  "rawChecks",
  "test_details",
  "raw_output",
  "stdout",
  "stderr",
]);

/** Truncate long strings, cap arrays, and drop the known huge fields. */
function trimDeep(v: any, depth = 0): any {
  if (typeof v === "string") return v.length > 1200 ? v.slice(0, 1200) + " …[truncated]" : v;
  if (Array.isArray(v)) {
    const arr = v.slice(0, 25).map((x) => trimDeep(x, depth + 1));
    if (v.length > 25) arr.push(`…(${v.length - 25} more)`);
    return arr;
  }
  if (v && typeof v === "object") {
    if (depth > 6) return "[…]";
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (HEAVY_KEYS.has(k)) continue;
      out[k] = trimDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

function resolveStage(hp: Record<string, any>, cands: string[]): { key: string | null; value: any } {
  const keys = Object.keys(hp);
  for (const c of cands) {
    const exact = keys.find((k) => k.toLowerCase() === c.toLowerCase());
    if (exact) return { key: exact, value: hp[exact] };
  }
  for (const c of cands) {
    const part = keys.find((k) => k.toLowerCase().includes(c.toLowerCase()));
    if (part) return { key: part, value: hp[part] };
  }
  return { key: null, value: undefined };
}

/** Best-effort extraction of an error/retry message from a stage's data. */
function extractStageError(v: any): { message: string | null; retryNote: string | null } {
  if (!v) return { message: null, retryNote: null };
  const o = Array.isArray(v) ? v[0] : v;
  if (!o || typeof o !== "object") return { message: null, retryNote: null };
  let msg: string | null =
    o.error ??
    o.failureReason ??
    o.errorMessage ??
    o.failure ??
    o.lastError ??
    (typeof o.state === "string" && /stall|fail|error|timeout/i.test(o.state) ? o.state : null) ??
    null;

  // Similarity-stage specific failure shape:
  //   { passed: false, failClosed: true, diversityWarnings: [{ severity: "hard_block", message }],
  //     failClosedReason: "Failed to parse response from check-similarity ..." }
  // Detect it via the structural fields rather than `passed: false` alone
  // (NOP/diversity stages legitimately use `passed: false` without being errors).
  if (!msg && Array.isArray(o.diversityWarnings) && o.diversityWarnings.length > 0) {
    const hardBlock = o.diversityWarnings.find(
      (w: any) => w && (w.severity === "hard_block" || w.severity === "hardBlock")
    );
    if (hardBlock) {
      msg =
        (typeof hardBlock.message === "string" ? hardBlock.message : null) ||
        (typeof o.failClosedReason === "string" ? o.failClosedReason : null) ||
        "Similarity hard block";
    }
  }
  if (!msg && o.failClosed === true) {
    msg =
      (typeof o.failClosedReason === "string" ? o.failClosedReason : null) ||
      "Similarity check failed";
  }

  // Probe-stage specific failure shape (Opus Difficulty Probe, Easiness
  // Prefilter): `band: "TOO_HARD" | "TOO_EASY" | "INFRA_ERROR" | ...` indicates
  // the task missed the target band OR the executor itself errored. Other
  // bands like "GOOD" / "PASSED" are pass states.
  if (!msg && typeof o.band === "string") {
    const b = o.band.toUpperCase();
    if (
      b === "TOO_HARD" ||
      b === "TOO_EASY" ||
      b === "FAILED" ||
      b === "FAIL" ||
      b.includes("INFRA") ||
      b.includes("ERROR")
    ) {
      msg =
        (typeof o.feedback === "string" ? o.feedback : null) ||
        `band: ${o.band}`;
    }
  }
  // Easiness Prefilter "too easy" / "too hard" boolean flags
  // (e.g. { passRate: 1, tooEasy: true, feedback: "Task is too easy..." }).
  if (!msg && (o.tooEasy === true || o.tooHard === true)) {
    msg =
      (typeof o.feedback === "string" ? o.feedback : null) ||
      (o.tooEasy ? "Task is too easy" : "Task is too hard");
  }
  const attempt =
    typeof o.attempt === "number"
      ? o.attempt
      : typeof o.currentAttempt === "number"
      ? o.currentAttempt
      : typeof o.attemptNumber === "number"
      ? o.attemptNumber
      : null;
  const max =
    typeof o.maxAttempts === "number"
      ? o.maxAttempts
      : typeof o.totalAttempts === "number"
      ? o.totalAttempts
      : null;
  const retryFlag =
    o.retrying === true || o.willRetry === true || o.isRetrying === true || o.willAutoRetry === true;
  let retryNote: string | null = null;
  if (attempt && max) retryNote = `Retrying automatically — attempt ${attempt} of ${max}`;
  else if (retryFlag) retryNote = "Retrying automatically";
  else if (attempt && attempt > 1) retryNote = `attempt ${attempt}`;
  return { message: msg ? String(msg) : null, retryNote };
}

function hasContent(v: any): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

function first(v: any): any {
  return Array.isArray(v) ? v[0] : v;
}

function rubricFrom(ciValue: any): { decision: string | null; review: string | null } | null {
  const ci = first(ciValue);
  const check = ci?.checks?.find?.((c: any) => c.name === "rubric_review.py");
  const raw = check?.message ?? first(ci?.rawChecks)?.stdout;
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return { decision: p.decision ?? null, review: typeof p.review === "string" ? p.review : null };
  } catch {
    return { decision: null, review: String(raw).slice(0, 3000) };
  }
}

/** Best-effort one-liner for the easiness/difficulty probe stages (unknown schema). */
function probeSummary(v: any): string | null {
  const o = first(v);
  if (!o || typeof o !== "object") return null;
  const band = o.band ?? o.difficultyBand ?? o.result ?? o.verdict ?? null;
  const passed = [o.numPassed, o.passCount, o.passed].find((x) => typeof x === "number");
  const total =
    [o.numRuns, o.runCount, o.total].find((x) => typeof x === "number") ??
    (Array.isArray(o.runs) ? o.runs.length : Array.isArray(o.episodes) ? o.episodes.length : undefined);
  const parts: string[] = [];
  if (typeof passed === "number" && typeof total === "number") parts.push(`pass ${passed}/${total}`);
  if (typeof band === "string") parts.push(`band ${band}`);
  // Easiness Prefilter verdict flags. `pass N/M` alone is misleading because
  // for Sonnet the goal is to FAIL — 5/5 = task too easy / rejected, 0/5 = ok.
  if (o.tooEasy === true) parts.push("TOO_EASY");
  else if (o.tooHard === true) parts.push("TOO_HARD");
  return parts.length ? parts.join(" · ") : null;
}

function stageSummary(label: string, value: any): string | null {
  if (!hasContent(value)) return null;
  if (label.startsWith("Similarity")) {
    const s = value;
    const hi = typeof s.highestSimilarity === "number" ? `${(s.highestSimilarity * 100).toFixed(1)}% highest` : null;
    const farm = s.suspectedFarming ? "farming?" : null;
    return [hi, farm].filter(Boolean).join(" · ") || (s.passed ? "passed" : null);
  }
  if (label.startsWith("CI")) {
    const ci = first(value);
    const r = rubricFrom(value);
    const base = `${ci?.passedCount ?? "?"}✓${ci?.failedCount ? ` ${ci.failedCount}✗` : ""}`;
    return r?.decision ? `${base} · rubric ${r.decision}` : base;
  }
  if (label.startsWith("Quality")) {
    const q = first(value);
    return q ? `${q.score ?? "?"}${q.applicableTotal != null ? ` (${q.applicableScore}/${q.applicableTotal})` : ""}` : null;
  }
  if (label.startsWith("Validation")) {
    const p = first(value);
    return p?.collectedCount != null ? `${p.collectedCount} tests collected` : p?.passed ? "passed" : null;
  }
  if (label.startsWith("Oracle")) {
    const hv = first(value);
    const o = hv?.oracleResult;
    const n = hv?.nopResult;
    const ot = o?.runs?.[0]?.pytestResults;
    const nt = n?.runs?.[0]?.pytestResults;
    const parts: string[] = [];
    if (o) parts.push(`oracle ${o.passed ? "pass" : "fail"}${ot ? ` ${ot.passed}/${ot.total_tests}` : ""}`);
    if (n) parts.push(`nop ${n.passed ? "pass⚠" : "fail✓"}${nt ? ` ${nt.passed}/${nt.total_tests}` : ""}`);
    return parts.join(" · ") || null;
  }
  // Easiness / Difficulty / Agent quality — unknown schema.
  return probeSummary(value);
}

export function buildPipelineView(detail: any): PipelineView {
  const hp = detail?.harborPipeline ?? {};
  const status: string | null = hp.status ?? null;
  const pipelineStage: string | null = hp.pipelineStage ?? null;
  const failure = hp.pipelineFailure ?? null;
  const completed =
    pipelineStage === "completed" || /approved|rejected|review ready|completed/i.test(String(status || ""));

  const stageCosts: any[] = hp.pipelineCosts?.stageCosts ?? [];
  const costFor = (tokens: string[]): number | null => {
    const e = stageCosts.find((c) => tokens.some((t) => String(c.stage || "").toLowerCase().includes(t)));
    return e && typeof e.costUsd === "number" ? e.costUsd : null;
  };

  const resolved = STAGE_DEFS.map((d) => ({ def: d, ...resolveStage(hp, d.cands) }));
  const firstIncomplete = resolved.findIndex((r) => !hasContent(r.value));

  let foundFailed = false;
  const stages: StageView[] = resolved.map((r, i) => {
    const has = hasContent(r.value);
    const err = extractStageError(r.value);
    let st: StageStatus;
    if (err.message || err.retryNote) {
      st = "failed";
      foundFailed = true;
    } else if (has) {
      st = "done";
    } else if (foundFailed) {
      // A prior stage already failed — anything after that with no content
      // didn't get a chance to run.
      st = "skipped";
    } else if (failure && i === firstIncomplete) {
      st = "failed";
      foundFailed = true;
    } else if (completed) {
      st = "skipped";
    } else if (firstIncomplete !== -1 && i === firstIncomplete) {
      st = "running";
    } else {
      st = "pending";
    }
    return {
      key: r.key ?? r.def.label,
      label: r.def.label,
      status: st,
      costUsd: costFor(r.def.costTokens),
      summary: stageSummary(r.def.label, r.value),
      detail: r.value !== undefined ? trimDeep(r.value) : null,
      error: err.message,
      retryNote: err.retryNote,
    };
  });

  const totalSteps = STAGE_DEFS.length;
  const runningIdx = stages.findIndex((s) => s.status === "running");
  const doneCount = stages.filter((s) => s.status === "done").length;
  const currentStep = completed ? totalSteps : runningIdx >= 0 ? runningIdx + 1 : doneCount;

  const spentUsd =
    typeof hp.pipelineCosts?.totalCostUsd === "number"
      ? hp.pipelineCosts.totalCostUsd
      : stageCosts.reduce((a, c) => a + (typeof c.costUsd === "number" ? c.costUsd : 0), 0) || null;

  // Extract a human-readable failure message + retry flags from pipelineFailure
  // (may be a string or an object) and from any stage-level retry note.
  let failureMessage: string | null = null;
  let retrying = false;
  let retryAttempt: number | null = null;
  let retryMax: number | null = null;
  if (failure) {
    if (typeof failure === "string") {
      failureMessage = failure;
    } else if (typeof failure === "object") {
      const f: any = failure;
      failureMessage = f.message ?? f.error ?? f.reason ?? f.detail ?? null;
      retrying = Boolean(f.retrying ?? f.willRetry ?? f.isRetrying ?? f.willAutoRetry);
      retryAttempt = typeof f.attempt === "number" ? f.attempt : null;
      retryMax = typeof f.maxAttempts === "number" ? f.maxAttempts : null;
    }
  }
  // If a stage carries a retry note, the pipeline as a whole is retrying.
  const retryingStage = stages.find((s) => s.retryNote);
  if (retryingStage) {
    retrying = true;
    if (!failureMessage && retryingStage.error) failureMessage = retryingStage.error;
    const m = retryingStage.retryNote?.match(/attempt\s+(\d+)\s+of\s+(\d+)/i);
    if (m) {
      retryAttempt = retryAttempt ?? Number(m[1]);
      retryMax = retryMax ?? Number(m[2]);
    }
  }

  // Build copy-paste feedback aimed at re-tuning the task (too easy / too hard).
  const fb: string[] = [];
  // Header: only include " — <fileName>" when we actually have one (avoids a
  // dangling em-dash like "# Task feedback —").
  const fileName = (detail as { fileName?: string } | null | undefined)?.fileName;
  fb.push(fileName ? `# Task feedback — ${fileName}` : `# Task feedback`);
  fb.push(`Status: ${status ?? pipelineStage ?? "unknown"}`);
  // Use the extracted human-readable message instead of stringifying the raw
  // pipelineFailure object (which would render "[object Object]").
  if (failure) {
    const failureText =
      typeof failure === "string"
        ? failure
        : failureMessage || JSON.stringify(failure);
    fb.push(`Pipeline failure: ${failureText}`);
  }
  const easy = stages.find((s) => s.label.startsWith("Easiness"));
  const diff = stages.find((s) => s.label.startsWith("Opus"));
  if (easy && hasContent(easy.detail)) {
    fb.push(`\n## Easiness Prefilter${easy.summary ? ` — ${easy.summary}` : ""}\n\`\`\`json\n${JSON.stringify(easy.detail, null, 2)}\n\`\`\``);
  }
  if (diff && hasContent(diff.detail)) {
    fb.push(`\n## Difficulty Probe${diff.summary ? ` — ${diff.summary}` : ""}\n\`\`\`json\n${JSON.stringify(diff.detail, null, 2)}\n\`\`\``);
  }
  const ciStage = resolved.find((r) => r.def.label.startsWith("CI"));
  const rub = rubricFrom(ciStage?.value);
  if (rub?.review) fb.push(`\n## Rubric review${rub.decision ? ` (${rub.decision})` : ""}\n${rub.review}`);
  const sim = resolved.find((r) => r.def.label.startsWith("Similarity"))?.value;
  if (sim?.highestSimilarity != null) {
    const matches = (sim.harborMatches ?? sim.plutoMatches ?? [])
      .slice(0, 5)
      .map((m: any) => `${m.taskName ?? "?"} (${((m.similarity ?? 0) * 100).toFixed(1)}%)`)
      .join(", ");
    fb.push(`\n## Similarity\nhighest ${(sim.highestSimilarity * 100).toFixed(1)}%${sim.suspectedFarming ? " · SUSPECTED FARMING" : ""}${matches ? `\nclosest: ${matches}` : ""}`);
  }

  return {
    overallStatus: status,
    pipelineStage,
    completed,
    failed: Boolean(failure) && !retrying,
    currentStep,
    totalSteps,
    spentUsd,
    failure: typeof failure === "string" ? failure : failureMessage,
    failureMessage,
    retrying,
    retryAttempt,
    retryMax,
    stages,
    feedbackMarkdown: fb.join("\n"),
    pipelineKeys: Object.keys(hp),
  };
}
