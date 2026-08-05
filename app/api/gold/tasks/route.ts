import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TaskItem {
  name: string;
  modifiedMs: number;
  baseCommit: string | null;
  /** task_name from task.toml.lines.txt (may differ from the folder name);
   *  used to match against gold.tasks.listMine. Falls back to the folder name. */
  taskName: string;
  /** `<task>/.archived` marker exists → locally archived (hidden by default). */
  archived: boolean;
  /** status from `<task>/data.txt` (idle | updating | check | ready). */
  status: string;
}

/** Read `status = "..."` from a task's data.txt. Defaults to "idle". */
async function readTaskStatus(taskPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(taskPath, "data.txt"), "utf8");
    const m = raw.match(/^\s*status\s*=\s*"?([A-Za-z_]+)"?/m);
    if (m) return m[1];
  } catch {
    /* no data.txt → idle */
  }
  return "idle";
}

/** Read base_commit + task_name from a task's toml/config. */
async function readTaskMeta(
  taskPath: string,
  folderName: string
): Promise<{ baseCommit: string | null; taskName: string }> {
  let baseCommit: string | null = null;
  let taskName = folderName;
  try {
    const raw = await fs.readFile(path.join(taskPath, "task.toml.lines.txt"), "utf8");
    const bc = raw.match(/base_commit\s*=\s*"?([0-9a-fA-F]{7,40})"?/);
    if (bc) baseCommit = bc[1];
    const tn = raw.match(/task_name\s*=\s*"([^"]*)"/);
    if (tn && tn[1].trim()) taskName = tn[1].trim();
  } catch {
    /* no task.toml.lines.txt */
  }
  if (!baseCommit) {
    try {
      const cfg = JSON.parse(
        await fs.readFile(path.join(taskPath, "tests", "config.json"), "utf8")
      );
      if (cfg && typeof cfg.base_commit === "string") baseCommit = cfg.base_commit;
    } catch {
      /* no/invalid config.json */
    }
  }
  return { baseCommit, taskName };
}

/** List the task folders (top level) under GOLD_DIR/result/<repo>/tasks/. */
export async function GET(req: NextRequest) {
  const repo = (req.nextUrl.searchParams.get("repo") || "").trim();
  // Guard against path traversal — repo is a single folder name.
  if (!repo || repo.includes("/") || repo.includes("\\") || repo.includes("..")) {
    return NextResponse.json({ ok: false, error: "Invalid repo." }, { status: 400 });
  }

  try {
    const tasksDir = path.join(getGoldDir(), "result", repo, "tasks");
    let dirents;
    try {
      dirents = await fs.readdir(tasksDir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ ok: true, repo, count: 0, tasks: [] });
      }
      throw e;
    }

    const tasks: TaskItem[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue; // each task is a folder
      const taskPath = path.join(tasksDir, d.name);
      let modifiedMs = 0;
      try {
        modifiedMs = (await fs.stat(taskPath)).mtimeMs;
      } catch {
        /* ignore */
      }
      let archived = false;
      try {
        await fs.access(path.join(taskPath, ".archived"));
        archived = true;
      } catch {
        /* not archived */
      }
      const meta = await readTaskMeta(taskPath, d.name);
      tasks.push({
        name: d.name,
        modifiedMs,
        baseCommit: meta.baseCommit,
        taskName: meta.taskName,
        archived,
        status: await readTaskStatus(taskPath),
      });
    }
    tasks.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ ok: true, repo, count: tasks.length, tasks });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
