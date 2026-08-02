import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { submitDockerfile, getGoldDir, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

async function readBaseCommit(taskPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(taskPath, "task.toml.lines.txt"), "utf8");
    const m = raw.match(/base_commit\s*=\s*"?([0-9a-fA-F]{7,40})"?/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(taskPath, "tests", "config.json"), "utf8"));
    if (cfg && typeof cfg.base_commit === "string") return cfg.base_commit;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Add (build) an environment for a task's base commit.
 * Body: { repo, task, repoId, token? }.
 * Reads base_commit + environment.Dockerfile from
 *   GOLD_DIR/result/<repo>/tasks/<task>/  and submits the Dockerfile.
 */
export async function POST(req: NextRequest) {
  let body: { repo?: string; task?: string; repoId?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  const repoId = (body.repoId || "").trim();
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }
  if (!repoId) {
    return NextResponse.json({ ok: false, error: "repoId is required." }, { status: 400 });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  const taskPath = path.join(getGoldDir(), "result", repo, "tasks", task);

  const baseSha = await readBaseCommit(taskPath);
  if (!baseSha) {
    return NextResponse.json(
      { ok: false, error: "Could not read base_commit for this task." },
      { status: 422 }
    );
  }

  let dockerfile: string;
  try {
    dockerfile = await fs.readFile(path.join(taskPath, "environment.Dockerfile"), "utf8");
  } catch {
    return NextResponse.json(
      { ok: false, error: "environment.Dockerfile not found for this task." },
      { status: 422 }
    );
  }

  try {
    const result = await submitDockerfile(token, repoId, baseSha, dockerfile);
    return NextResponse.json({ ok: true, repoId, baseSha, result });
  } catch (e) {
    if (e instanceof GoldError) {
      return NextResponse.json(
        { ok: false, error: e.message, detail: e.detail },
        { status: e.status && e.status >= 400 ? e.status : 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
