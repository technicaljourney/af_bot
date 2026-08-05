import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readStatus(taskPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(taskPath, "data.txt"), "utf8");
    const m = raw.match(/^\s*status\s*=\s*"?([A-Za-z_]+)"?/m);
    if (m) return m[1];
  } catch {
    /* no data.txt → idle */
  }
  return "idle";
}

/** Real-time task statuses across all repos, keyed by `${repo}::${task}`. */
export async function GET() {
  try {
    const resultDir = path.join(getGoldDir(), "result");
    const statuses: Record<string, string> = {};
    let repos: string[] = [];
    try {
      repos = (await fs.readdir(resultDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return NextResponse.json({ ok: true, statuses });
    }
    for (const repo of repos) {
      const tasksDir = path.join(resultDir, repo, "tasks");
      let taskDirs;
      try {
        taskDirs = (await fs.readdir(tasksDir, { withFileTypes: true })).filter((d) =>
          d.isDirectory()
        );
      } catch {
        continue;
      }
      for (const t of taskDirs) {
        statuses[`${repo}::${t.name}`] = await readStatus(path.join(tasksDir, t.name));
      }
    }
    return NextResponse.json({ ok: true, statuses });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
