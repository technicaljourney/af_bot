import path from "path";
import { normalizeToken } from "@/lib/afterquery";

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";

/** Resolve the Gold project folder. Set GOLD_DIR in .env.local (absolute path).
 *  Falls back to the parent of the app root (…/gold) when unset. */
export function getGoldDir(): string {
  const d = process.env.GOLD_DIR;
  if (d && d.trim()) return d.trim();
  // cwd is the app root (bot_o) under `next`; its parent is …/gold/bot, so go up two.
  return path.resolve(process.cwd(), "..", "..");
}

export class GoldError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "GoldError";
    this.status = status;
    this.detail = detail;
  }
}

/** Pull the user-facing message out of a batched tRPC error response. */
function extractTrpcError(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    const err = (entry as { error?: { json?: Record<string, unknown> } })?.error?.json;
    if (err && typeof err.message === "string") return err.message;
  }
  return null;
}

/**
 * Connect a GitHub repo to the Gold project.
 *
 * Mirrors the browser call:
 *   POST /api/gold-trpc/gold.repos.connectRepo?batch=1
 *   body: {"0":{"json":{"repoUrl":"…","ref":null},"meta":{"values":{"ref":["undefined"]},"v":1}}}
 *
 * Note the Gold tRPC base is `/api/gold-trpc/` (Silver uses `/api/trpc/`).
 */
export async function connectRepo(token: string, repoUrl: string): Promise<unknown> {
  const t = normalizeToken(token);
  if (!t) throw new GoldError("Missing auth token.");
  if (!repoUrl?.trim()) throw new GoldError("Missing repoUrl.");

  const url = `${BASE}/api/gold-trpc/gold.repos.connectRepo?batch=1`;
  const body = JSON.stringify({
    "0": {
      json: { repoUrl: repoUrl.trim(), ref: null },
      meta: { values: { ref: ["undefined"] }, v: 1 },
    },
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "*/*",
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    throw new GoldError(`Network error calling connectRepo: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new GoldError(
      extractTrpcError(parsed) || `connectRepo HTTP ${res.status}`,
      res.status,
      parsed
    );
  }
  // tRPC batch success: [{ result: { data: { json: <payload> } } }]
  const arr = parsed as Array<{ result?: { data?: { json?: unknown } } }> | null;
  return arr?.[0]?.result?.data?.json ?? parsed;
}

export interface GoldEnvironment {
  baseSha: string;
  status: string; // "building" | "published" | …
  version?: number;
  imageRef?: string; // build.imageRef → task.toml docker_image
}

export interface ConnectedRepo {
  id?: string;
  repoUrl: string;
  repoOwner?: string;
  repoName?: string;
  status?: string;
  language?: string; // repo language → task.toml metadata.language
  environmentCount: number;
  /** Each environment's baseSha + status — used to tell whether a task's
   *  base_commit already has an environment and whether it is published. */
  environments: GoldEnvironment[];
}

/**
 * List the repos already connected to the Gold project.
 *   GET /api/gold-trpc/gold.repos.list?batch=1&input=<no-input tRPC>
 */
export async function listConnectedRepos(token: string): Promise<ConnectedRepo[]> {
  const t = normalizeToken(token);
  if (!t) throw new GoldError("Missing auth token.");

  const input = { "0": { json: null, meta: { values: ["undefined"], v: 1 } } };
  const url = `${BASE}/api/gold-trpc/gold.repos.list?batch=1&input=${encodeURIComponent(
    JSON.stringify(input)
  )}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${t}`, Accept: "*/*" },
      cache: "no-store",
    });
  } catch (e) {
    throw new GoldError(`Network error calling gold.repos.list: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new GoldError(
      extractTrpcError(parsed) || `gold.repos.list HTTP ${res.status}`,
      res.status,
      parsed
    );
  }

  const listArr = parsed as Array<{ result?: { data?: { json?: unknown } } }> | null;
  const list = listArr?.[0]?.result?.data?.json;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .map((r) => {
      const envs = Array.isArray(r.environments)
        ? (r.environments as Array<Record<string, unknown>>)
        : [];
      const environments: GoldEnvironment[] = envs
        .map((e) => ({
          baseSha: typeof e?.baseSha === "string" ? e.baseSha : "",
          status: typeof e?.status === "string" ? e.status : "",
          version: typeof e?.version === "number" ? e.version : undefined,
          imageRef:
            e?.build && typeof (e.build as Record<string, unknown>).imageRef === "string"
              ? ((e.build as Record<string, unknown>).imageRef as string)
              : undefined,
        }))
        .filter((e) => e.baseSha);
      return {
        id: typeof r.id === "string" ? r.id : undefined,
        repoUrl: typeof r.repoUrl === "string" ? r.repoUrl : "",
        repoOwner: typeof r.repoOwner === "string" ? r.repoOwner : undefined,
        repoName: typeof r.repoName === "string" ? r.repoName : undefined,
        status: typeof r.status === "string" ? r.status : undefined,
        language: typeof r.language === "string" ? r.language : undefined,
        environmentCount: envs.length,
        environments,
      };
    })
    .filter((r) => r.repoUrl);
}

/** Shared POST helper for Gold tRPC mutations at the /api/gold-trpc/ base. */
async function goldTrpcPost(token: string, procedure: string, input: unknown): Promise<unknown> {
  const t = normalizeToken(token);
  if (!t) throw new GoldError("Missing auth token.");
  const url = `${BASE}/api/gold-trpc/${procedure}?batch=1`;
  const body = JSON.stringify({ "0": { json: input } });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "*/*",
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    throw new GoldError(`Network error calling ${procedure}: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new GoldError(
      extractTrpcError(parsed) || `${procedure} HTTP ${res.status}`,
      res.status,
      parsed
    );
  }
  const arr = parsed as Array<{ result?: { data?: { json?: unknown } } }> | null;
  return arr?.[0]?.result?.data?.json ?? parsed;
}

/**
 * Submit a Dockerfile to create/build an environment for a repo's base commit.
 *   POST /api/gold-trpc/gold.repos.environments.submitDockerfile
 *   body: { repoId, baseSha, dockerfile }
 * The environment then builds asynchronously; poll listConnectedRepos and watch
 * the matching environment's status flip to "published".
 */
export async function submitDockerfile(
  token: string,
  repoId: string,
  baseSha: string,
  dockerfile: string
): Promise<unknown> {
  if (!repoId) throw new GoldError("Missing repoId.");
  if (!baseSha) throw new GoldError("Missing baseSha.");
  if (!dockerfile?.trim()) throw new GoldError("Missing dockerfile.");
  return goldTrpcPost(token, "gold.repos.environments.submitDockerfile", {
    repoId,
    baseSha,
    dockerfile,
  });
}

/**
 * Create a new task against a published environment.
 *   POST /api/gold-trpc/gold.tasks.create
 *   body: { repoId, environmentVersion, taskName, category }
 * `category` must be the enum form, e.g. "feature_request" / "bug_fix" / "enhancement".
 */
export async function createTask(
  token: string,
  params: { repoId: string; environmentVersion: number; taskName: string; category: string }
): Promise<unknown> {
  if (!params.repoId) throw new GoldError("Missing repoId.");
  if (!params.taskName) throw new GoldError("Missing taskName.");
  if (typeof params.environmentVersion !== "number") {
    throw new GoldError("Missing environmentVersion.");
  }
  return goldTrpcPost(token, "gold.tasks.create", {
    repoId: params.repoId,
    environmentVersion: params.environmentVersion,
    taskName: params.taskName,
    category: params.category,
  });
}

export interface PipelineStep {
  key: string;
  label: string;
  status: "passed" | "running" | "failed" | "pending" | string;
}

/** The 8 validation-pipeline steps, in order, mapped to pipeline object keys. */
export const GOLD_STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: "ciChecks", label: "Automated checks" },
  { key: "aiCheck", label: "AI check" },
  { key: "similarity", label: "Originality" },
  { key: "oracleNop", label: "Reference verification" },
  { key: "qualityCheck", label: "Quality review" },
  { key: "easinessProbe", label: "Calibration I" },
  { key: "difficultyProbe", label: "Calibration II" },
  { key: "failureValidation", label: "Run audit" },
];

/** Derive the 8 ordered steps + their status from a task's `pipeline` object. */
export function pipelineSteps(pipeline: unknown): PipelineStep[] {
  const p = (pipeline && typeof pipeline === "object" ? pipeline : {}) as Record<string, unknown>;
  return GOLD_STEP_DEFS.map(({ key, label }) => {
    const v = p[key];
    let status = "pending";
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).status === "string") {
      status = (v as Record<string, unknown>).status as string;
    }
    return { key, label, status };
  });
}

export interface GoldMessage {
  scope: string; // "Overall" or a step label
  level: string; // "error" | "warning" | "info" | …
  message: string;
  code?: string;
  path?: string;
}

/** Collect every error/warning message from a task's pipeline: the top-level
 *  failure (total) plus each stage's findings / error / judge reasons. */
export function collectPipelineMessages(pipeline: unknown): GoldMessage[] {
  const p = (pipeline && typeof pipeline === "object" ? pipeline : {}) as Record<string, unknown>;
  const out: GoldMessage[] = [];

  const failureReason = typeof p.failureReason === "string" ? p.failureReason : "";
  const failureKind = typeof p.failureKind === "string" ? p.failureKind : "";
  if (failureReason) {
    out.push({
      scope: "Overall",
      level: "error",
      message: failureKind ? `${failureKind}: ${failureReason}` : failureReason,
    });
  }

  for (const { key, label } of GOLD_STEP_DEFS) {
    const st = p[key];
    if (!st || typeof st !== "object") continue;
    const s = st as Record<string, unknown>;

    if (Array.isArray(s.findings)) {
      for (const f of s.findings) {
        if (f && typeof f === "object") {
          const fo = f as Record<string, unknown>;
          if (typeof fo.message === "string" && fo.message) {
            out.push({
              scope: label,
              level: typeof fo.level === "string" ? fo.level : "info",
              message: fo.message,
              code: typeof fo.code === "string" ? fo.code : undefined,
              path: typeof fo.path === "string" ? fo.path : undefined,
            });
          }
        }
      }
    }
    if (typeof s.error === "string" && s.error) {
      out.push({ scope: label, level: "error", message: s.error });
    }
    // Quality-review style rubric: criteria[] with outcome/explanation/blocking.
    if (Array.isArray(s.criteria)) {
      for (const c of s.criteria) {
        if (c && typeof c === "object") {
          const co = c as Record<string, unknown>;
          const outcome = typeof co.outcome === "string" ? co.outcome : "";
          if (outcome && outcome !== "pass") {
            const name =
              typeof co.name === "string" ? co.name.replace(/_/g, " ") : "criterion";
            const explanation = typeof co.explanation === "string" ? co.explanation : "";
            out.push({
              scope: label,
              level: co.blocking ? "error" : "warning",
              message: `${name} (${outcome})${explanation ? `: ${explanation}` : ""}`,
            });
          }
        }
      }
    }
    const judge = s.judge as Record<string, unknown> | undefined;
    if (judge && Array.isArray(judge.reasons)) {
      const verdict = typeof judge.verdict === "string" ? judge.verdict : "";
      if (verdict && verdict !== "clean") {
        for (const r of judge.reasons) {
          if (typeof r === "string" && r) out.push({ scope: label, level: "warning", message: r });
        }
      }
    }
  }
  return out;
}

export interface MyTask {
  id?: string;
  taskName: string;
  repoId: string;
  baseSha?: string;
  category?: string;
  status?: string;
  environmentVersion?: number;
  steps: PipelineStep[];
  /** pipeline.completedAt is set → the run finished. */
  pipelineDone: boolean;
  failedStage: string | null;
  messages: GoldMessage[];
}

/** List the current user's Gold tasks (gold.tasks.listMine). */
export async function listMyTasks(token: string): Promise<MyTask[]> {
  const t = normalizeToken(token);
  if (!t) throw new GoldError("Missing auth token.");
  const input = { "0": { json: null, meta: { values: ["undefined"], v: 1 } } };
  const url = `${BASE}/api/gold-trpc/gold.tasks.listMine?batch=1&input=${encodeURIComponent(
    JSON.stringify(input)
  )}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${t}`, Accept: "*/*" },
      cache: "no-store",
    });
  } catch (e) {
    throw new GoldError(`Network error calling gold.tasks.listMine: ${(e as Error).message}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new GoldError(
      extractTrpcError(parsed) || `gold.tasks.listMine HTTP ${res.status}`,
      res.status,
      parsed
    );
  }
  const arr = parsed as Array<{ result?: { data?: { json?: unknown } } }> | null;
  const list = arr?.[0]?.result?.data?.json;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .map((r) => {
      const pipeline = r.pipeline as Record<string, unknown> | undefined;
      return {
        id: typeof r.id === "string" ? r.id : undefined,
        taskName: typeof r.taskName === "string" ? r.taskName : "",
        repoId: typeof r.repoId === "string" ? r.repoId : "",
        baseSha: typeof r.baseSha === "string" ? r.baseSha : undefined,
        category: typeof r.category === "string" ? r.category : undefined,
        status: typeof r.status === "string" ? r.status : undefined,
        environmentVersion:
          typeof r.environmentVersion === "number" ? r.environmentVersion : undefined,
        steps: pipelineSteps(pipeline),
        pipelineDone: Boolean(pipeline && pipeline.completedAt),
        failedStage:
          pipeline && typeof pipeline.failedStage === "string" ? pipeline.failedStage : null,
        messages: collectPipelineMessages(pipeline),
      };
    })
    .filter((r) => r.taskName);
}

/** Save a task's files (gold.tasks.save). files = { "<relpath>": "<content>" }. */
export async function saveTask(
  token: string,
  submissionId: string,
  files: Record<string, string>
): Promise<unknown> {
  if (!submissionId) throw new GoldError("Missing submissionId.");
  return goldTrpcPost(token, "gold.tasks.save", { submissionId, files });
}

/** Submit a task for validation (gold.tasks.submit). */
export async function submitTaskForValidation(
  token: string,
  submissionId: string
): Promise<unknown> {
  if (!submissionId) throw new GoldError("Missing submissionId.");
  return goldTrpcPost(token, "gold.tasks.submit", { submissionId });
}

/** Archive (delete) a task (gold.tasks.archive). */
export async function archiveTask(token: string, submissionId: string): Promise<unknown> {
  if (!submissionId) throw new GoldError("Missing submissionId.");
  return goldTrpcPost(token, "gold.tasks.archive", { submissionId });
}
