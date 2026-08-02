import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { saveTask, submitTaskForValidation, getGoldDir, GoldError } from "@/lib/gold";
import { getStoredToken } from "@/lib/authStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s && !s.includes("/") && !s.includes("\\") && !s.includes("..");

/** Files to save, keyed by their save path → relative disk path under the task. */
const FILES: Record<string, string> = {
  "instruction.md": "instruction.md",
  "solution/solution.patch": "solution/solution.patch",
  "tests/config.json": "tests/config.json",
  "tests/test.patch": "tests/test.patch",
  "tests/test.sh": "tests/test.sh",
};

/** Minimum/range rules a task must meet before submitting for validation. */
const RULES = {
  solutionLinesAdded: { min: 459 },
  solutionFiles: { min: 4 },
  testLinesAdded: { min: 596 },
  testFiles: { min: 2 },
  instructionWords: { min: 218, max: 582 },
  failToPass: { min: 8 },
  passToPass: { min: 50 },
};

function parseLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([\s\S]*?)"\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const tomlStr = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n")}"`;

function addedLines(patch: string): number {
  let n = 0;
  for (const l of patch.split(/\r?\n/)) if (l.startsWith("+") && !l.startsWith("+++")) n++;
  return n;
}
function patchFileCount(patch: string): number {
  const g = patch.match(/^diff --git /gm);
  if (g) return g.length;
  const p = patch.match(/^\+\+\+ /gm);
  return p ? p.length : 0;
}
function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

async function readOrEmpty(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Save all task files (constructing task.toml), check the metric rules, and — if
 * they pass — submit the task for validation.
 * Body: { repo, task, submissionId, dockerImage, language, token? }.
 */
export async function POST(req: NextRequest) {
  let body: {
    repo?: string;
    task?: string;
    submissionId?: string;
    dockerImage?: string;
    language?: string;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const repo = (body.repo || "").trim();
  const task = (body.task || "").trim();
  const submissionId = (body.submissionId || "").trim();
  const dockerImage = (body.dockerImage || "").trim();
  const language = (body.language || "").trim();
  if (!safe(repo) || !safe(task)) {
    return NextResponse.json({ ok: false, error: "Invalid repo/task." }, { status: 400 });
  }
  if (!submissionId) {
    return NextResponse.json({ ok: false, error: "submissionId is required." }, { status: 400 });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token — connect the extension or paste one." },
      { status: 401 }
    );
  }

  const taskDir = path.join(getGoldDir(), "result", repo, "tasks", task);

  // 1. Read the on-disk files.
  const files: Record<string, string> = {};
  for (const [savePath, relPath] of Object.entries(FILES)) {
    const content = await readOrEmpty(path.join(taskDir, relPath));
    if (content != null) files[savePath] = content;
  }
  if (!files["instruction.md"]) {
    return NextResponse.json(
      { ok: false, error: "instruction.md not found for this task." },
      { status: 422 }
    );
  }

  // 2. Build task.toml from task.toml.lines.txt + env docker image.
  const linesRaw = await readOrEmpty(path.join(taskDir, "task.toml.lines.txt"));
  if (!linesRaw) {
    return NextResponse.json(
      { ok: false, error: "task.toml.lines.txt not found for this task." },
      { status: 422 }
    );
  }
  const meta = parseLines(linesRaw);
  const taskName = meta.task_name || task;
  const category = (meta.category || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const baseCommit = meta.base_commit || "";
  const repository = meta.repository || "";
  const repositoryUrl = repository ? `https://github.com/${repository}` : "";
  const displayTitle = meta.display_title || taskName;
  const displayDescription = meta.display_description || "";

  files["task.toml"] = [
    `schema_version = "1.1"`,
    `artifacts = ["/logs/artifacts/model.patch"]`,
    ``,
    `[task]`,
    `name = "afterquery/${taskName}"`,
    ``,
    `[metadata]`,
    `task_id = "${taskName}"`,
    `display_title = ${tomlStr(displayTitle)}`,
    `display_description = ${tomlStr(displayDescription)}`,
    `category = "${category}"`,
    `language = "${language}"`,
    `repository_url = "${repositoryUrl}"`,
    `base_commit_hash = "${baseCommit}"`,
    ``,
    `[agent]`,
    `timeout_sec = 5400`,
    ``,
    `[verifier]`,
    `environment_mode = "separate"`,
    `timeout_sec = 1800`,
    ``,
    `[verifier.environment]`,
    `build_timeout_sec = 1800`,
    `cpus = 2`,
    `memory_mb = 8192`,
    `storage_mb = 20480`,
    `allow_internet = false`,
    ``,
    `[environment]`,
    `build_timeout_sec = 1800`,
    `docker_image = "${dockerImage}"`,
    `os = "linux"`,
    `cpus = 2`,
    `memory_mb = 8192`,
    `storage_mb = 20480`,
    `gpus = 0`,
    `allow_internet = false`,
    ``,
  ].join("\n");

  // 3. Compute metrics + evaluate rules.
  const solutionPatch = files["solution/solution.patch"] || "";
  const testPatch = files["tests/test.patch"] || "";
  let failToPass = 0;
  let passToPass = 0;
  try {
    const cfg = JSON.parse(files["tests/config.json"] || "{}");
    failToPass = Array.isArray(cfg.f2p_node_ids) ? cfg.f2p_node_ids.length : 0;
    passToPass = Array.isArray(cfg.p2p_node_ids) ? cfg.p2p_node_ids.length : 0;
  } catch {
    /* leave zeros */
  }

  const metrics = {
    solutionLinesAdded: addedLines(solutionPatch),
    solutionFiles: patchFileCount(solutionPatch),
    testLinesAdded: addedLines(testPatch),
    testFiles: patchFileCount(testPatch),
    instructionWords: wordCount(files["instruction.md"] || ""),
    failToPass,
    passToPass,
  };

  const check = (v: number, r: { min?: number; max?: number }) =>
    (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
  const rules = (Object.keys(RULES) as Array<keyof typeof RULES>).map((k) => ({
    name: k,
    actual: metrics[k],
    ...RULES[k],
    pass: check(metrics[k], RULES[k]),
  }));
  const allPass = rules.every((r) => r.pass);

  // 4. Save the files.
  try {
    await saveTask(token, submissionId, files);
  } catch (e) {
    const err = e as GoldError;
    return NextResponse.json(
      { ok: false, step: "save", error: err.message, detail: err.detail },
      { status: err.status && err.status >= 400 ? err.status : 502 }
    );
  }

  // 5. Submit only if all rules pass.
  if (!allPass) {
    return NextResponse.json({
      ok: true,
      saved: true,
      submitted: false,
      metrics,
      rules,
      message: "Files saved. Rules not met — not submitted.",
    });
  }

  try {
    const result = await submitTaskForValidation(token, submissionId);
    return NextResponse.json({ ok: true, saved: true, submitted: true, metrics, rules, result });
  } catch (e) {
    const err = e as GoldError;
    return NextResponse.json(
      { ok: false, step: "submit", error: err.message, detail: err.detail, metrics, rules },
      { status: err.status && err.status >= 400 ? err.status : 502 }
    );
  }
}
