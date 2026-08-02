import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getSilverTaskDir } from "@/lib/silverDir";
import {
  readTaskMeta,
  feedbackJsonPath,
  isReadyStatus,
  isFailedStatus,
  isScaffoldPath,
  SilverTaskMeta,
} from "@/lib/silverTaskMeta";
import { readStats, registerTasks, SilverStatsFile } from "@/lib/silverStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the task folders waiting in `<silverDir>/`.
 *
 * A task appears here when `<silverDir>/<taskName>/task.toml` exists — the
 * toml is the "this task is ready" marker AND carries the submission
 * metadata (solve time / task type / repo type / internet) — see
 * lib/silverTaskMeta.ts. Folders without a task.toml are ignored.
 *
 * `<taskName>.feedback.json` (a sibling file) is the auto-handler's
 * "already handled" marker (`hasFeedback: true`).
 *
 * Response field `zips` is kept for back-compat with the Silver UI; entries
 * describe folders. `fileName` is the folder name. `fileCount`/`sizeBytes`
 * count only the scaffold files the submit route would upload.
 */
interface TaskRow {
  fileName: string; // folder name — kept as `fileName` for UI back-compat
  taskName: string;
  sizeBytes: number;
  fileCount: number;
  createdMs: number;
  /** task.toml parsed OK. False only for broken/unreadable tomls. */
  hasMeta: boolean;
  /** hasMeta && optional status is submittable ("Ready"/"Pending"/absent). */
  ready: boolean;
  /** `<taskName>.feedback.json` exists — already handled, don't re-submit. */
  hasFeedback: boolean;
  estimatedSolveTime: string | null;
  taskType: string | null;
  repoType: string | null;
  requiresInternet: boolean | null;
  /** Optional repo-name hint from task.toml. */
  repo: string | null;
  /** task.toml has a status that blocks submission (and isn't "Failed"). */
  doNotSubmit: boolean;
  note: string | null;
  /** Raw optional status from task.toml (e.g. "Failed", "Hold"). */
  status: string | null;
  /** status === Failed — human verdict; auto-handler must not retry. */
  failed: boolean;
  /** Lifetime successful submits (from the local task-stats.json). */
  submitCount: number;
  /** Pipeline failures at step 7 — easinessProbe. */
  failedStep7: number;
  /** Pipeline failures at step 8 — difficultyProbe. */
  failedStep8: number;
  /** Failures at every other step, keyed by stage name. */
  failedOtherSteps: Record<string, number>;
}

/** Size + count of the scaffold files only (what submit would upload). */
async function scaffoldStats(
  abs: string
): Promise<{ sizeBytes: number; fileCount: number; mtimeMs: number }> {
  let sizeBytes = 0;
  let fileCount = 0;
  let mtimeMs = 0;
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(abs, rel || "."), {
      withFileTypes: true,
    });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isScaffoldPath(`${childRel}/x`)) await walk(childRel);
      } else if (e.isFile() && isScaffoldPath(childRel)) {
        const st = await fs.stat(path.join(abs, childRel));
        sizeBytes += st.size;
        fileCount += 1;
        if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
      }
    }
  }
  await walk("");
  return { sizeBytes, fileCount, mtimeMs };
}

export async function GET() {
  const dir = getSilverTaskDir();
  try {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({
          ok: true,
          dir,
          count: 0,
          zips: [],
          managedNames: [],
        });
      }
      throw e;
    }

    let statsFile: SilverStatsFile = {
      tasks: {},
      countedSubmits: {},
      countedFailures: {},
    };
    try {
      statsFile = await readStats();
    } catch (err) {
      console.warn("silver stats read failed:", (err as Error).message);
    }

    const rows: TaskRow[] = [];
    const brokenTomls: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      const taskName = e.name;
      const abs = path.join(dir, taskName);

      // task.toml is the task marker — folders without one (work dirs,
      // __pycache__, jobs/…) are not tasks.
      let meta: SilverTaskMeta | null = null;
      let metaBroken = false;
      try {
        meta = await readTaskMeta(taskName);
      } catch (err) {
        metaBroken = true;
        brokenTomls.push((err as Error).message);
      }
      if (!meta && !metaBroken) continue;

      let stats: { sizeBytes: number; fileCount: number; mtimeMs: number };
      try {
        stats = await scaffoldStats(abs);
      } catch {
        continue; // unreadable folder — skip
      }

      const hasFeedback = await fileExists(feedbackJsonPath(taskName));
      const failed = meta ? isFailedStatus(meta.status) : false;
      const ready = Boolean(meta) && isReadyStatus(meta!.status);
      const doNotSubmit = Boolean(meta) && !ready && !failed;
      const taskStats = statsFile.tasks[taskName];

      rows.push({
        fileName: taskName,
        taskName,
        sizeBytes: stats.sizeBytes,
        fileCount: stats.fileCount,
        createdMs: stats.mtimeMs,
        hasMeta: Boolean(meta),
        ready,
        hasFeedback,
        estimatedSolveTime: meta?.estimatedSolveTime ?? null,
        taskType: meta?.taskType ?? null,
        repoType: meta?.repoType ?? null,
        requiresInternet: meta?.requiresInternet ?? null,
        repo: meta?.repo ?? null,
        doNotSubmit,
        note: doNotSubmit ? meta?.status ?? null : null,
        status: meta?.status ?? null,
        failed,
        submitCount: taskStats?.submitted ?? 0,
        failedStep7: taskStats?.failedStep7 ?? 0,
        failedStep8: taskStats?.failedStep8 ?? 0,
        failedOtherSteps: taskStats?.failedOtherSteps ?? {},
      });
    }
    rows.sort((a, b) => a.taskName.localeCompare(b.taskName));
    // Task created → store its name: every task folder seen by the scan
    // gets a row in task-stats.json (no-op when already registered).
    await registerTasks(rows.map((r) => r.taskName));
    // Tasks with a parseable task.toml are the ones the auto-handler
    // "manages" (submits + writes feedback for).
    const managedNames = rows.filter((r) => r.hasMeta).map((r) => r.taskName);
    return NextResponse.json({
      ok: true,
      dir,
      count: rows.length,
      zips: rows,
      managedNames,
      brokenTomls,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
