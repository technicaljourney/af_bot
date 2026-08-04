import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

/** Permanently remove a task folder from disk: GOLD_DIR/result/<repo>/tasks/<task>.
 *  Body: { repo, task }. */
export async function POST(req: NextRequest) {
  let body: { repo?: string; task?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }

  const tasksRoot = path.join(getGoldDir(), "result", repo, "tasks");
  const dir = path.join(tasksRoot, task);
  // Extra safety: the resolved path must stay inside <repo>/tasks/.
  if (path.relative(tasksRoot, dir).startsWith("..") || path.isAbsolute(path.relative(tasksRoot, dir))) {
    return NextResponse.json({ ok: false, error: "Path escapes tasks dir." }, { status: 400 });
  }

  try {
    await fs.rm(dir, { recursive: true, force: true });
    return NextResponse.json({ ok: true, removed: dir });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
