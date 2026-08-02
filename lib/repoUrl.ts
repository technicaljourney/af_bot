/**
 * GitHub URL normalization, in its own module so the browser bundle can use it.
 * (lib/fenrirRepos.ts pulls in child_process/fs and is server-only.)
 */

/** Normalize a GitHub URL to "owner/repo" (lowercased) for dedupe. */
export function normalizeRepoUrl(url: string): string {
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : url.trim().toLowerCase();
}
