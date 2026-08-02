import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { createTask, getGoldDir, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

/** Normalize a human category ("Feature request") to the enum ("feature_request"). */
function normalizeCategory(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readField(raw: string, key: string): string | null {
  const m = raw.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Create a new Gold task for a task folder.
 * Body: { repo, task, repoId, environmentVersion, token? }.
 * taskName + category are read from
 *   GOLD_DIR/result/<repo>/tasks/<task>/task.toml.lines.txt
 */
export async function POST(req: NextRequest) {
  let body: {
    repo?: string;
    task?: string;
    repoId?: string;
    environmentVersion?: number;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  const repoId = (body.repoId || "").trim();
  const environmentVersion = body.environmentVersion;
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }
  if (!repoId) {
    return NextResponse.json({ ok: false, error: "repoId is required." }, { status: 400 });
  }
  if (typeof environmentVersion !== "number") {
    return NextResponse.json(
      { ok: false, error: "environmentVersion (number) is required." },
      { status: 400 }
    );
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  const tomlPath = path.join(
    getGoldDir(),
    "result",
    repo,
    "tasks",
    task,
    "task.toml.lines.txt"
  );
  let raw: string;
  try {
    raw = await fs.readFile(tomlPath, "utf8");
  } catch {
    return NextResponse.json(
      { ok: false, error: "task.toml.lines.txt not found for this task." },
      { status: 422 }
    );
  }

  const taskName = readField(raw, "task_name") || task;
  const categoryRaw = readField(raw, "category");
  if (!categoryRaw) {
    return NextResponse.json(
      { ok: false, error: "category not found in task.toml.lines.txt." },
      { status: 422 }
    );
  }
  const category = normalizeCategory(categoryRaw);

  try {
    const result = await createTask(token, { repoId, environmentVersion, taskName, category });
    return NextResponse.json({ ok: true, taskName, category, result });
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
