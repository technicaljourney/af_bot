import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { parse as parseToml } from "smol-toml";
import { getGoldDir } from "@/lib/gold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RepoRow {
  name: string;
  modifiedMs: number;
  /** `<repo>/STATUS.md` exists (a processed/tracked repo marker). */
  hasStatus: boolean;
  /** Number of entries under `<repo>/tasks/` (0 if none/unreadable). */
  taskCount: number;
  /** repo_url from `<repo>/data.txt`, if present. Drives the "Connect repo" button. */
  repoUrl: string | null;
  /** "technicaljourney/admitd" from data.txt, if present. */
  repository: string | null;
  /** clone_url from data.txt, if present. */
  cloneUrl: string | null;
  /** default_branch from data.txt, if present. */
  defaultBranch: string | null;
}

/** Read + parse `<repo>/data.txt` (TOML). Returns {} if missing/unparseable. */
async function readData(repoPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoPath, "data.txt"), "utf8");
  } catch {
    return {}; // no data.txt
  }
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    // Tolerate slight non-TOML formatting: fall back to `key = "value"` lines.
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** List the repo folders under GOLD_DIR/result/. */
export async function GET() {
  try {
    const resultDir = path.join(getGoldDir(), "result");
    let dirents;
    try {
      dirents = await fs.readdir(resultDir, { withFileTypes: true });
    } catch (e) {
      // result/ missing → empty list rather than a hard error.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ ok: true, dir: resultDir, count: 0, repos: [] });
      }
      throw e;
    }

    const repos: RepoRow[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue; // repos are folders
      const repoPath = path.join(resultDir, d.name);
      let modifiedMs = 0;
      let hasStatus = false;
      let taskCount = 0;
      try {
        modifiedMs = (await fs.stat(repoPath)).mtimeMs;
      } catch {
        /* ignore */
      }
      try {
        await fs.access(path.join(repoPath, "STATUS.md"));
        hasStatus = true;
      } catch {
        /* no STATUS.md */
      }
      try {
        taskCount = (await fs.readdir(path.join(repoPath, "tasks"))).length;
      } catch {
        /* no tasks/ */
      }
      const data = await readData(repoPath);
      repos.push({
        name: d.name,
        modifiedMs,
        hasStatus,
        taskCount,
        repoUrl: str(data.repo_url),
        repository: str(data.repository),
        cloneUrl: str(data.clone_url),
        defaultBranch: str(data.default_branch),
      });
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ ok: true, dir: resultDir, count: repos.length, repos });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
