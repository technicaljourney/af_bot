import { promises as fs } from "fs";
import path from "path";
import { parse as parseToml } from "smol-toml";
import { getSilverTaskDir } from "@/lib/silverDir";
import {
  normalizeSolveTime,
  normalizeRepoType,
  normalizeTaskType,
} from "@/lib/silverTaskList";

/**
 * Per-task metadata from `<silverDir>/<taskName>/task.toml`.
 *
 * The user's workflow: every subfolder of the silver dir that contains a
 * `task.toml` is a task that's ready to submit — the toml plays the role the
 * old `<taskName>.json` sidecar (and before that task_list.md) played:
 *
 *   [metadata]
 *   repo_type = "dev-tooling"
 *   task_type = "feature"
 *   human_solve_time = "2h"
 *   # optional extras honored when present:
 *   # status = "Failed"      → blocks auto-retries
 *   # repo = "verba"         → repoId hint
 *
 *   [environment]
 *   allow_internet = true    → requiresInternet
 *
 * Folders without a task.toml (work dirs, __pycache__, jobs/…) are ignored.
 *
 * Feedback JSONs (written by the auto-handler after a failed pipeline) live
 * at `<silverDir>/<taskName>.feedback.json` — sibling FILES of the task
 * folders, so they survive folder revisions and can't be uploaded by the
 * folder walk.
 */
export interface SilverTaskMeta {
  taskName: string;
  estimatedSolveTime: string | null;
  taskType: string | null;
  repoType: string | null;
  /** From `[environment] allow_internet`. Null when absent. */
  requiresInternet: boolean | null;
  /** Optional `[metadata] status` — e.g. "Failed", "Hold". Null = ready. */
  status: string | null;
  /** Optional `[metadata] repo` — repo-name hint for repoId resolution. */
  repo: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseTaskToml(raw: string, taskName: string): SilverTaskMeta {
  const doc = parseToml(raw) as Record<string, unknown>;
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const environment = (doc.environment ?? {}) as Record<string, unknown>;
  const allowInternet = environment.allow_internet;
  return {
    taskName,
    estimatedSolveTime: str(metadata.human_solve_time),
    taskType: str(metadata.task_type) ?? str(metadata.category),
    repoType: str(metadata.repo_type),
    requiresInternet:
      typeof allowInternet === "boolean" ? allowInternet : null,
    status: str(metadata.status),
    repo: str(metadata.repo),
  };
}

/** Read `<silverDir>/<taskName>/task.toml` — null when the file doesn't
 *  exist (the folder isn't a task). Throws on unparseable content so callers
 *  can surface the broken file instead of silently skipping the task. */
export async function readTaskMeta(taskName: string): Promise<SilverTaskMeta | null> {
  const p = taskTomlPath(taskName);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return parseTaskToml(raw, taskName);
  } catch (e) {
    throw new Error(`${taskName}/task.toml: ${(e as Error).message}`);
  }
}

export function taskTomlPath(taskName: string): string {
  return path.join(getSilverTaskDir(), taskName, "task.toml");
}

/** Auto-handler feedback file — its presence means "already handled, don't
 *  re-submit until the user revises the task and deletes this file". */
export function feedbackJsonPath(taskName: string): string {
  return path.join(getSilverTaskDir(), `${taskName}.feedback.json`);
}

/** A task may be auto-submitted unless its optional status says otherwise.
 *  Missing status counts as ready (task.toml's presence is the signal);
 *  "Ready"/"Pending" are submittable; anything else blocks. */
export function isReadyStatus(status: string | null): boolean {
  if (!status) return true;
  const s = status.trim().toLowerCase();
  return s === "ready" || s === "pending";
}

/** "Failed" (human reviewer verdict) — never auto-retry. */
export function isFailedStatus(status: string | null): boolean {
  return /fail/i.test(status || "");
}

/** Normalized enum bundle for the submit endpoint. */
export function normalizedMeta(meta: SilverTaskMeta) {
  return {
    humanSolveTime: normalizeSolveTime(meta.estimatedSolveTime),
    repoType: normalizeRepoType(meta.repoType),
    taskType: normalizeTaskType(meta.taskType),
    requiresInternet: meta.requiresInternet,
  };
}

/**
 * The canonical scaffold — the ONLY paths the submit route uploads:
 *   top-level files: task.toml, instruction.md, reference_plan.md
 *   directories (recursive): environment/, solution/, tests/
 * Everything else in the folder (dossier.md, *.pre-humanize*.md, *.bak,
 * drafts, logs) is authoring material that must never reach AfterQuery.
 * Mirrors exactly what the user's hand-curated task zips contained.
 */
const SCAFFOLD_FILES = new Set(["task.toml", "instruction.md", "reference_plan.md"]);
const SCAFFOLD_DIRS = new Set(["environment", "solution", "tests"]);

export function isScaffoldPath(relPath: string): boolean {
  const top = relPath.split("/")[0];
  if (relPath.includes("/")) return SCAFFOLD_DIRS.has(top);
  return SCAFFOLD_FILES.has(top);
}
