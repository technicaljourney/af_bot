import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getTaskZipDir } from "@/lib/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the rewrite auto-handler stages task.txt / reads result.txt.
 *  Defaults to `<task_zip parent>/RewriteTask/`. Override with REWRITE_TASK_DIR. */
function getRewriteTaskDir(): string {
  const fromEnv = process.env.REWRITE_TASK_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(path.dirname(getTaskZipDir()), "RewriteTask");
}

export async function POST(req: NextRequest) {
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ ok: false, error: "content required." }, { status: 400 });
  }
  const dir = getRewriteTaskDir();
  const file = path.join(dir, "task.txt");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, body.content, "utf8");
    return NextResponse.json({ ok: true, path: file });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
