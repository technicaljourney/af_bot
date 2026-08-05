import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");
const ALLOWED = new Set(["idle", "updating", "check", "ready"]);

/** Write `status = "<status>"` into a task's data.txt. Body: { repo, task, status }. */
export async function POST(req: NextRequest) {
  let body: { repo?: string; task?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  const status = (body.status || "").trim();
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }
  if (!ALLOWED.has(status)) {
    return NextResponse.json({ ok: false, error: "Invalid status." }, { status: 400 });
  }

  const file = path.join(getGoldDir(), "result", repo, "tasks", task, "data.txt");
  try {
    let content = "";
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      /* no data.txt yet → will create */
    }
    const line = `status = "${status}"`;
    if (/^\s*status\s*=.*$/m.test(content)) {
      content = content.replace(/^\s*status\s*=.*$/m, line);
    } else {
      content = content ? `${content.replace(/\s*$/, "")}\n${line}\n` : `${line}\n`;
    }
    await fs.writeFile(file, content, "utf8");
    return NextResponse.json({ ok: true, repo, task, status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
