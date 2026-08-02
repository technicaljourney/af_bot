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

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function GET() {
  const dir = getRewriteTaskDir();
  const taskFile = path.join(dir, "task.txt");
  const resultFile = path.join(dir, "result.txt");
  try {
    const taskContent = await readIfExists(taskFile);
    const resultContent = await readIfExists(resultFile);
    return NextResponse.json({
      ok: true,
      dir,
      task: { exists: taskContent !== null, content: taskContent },
      result: { exists: resultContent !== null, content: resultContent },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
