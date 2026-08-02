import { promises as fs } from "fs";
import path from "path";

/** AfterQuery_Silver project root (parent of `bot/`). */
export function getSilverProjectRoot(): string {
  const fromEnv = process.env.SILVER_PROJECT_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), "..");
}

/** Where the Silver auto-handler finds task folders (each containing a
 *  `task.toml`) and writes feedback (`<task>.feedback.json`).
 *
 *  Defaults to `<project_root>/tasks/` (sibling of `bot/`).
 *
 *  Override with SILVER_TASK_DIR (preferred) or the legacy SILVER_TASK_ZIP_DIR.
 */
export function getSilverTaskDir(): string {
  const fromEnv =
    process.env.SILVER_TASK_DIR || process.env.SILVER_TASK_ZIP_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(getSilverProjectRoot(), "tasks");
}

/** Candidate paths for `repos.json` — project root first, then tasks/ (legacy). */
export function getReposJsonCandidates(): string[] {
  const fromEnv = process.env.SILVER_REPOS_JSON;
  if (fromEnv && fromEnv.trim()) return [path.resolve(fromEnv.trim())];
  const root = getSilverProjectRoot();
  return [path.join(root, "repos.json"), path.join(getSilverTaskDir(), "repos.json")];
}

/** Read the first existing `repos.json` from {@link getReposJsonCandidates}. */
export async function readReposJson(): Promise<{
  path: string;
  raw: string;
} | null> {
  for (const p of getReposJsonCandidates()) {
    try {
      const raw = await fs.readFile(p, "utf8");
      return { path: p, raw };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  return null;
}
