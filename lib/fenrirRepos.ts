/**
 * Discover submittable repos in the local Fenrir/ folder for auto-submit.
 *
 * Each prepared repo dir (flint/, strata/, qvm/, …) is a git repo already pushed
 * to a private GitHub URL — we read that URL straight from the git remote, so
 * auto-submit never has to push anything. Dirs with a harness but no git remote
 * (e.g. an unpushed repo) are returned flagged so the UI can surface them.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import { getFenrirDir } from "@/lib/fenrirLocal";

const exec = promisify(execFile);

export interface LocalRepo {
  name: string;
  repoUrl: string | null;
  ref: string | null;
  isGit: boolean;
  hasHarness: boolean;
}

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", dir, ...args], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  );
}

/** Scan the Fenrir dir for repo dirs (those with a git remote or a harness). */
export async function scanLocalRepos(): Promise<LocalRepo[]> {
  const root = getFenrirDir();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: LocalRepo[] = [];
  for (const name of entries.sort()) {
    // Skip artifact/aux dirs — they aren't submittable repos.
    if (/(_submission|_pocs|\.bak)$/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      if (!(await fs.stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const isGit = await exists(path.join(dir, ".git"));
    const hasHarness =
      (await exists(path.join(dir, "fuzz"))) ||
      (await exists(path.join(dir, ".clusterfuzzlite")));
    if (!isGit && !hasHarness) continue; // not a repo (task/, etc.)

    const repoUrl = isGit ? await git(dir, ["remote", "get-url", "origin"]) : null;
    const branch = isGit ? await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
    out.push({
      name,
      repoUrl,
      ref: branch && branch !== "HEAD" ? branch : null,
      isGit,
      hasHarness,
    });
  }
  return out;
}

export { normalizeRepoUrl } from "@/lib/repoUrl";
