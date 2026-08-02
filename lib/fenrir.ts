/**
 * Fenrir project API client — BROWSE / MANAGE (read + lifecycle actions).
 *
 * Fenrir is AfterQuery's fuzzing-task project: you submit a private repo with a
 * fuzzing harness, the platform fuzzes it, and each surfaced crash becomes a
 * "finding" (the actual task) that you patch. A GPT-5.5 difficulty check gates
 * approval. See ../../Fenrir/instruction.md for the full flow.
 *
 * Plain REST (like Pluto, NOT tRPC like Silver), all under
 *   https://experts.afterquery.com/api/projects/fenrir/…
 * with the shared Firebase `Authorization: Bearer <token>` header.
 *
 * Data model: one SUBMISSION (a repo) contains zero or more FINDINGS (crashes).
 * Finding id format is `<submissionId>:<index>` (e.g. "eCvplNtx…:0").
 */

import { normalizeToken } from "@/lib/afterquery";

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";
const PROJECT = process.env.FENRIR_PROJECT || "fenrir";

export class FenrirError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "FenrirError";
    this.status = status;
    this.detail = detail;
  }
}

async function call<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  token: string,
  path: string,
  body?: unknown
): Promise<T> {
  const t = normalizeToken(token);
  if (!t) throw new FenrirError("Missing auth token.");
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/projects/${PROJECT}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    throw new FenrirError(`Network error calling ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const o = json as Record<string, unknown>;
    throw new FenrirError(
      (o?.error as string) || (o?.message as string) || `${path} HTTP ${res.status}`,
      res.status,
      json
    );
  }
  return json as T;
}

// ── Types (from live-captured payloads) ─────────────────────────────────────

export interface FenrirFuzzResult {
  crash?: boolean;
  harnessName?: string;
  language?: string;
  durationSec?: number;
  generatedDescription?: string;
  pocStoragePath?: string;
  pocSha256?: string;
  sanitizerOutput?: string;
}

export interface FenrirSubmission {
  id: string;
  userId?: string;
  userEmail?: string;
  fileName?: string;
  storagePath?: string;
  language?: string;
  harnessName?: string;
  intakeChoice?: string; // "auto_fuzz" | "submit_poc"
  source?: string; // "github_url"
  repoUrl?: string;
  repoOwner?: string;
  repoName?: string;
  commitSha?: string;
  repoVisibility?: string;
  submittedAt?: string;
  rejectionCount?: number;
  currentlyUnderReview?: boolean;
  dispatchedAt?: string;
  attempts?: number;
  fuzzPhase?: string; // "triaging" | …
  fuzzPhaseAt?: string;
  phase?: string; // "running" | "blocked" | "terminal"
  fuzzResult?: FenrirFuzzResult | null;
  step?: string;
  pipelineStage?: string; // "initial_fuzzing_pending" | "findings_ready" | "failed" | "rejected"
  status?: string; // "Verifying" | "Action Required" | "Failed" | "Rejected"
  updatedAt?: string;
  [k: string]: unknown;
}

export interface FenrirCrash {
  pocStoragePath?: string;
  pocSha256?: string;
  sanitizerOutput?: string;
  crashFrames?: unknown[];
  generatedDescription?: string;
}

export interface FenrirFinding {
  id: string; // "<submissionId>:<index>"
  submissionId?: string;
  userId?: string;
  repoStoragePath?: string;
  language?: string;
  harnessName?: string;
  status?: string; // "Action Required" | "Verifying" | "Approved" | "Rejected" | "Failed"
  phase?: string; // "running" | "blocked" | "terminal"
  pipelineStage?: string; // "awaiting_patch" | "patch_submitted" | "approved" | "rejected" | …
  step?: string; // "verify" | …
  awaitingSince?: string;
  primary?: boolean;
  authoritative?: boolean;
  createdAt?: string;
  updatedAt?: string;
  rejectionCount?: number;
  // Rejection feedback (field name varies; we read several defensively).
  rejectionReason?: string | null;
  rejectReason?: string | null;
  reason?: string | null;
  feedback?: string | null;
  reviewFeedback?: string | null;
  whatToDo?: string | null;
  description?: string | null; // contributor-authored; may be absent (use crash.generatedDescription)
  descriptionApproved?: boolean | null;
  crash?: FenrirCrash;
  patch?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface FenrirSubmissionDetail {
  submission: FenrirSubmission;
  findings: FenrirFinding[];
}

// ── Read endpoints ──────────────────────────────────────────────────────────

/** GET /submissions → list of the user's submissions (repos). */
export async function listSubmissions(token: string): Promise<FenrirSubmission[]> {
  const out = await call<{ submissions?: FenrirSubmission[] }>(
    "GET",
    token,
    "submissions"
  );
  return Array.isArray(out?.submissions) ? out.submissions : [];
}

/** GET /submissions/{id} → one submission expanded plus its findings. */
export async function getSubmission(
  token: string,
  submissionId: string
): Promise<FenrirSubmissionDetail> {
  const out = await call<Partial<FenrirSubmissionDetail>>(
    "GET",
    token,
    `submissions/${encodeURIComponent(submissionId)}`
  );
  return {
    submission: (out?.submission ?? { id: submissionId }) as FenrirSubmission,
    findings: Array.isArray(out?.findings) ? out.findings : [],
  };
}

export interface FenrirProfile {
  userId?: string;
  email?: string;
  isAdmin?: boolean;
  isReviewer?: boolean;
  isOperations?: boolean;
  contributorPocEnabled?: boolean;
}

/** GET /users/me → contributor profile. */
export async function getProfile(token: string): Promise<FenrirProfile> {
  return call<FenrirProfile>("GET", token, "users/me");
}

/** GET /users/me/stats → e.g. { inBandApprovedTasks }. */
export async function getStats(token: string): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>("GET", token, "users/me/stats");
}

export interface FenrirGithubConnection {
  connected: boolean;
  githubLogin?: string;
  scopes?: string[];
  connectedAt?: { _seconds: number; _nanoseconds: number };
}

/** GET /github/connection → GitHub link status. */
export async function getGithubConnection(token: string): Promise<FenrirGithubConnection> {
  return call<FenrirGithubConnection>("GET", token, "github/connection");
}

// ── Lifecycle / manage actions ───────────────────────────────────────────────

/** DELETE /submissions/{id}. */
export async function deleteSubmission(token: string, submissionId: string): Promise<unknown> {
  return call("DELETE", token, `submissions/${encodeURIComponent(submissionId)}`);
}

/** POST /submissions/{id}/revise — re-point a rejected submission at a new ref. */
export async function reviseSubmission(
  token: string,
  submissionId: string,
  body: { repoUrl?: string; ref?: string }
): Promise<unknown> {
  return call("POST", token, `submissions/${encodeURIComponent(submissionId)}/revise`, body);
}

/** DELETE /findings/{id}. */
export async function deleteFinding(token: string, findingId: string): Promise<unknown> {
  return call("DELETE", token, `findings/${encodeURIComponent(findingId)}`);
}

/** POST /findings/{id}/revise — update the contributor-authored description. */
export async function reviseFinding(
  token: string,
  findingId: string,
  description: string
): Promise<unknown> {
  return call("POST", token, `findings/${encodeURIComponent(findingId)}/revise`, {
    description,
  });
}

/** POST /findings/{id}/re-probe — re-run the GPT-5.5 difficulty check. */
export async function reProbeFinding(token: string, findingId: string): Promise<unknown> {
  return call("POST", token, `findings/${encodeURIComponent(findingId)}/re-probe`);
}

/** POST /findings/{id}/revise {kind:"patch"} — reopen a needs-revision / rejected
 *  finding so a fresh patch can be submitted. Required before a re-submission. */
export async function reviseFindingPatch(token: string, findingId: string): Promise<unknown> {
  return call("POST", token, `findings/${encodeURIComponent(findingId)}/revise`, {
    kind: "patch",
  });
}

// ── Write / intake endpoints ─────────────────────────────────────────────────

/** POST /submit-url — submit a private GitHub repo for fuzzing.
 *  intakeChoice: "auto_fuzz" (just fuzz) | "submit_poc" (fuzz + bring your own PoC). */
export async function submitUrl(
  token: string,
  body: { repoUrl: string; ref?: string; intakeChoice?: string }
): Promise<{ submission: FenrirSubmission }> {
  const payload: Record<string, unknown> = { repoUrl: body.repoUrl };
  if (body.ref?.trim()) payload.ref = body.ref.trim();
  if (body.intakeChoice) payload.intakeChoice = body.intakeChoice;
  return call<{ submission: FenrirSubmission }>("POST", token, "submit-url", payload);
}

/** POST /submit-poc — attach a base64-encoded crashing input to a submission. */
export async function submitPoc(
  token: string,
  submissionId: string,
  pocBase64: string
): Promise<{ submission: FenrirSubmission }> {
  return call<{ submission: FenrirSubmission }>("POST", token, "submit-poc", {
    submissionId,
    pocBase64,
  });
}

/** POST /submit-patch — submit a unified-diff patch for one finding, together
 *  with the required task description. */
export async function submitPatch(
  token: string,
  body: {
    submissionId: string;
    findingId: string;
    patchText: string;
    patchFileName: string;
    description?: string;
  }
): Promise<{ finding: FenrirFinding }> {
  return call<{ finding: FenrirFinding }>("POST", token, "submit-patch", body);
}

export interface FenrirUploadUrl {
  uploadUrl: string;
  rawStoragePath: string;
  contentType: string;
}

/** POST /get-upload-url — signed GCS PUT URL (for the ZIP-upload intake path). */
export async function getUploadUrl(
  token: string,
  fileName: string,
  contentType = "application/zip"
): Promise<FenrirUploadUrl> {
  return call<FenrirUploadUrl>("POST", token, "get-upload-url", { fileName, contentType });
}
