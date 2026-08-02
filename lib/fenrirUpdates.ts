/**
 * Reads `updates.json` from a work folder — the hand-off file the repo-building
 * side writes once it has successfully created and pushed a GitHub repo. Each
 * entry is a repo that is ready to be submitted for fuzzing.
 *
 * Observed format (Fenrir/updates.json) — a JSON array of "<repoUrl>, <ref>":
 *
 *   [
 *     "https://github.com/leahgantalao/mk_topaz, main",
 *     "https://github.com/leahgantalao/mk_uvarovite, main"
 *   ]
 *
 * Object entries are also accepted, since the writer is external and may grow
 * fields: {repoUrl|url|repo, ref|branch, status|message}. When an entry carries
 * a status/message we require it to look like a success ("Successfully created
 * repository …") so a failed build never gets submitted; bare strings are taken
 * at face value because their presence in the file IS the success signal.
 */

import { promises as fs } from "fs";
import path from "path";
import { normalizeRepoUrl } from "@/lib/repoUrl";

export const UPDATES_FILE = "updates.json";

export interface UpdateEntry {
  /** Repo URL exactly as written, for submission. */
  repoUrl: string;
  /** Branch/ref, defaulting to "main" when the entry omits it. */
  ref: string;
  /** "owner/repo" lowercased — the dedupe key against live submissions. */
  key: string;
}

/** A status/message field that means the repo was created and pushed. */
const SUCCESS_RE = /success|created|pushed|ready|done/i;
/** …and one that clearly did not. A negation beats the success words above. */
const FAILURE_RE = /fail|error|abort|skip|denied|not\s+created/i;

/** Split "https://github.com/o/r, main" into its url and ref halves. */
function parseString(s: string): { repoUrl: string; ref: string } | null {
  const text = s.trim();
  if (!text) return null;
  // Take the first github URL in the line, so a decorated entry like
  // "Successfully created repository https://github.com/o/r, main" still parses.
  const url = text.match(/https?:\/\/\S*github\.com\/[^\s,]+|git@github\.com:[^\s,]+/i)?.[0];
  if (!url) return null;
  // The ref is whatever follows the url's comma, if anything.
  const after = text.slice(text.indexOf(url) + url.length);
  const ref = after.replace(/^[\s,]+/, "").split(/[\s,]+/)[0] || "";
  return { repoUrl: url.replace(/[.,;]+$/, ""), ref };
}

function toEntry(raw: unknown): UpdateEntry | null {
  let repoUrl = "";
  let ref = "";

  if (typeof raw === "string") {
    const parsed = parseString(raw);
    if (!parsed) return null;
    ({ repoUrl, ref } = parsed);
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const url = o.repoUrl ?? o.url ?? o.repo ?? o.html_url;
    if (typeof url !== "string") return null;
    const parsed = parseString(url);
    if (!parsed) return null;
    repoUrl = parsed.repoUrl;
    const r = o.ref ?? o.branch ?? o.default_branch;
    ref = typeof r === "string" && r.trim() ? r.trim() : parsed.ref;
    // Only gate on a status field when the writer actually supplied one.
    const status = [o.status, o.message, o.event, o.state]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (status && (FAILURE_RE.test(status) || !SUCCESS_RE.test(status))) return null;
  } else {
    return null;
  }

  if (!repoUrl) return null;
  return { repoUrl, ref: ref || "main", key: normalizeRepoUrl(repoUrl) };
}

export interface UpdatesResult {
  entries: UpdateEntry[];
  /** Absolute path we read (or tried to), for the UI/log. */
  file: string;
  /** True when the file simply isn't there — not an error, just nothing yet. */
  missing: boolean;
  /** Set only when the file exists but could not be used. */
  error?: string;
}

/**
 * Read + parse `<root>/updates.json`. A missing file is normal (nothing has been
 * created yet) and yields an empty list; malformed JSON is reported as an error
 * so the UI can show it rather than silently submitting nothing.
 */
export async function readUpdates(root: string): Promise<UpdatesResult> {
  const file = path.join(root, UPDATES_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { entries: [], file, missing: true };
  }
  if (!raw.trim()) return { entries: [], file, missing: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], file, missing: false, error: `${UPDATES_FILE} is not valid JSON: ${(e as Error).message}` };
  }

  // Accept a bare array or a { updates: [...] } / { repos: [...] } wrapper.
  const wrap = parsed as { updates?: unknown; repos?: unknown; entries?: unknown };
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(wrap.updates)
    ? wrap.updates
    : Array.isArray(wrap.repos)
    ? wrap.repos
    : Array.isArray(wrap.entries)
    ? wrap.entries
    : null;
  if (!arr) return { entries: [], file, missing: false, error: `${UPDATES_FILE} is not a JSON array` };

  // De-dupe within the file itself (last write wins on ref).
  const byKey = new Map<string, UpdateEntry>();
  for (const item of arr) {
    const e = toEntry(item);
    if (e) byKey.set(e.key, e);
  }
  return { entries: [...byKey.values()], file, missing: false };
}
