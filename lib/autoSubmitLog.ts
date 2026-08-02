/**
 * Durable record of every repo auto-submit has already sent.
 *
 * This is the ONLY authority on "have we submitted this?". Earlier the check was
 * "is it missing from the account's live submission list?", which is wrong: a
 * repo that failed and was deleted from AfterQuery disappears from that list and
 * therefore looks brand new, so it gets submitted again — exactly the loop the
 * deletion was meant to end. Whether a repo is currently on the server says
 * nothing about whether we already sent it, so we write our own ledger to disk.
 *
 * Disk (not browser storage) because the record has to outlive a cleared cache,
 * a different browser profile, and a private window. Keyed by "owner/repo" so a
 * URL written with or without .git — or re-created under the same name — still
 * matches.
 *
 * Delete the file (or use the "forget" endpoint) to deliberately allow a repo to
 * be submitted again.
 */

import { promises as fs } from "fs";
import path from "path";
import { normalizeRepoUrl } from "@/lib/repoUrl";

const LOG_FILE = path.join(process.cwd(), ".auto-submit-log.json");

export interface SubmittedEntry {
  repoUrl: string;
  ref: string;
  /** ISO timestamp of when we recorded it. */
  at: string;
  /** AfterQuery submission id, when the submit call returned one. */
  submissionId?: string;
  /** How it got here: we submitted it, or it was already on the account. */
  via: "auto-submit" | "already-on-server" | "manual";
  /** Set when a later check found it gone from the account (deleted/failed). */
  goneAt?: string;
}

type LogShape = { submitted: Record<string, SubmittedEntry> };

async function read(): Promise<LogShape> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const o = JSON.parse(raw) as Partial<LogShape>;
    if (o && typeof o === "object" && o.submitted && typeof o.submitted === "object") {
      return { submitted: o.submitted as Record<string, SubmittedEntry> };
    }
  } catch {
    /* absent or corrupt → start empty rather than blocking submissions */
  }
  return { submitted: {} };
}

/**
 * Serialise read-modify-write. Two submissions finishing at once would otherwise
 * both read the old file and the second would drop the first's entry — which in
 * this ledger means a repo silently becomes eligible for resubmission.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function write(log: LogShape): Promise<void> {
  await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2), { mode: 0o600 });
}

/** Every recorded repo, keyed by "owner/repo". */
export async function listSubmitted(): Promise<Record<string, SubmittedEntry>> {
  return (await read()).submitted;
}

/** Has this repo already been submitted (whatever its current server state)? */
export async function isSubmitted(repoUrl: string): Promise<boolean> {
  const log = await read();
  return Boolean(log.submitted[normalizeRepoUrl(repoUrl)]);
}

/**
 * Record a repo as submitted. Idempotent, and never downgrades an existing
 * entry — the first record (with its submissionId) is the one that matters.
 */
export async function recordSubmitted(
  repoUrl: string,
  info: { ref?: string; submissionId?: string; via?: SubmittedEntry["via"] } = {}
): Promise<SubmittedEntry> {
  const key = normalizeRepoUrl(repoUrl);
  return serialise(async () => {
    const log = await read();
    const existing = log.submitted[key];
    const entry: SubmittedEntry = existing ?? {
      repoUrl,
      ref: info.ref || "main",
      at: new Date().toISOString(),
      via: info.via || "auto-submit",
    };
    // Fill in a submission id we learned later, but keep the original timestamp.
    if (info.submissionId && !entry.submissionId) entry.submissionId = info.submissionId;
    log.submitted[key] = entry;
    await write(log);
    return entry;
  });
}

/** Note that a recorded repo is no longer on the account — kept as a record (so
 *  it is NOT resubmitted), just annotated for the UI. */
export async function markGone(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await serialise(async () => {
    const log = await read();
    let changed = false;
    const now = new Date().toISOString();
    for (const k of keys) {
      const e = log.submitted[k];
      if (e && !e.goneAt) {
        e.goneAt = now;
        changed = true;
      }
    }
    if (changed) await write(log);
  });
}

/** Forget a repo so auto-submit may send it again (deliberate re-submission). */
export async function forgetSubmitted(repoUrls: string[]): Promise<number> {
  return serialise(async () => {
    const log = await read();
    let n = 0;
    for (const u of repoUrls) {
      const key = normalizeRepoUrl(u);
      if (log.submitted[key]) {
        delete log.submitted[key];
        n++;
      }
    }
    if (n) await write(log);
    return n;
  });
}

export const AUTO_SUBMIT_LOG_FILE = LOG_FILE;
