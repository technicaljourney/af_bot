import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

/**
 * Local archive/unarchive of a repo (with all its tasks) or a single task, via a
 * non-destructive `.archived` marker file. Reversible; does not touch AfterQuery.
 *
 * Body: { scope: "repo" | "task", repo, task?, archived: boolean }
 *   archived=true  → create the marker (hide)
 *   archived=false → remove the marker (restore)
 */
export async function POST(req: NextRequest) {
  let body: { scope?: string; repo?: string; task?: string; archived?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const scope = body.scope;
  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  const archived = Boolean(body.archived);

  if (scope !== "repo" && scope !== "task") {
    return NextResponse.json({ ok: false, error: "scope must be 'repo' or 'task'." }, { status: 400 });
  }
  if (!safe(repo)) {
    return NextResponse.json({ ok: false, error: "Invalid repo." }, { status: 400 });
  }
  if (scope === "task" && !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid task." }, { status: 400 });
  }

  const base = getGoldDir();
  const marker =
    scope === "repo"
      ? path.join(base, "result", repo, ".archived")
      : path.join(base, "result", repo, "tasks", task, ".archived");

  try {
    if (archived) {
      await fs.writeFile(marker, `archived at ${new Date().toISOString()}\n`, "utf8");
    } else {
      await fs.rm(marker, { force: true });
    }
    return NextResponse.json({ ok: true, scope, repo, task: task || null, archived });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
