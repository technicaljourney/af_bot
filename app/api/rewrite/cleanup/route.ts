import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getTaskZipDir } from "@/lib/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRewriteTaskDir(): string {
  const fromEnv = process.env.REWRITE_TASK_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(path.dirname(getTaskZipDir()), "RewriteTask");
}

async function unlinkIfExists(file: string): Promise<"removed" | "missing"> {
  try {
    await fs.unlink(file);
    return "removed";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
}

/** Removes both task.txt and result.txt — called after a successful submit so
 *  the auto-handler can claim the next task. */
export async function POST() {
  const dir = getRewriteTaskDir();
  try {
    const task = await unlinkIfExists(path.join(dir, "task.txt"));
    const result = await unlinkIfExists(path.join(dir, "result.txt"));
    return NextResponse.json({ ok: true, task, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
