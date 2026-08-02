import { promises as fs } from "fs";
import path from "path";
import { getSilverTaskDir } from "@/lib/silverDir";

/**
 * LOCAL task tracker — `<silverDir>/task-stats.json`. Pure local data: rows
 * are created/updated by the bot's own lifecycle events, never reconstructed
 * from AfterQuery.
 *
 * Lifecycle:
 *   - task created  → the folder scan registers the task name (createdAt).
 *   - task submitted → `submitted` increments (manual + auto submits both
 *     pass through /api/silver/submit).
 *   - submission failed at pipeline step 7 → `failedStep7` increments;
 *     step 8 → `failedStep8`; any other step → `failedOtherSteps[<stage>]`.
 *   - user fixes the task and resubmits → same counters keep accumulating
 *     under the same task name, for as long as the task exists.
 *
 *   {
 *     "tasks": {
 *       "verba-aggregations": {
 *         "createdAt": "2026-06-10T12:00:00.000Z",
 *         "submitted": 3,
 *         "lastSubmittedAt": "2026-06-10T14:10:00.000Z",
 *         "failedStep7": 2,
 *         "failedStep8": 1,
 *         "failedOtherSteps": { "rubricReview": 1 }
 *       }
 *     },
 *     "countedSubmits": { "<submissionId>": "verba-aggregations" },
 *     "countedFailures": { "<submissionId>": "easinessProbe" }
 *   }
 *
 * All updates arrive via the bot UI's own local stats endpoints
 * (/api/silver/stats/*) — the AfterQuery-facing routes are NOT involved in
 * stats bookkeeping.
 *
 * `countedFailures` dedupes by submissionId so one failed submission counts
 * exactly once, no matter how many ticks/reloads re-observe it.
 *
 * Steps mirror lib/silverPipeline.ts SILVER_STAGE_DEFS order:
 *   1 similarity · 2 gptZeroCheck · 3 rubricReview · 4 taskImageBuild ·
 *   5 oracleCheck · 6 nullCheck · 7 easinessProbe · 8 difficultyProbe ·
 *   9 fairnessReview
 *
 * Storage is JSON (not sqlite) on purpose: the volume is a handful of tasks
 * with a few counters, writes are serialized in-process, and a plain file
 * stays human-readable and hand-editable.
 */
export const STEP_BY_STAGE: Record<string, number> = {
  similarity: 1,
  gptZeroCheck: 2,
  rubricReview: 3,
  taskImageBuild: 4,
  oracleCheck: 5,
  nullCheck: 6,
  easinessProbe: 7,
  difficultyProbe: 8,
  fairnessReview: 9,
};

export interface TaskStats {
  /** When the task folder was first seen locally. */
  createdAt: string;
  /** Times this task was successfully submitted (initial + resubmits). */
  submitted: number;
  lastSubmittedAt: string | null;
  /** Failures at step 7 — easinessProbe (Easiness Prefilter). */
  failedStep7: number;
  /** Failures at step 8 — difficultyProbe (Difficulty Probe). */
  failedStep8: number;
  /** Failures at every other step, keyed by stage name. */
  failedOtherSteps: Record<string, number>;
}

export interface SilverStatsFile {
  tasks: Record<string, TaskStats>;
  /** submissionId → taskName already counted as a submit. */
  countedSubmits: Record<string, string>;
  /** submissionId → failedStage already counted. */
  countedFailures: Record<string, string>;
}

function statsPath(): string {
  return path.join(getSilverTaskDir(), "task-stats.json");
}

// Serialize all read-modify-write cycles within this server process.
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<SilverStatsFile> {
  try {
    const raw = await fs.readFile(statsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SilverStatsFile>;
    return {
      tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
      countedSubmits:
        parsed.countedSubmits && typeof parsed.countedSubmits === "object"
          ? parsed.countedSubmits
          : {},
      countedFailures:
        parsed.countedFailures && typeof parsed.countedFailures === "object"
          ? parsed.countedFailures
          : {},
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { tasks: {}, countedSubmits: {}, countedFailures: {} };
    }
    // Corrupt file: surface loudly rather than silently resetting counters.
    throw new Error(`task-stats.json: ${(e as Error).message}`);
  }
}

async function save(stats: SilverStatsFile): Promise<void> {
  await fs.writeFile(statsPath(), JSON.stringify(stats, null, 2), "utf8");
}

function taskEntry(stats: SilverStatsFile, taskName: string): TaskStats {
  let t = stats.tasks[taskName];
  if (!t) {
    t = {
      createdAt: new Date().toISOString(),
      submitted: 0,
      lastSubmittedAt: null,
      failedStep7: 0,
      failedStep8: 0,
      failedOtherSteps: {},
    };
    stats.tasks[taskName] = t;
  }
  return t;
}

/** Read-only snapshot (no lock — a torn read can only lag by one write). */
export async function readStats(): Promise<SilverStatsFile> {
  return load();
}

/** Register newly-created tasks: any name not yet in the store gets a row
 *  with createdAt = now. Called from the folder scan; no-op (and no write)
 *  when every name is already known. Never throws. */
export async function registerTasks(taskNames: string[]): Promise<void> {
  try {
    await withLock(async () => {
      const stats = await load();
      const missing = taskNames.filter((n) => !stats.tasks[n]);
      if (missing.length === 0) return;
      for (const n of missing) taskEntry(stats, n);
      await save(stats);
    });
  } catch (e) {
    console.warn("silver stats registerTasks failed:", (e as Error).message);
  }
}

/** Increment the submit counter for a task (initial submit and every
 *  resubmit after a fix). Deduped by submissionId so a repeated report of
 *  the same submission never double-counts. Returns whether this call
 *  actually counted. */
export async function recordSubmit(
  taskName: string,
  submissionId: string
): Promise<{ counted: boolean }> {
  return withLock(async () => {
    const stats = await load();
    if (stats.countedSubmits[submissionId]) return { counted: false };
    stats.countedSubmits[submissionId] = taskName;
    const t = taskEntry(stats, taskName);
    t.submitted += 1;
    t.lastSubmittedAt = new Date().toISOString();
    await save(stats);
    return { counted: true };
  });
}

/** Count one pipeline failure for `taskName` at `failedStage`, deduped by
 *  submissionId. Steps 7 and 8 land in their dedicated counters; every
 *  other step goes to failedOtherSteps[<stage>]. Returns whether this call
 *  actually counted, plus the resolved step number (null for unknown
 *  stage names). */
export async function recordStageFailure(
  taskName: string,
  submissionId: string,
  failedStage: string
): Promise<{ counted: boolean; step: number | null }> {
  const step = STEP_BY_STAGE[failedStage] ?? null;
  return withLock(async () => {
    const stats = await load();
    if (stats.countedFailures[submissionId]) return { counted: false, step };
    stats.countedFailures[submissionId] = failedStage;
    const t = taskEntry(stats, taskName);
    if (step === 7) t.failedStep7 += 1;
    else if (step === 8) t.failedStep8 += 1;
    else t.failedOtherSteps[failedStage] = (t.failedOtherSteps[failedStage] || 0) + 1;
    await save(stats);
    return { counted: true, step };
  });
}
