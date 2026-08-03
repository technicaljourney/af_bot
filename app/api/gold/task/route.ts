import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

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
      /* ignore */
    }
  }
  return { baseCommit, taskName };
}

/** Read a single task's data. Query: ?repo=<folder>&task=<folder>. */
export async function GET(req: NextRequest) {
  const repo = (req.nextUrl.searchParams.get("repo") || "").trim();
  const task = (req.nextUrl.searchParams.get("task") || "").trim();
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }

  const taskPath = path.join(getGoldDir(), "result", repo, "tasks", task);
  try {
    const st = await fs.stat(taskPath);
    if (!st.isDirectory()) {
      return NextResponse.json({ ok: true, task: null }); // gone / not a folder
    }
    let archived = false;
    try {
      await fs.access(path.join(taskPath, ".archived"));
      archived = true;
    } catch {
      /* not archived */
    }
    const meta = await readTaskMeta(taskPath, task);
    return NextResponse.json({
      ok: true,
      task: {
        name: task,
        modifiedMs: st.mtimeMs,
        baseCommit: meta.baseCommit,
        taskName: meta.taskName,
        archived,
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: true, task: null }); // task removed
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
