/**
 * AfterQuery "Rewrite" project — separate project from Pluto, same Firebase
 * auth token works.
 *
 *   GET  /api/projects/rewrite/tasks/available
 *        -> { availableCount, collectionState, claimedTask, userStats }
 *   POST /api/projects/rewrite/tasks/claim
 *        -> { task: <claimedTask|null> }
 *   POST /api/projects/rewrite/tasks/submit  { taskId, rewriteText }
 *        -> { success, taskId, status, displayStatus, attemptsUsed,
 *             attemptsRemaining, checks: { gptZero, meaning, passed } }
 */

import { normalizeToken } from "@/lib/afterquery";

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";
const PROJECT = "rewrite";

export class RewriteError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "RewriteError";
    this.status = status;
    this.detail = detail;
  }
}

async function authedCall(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown
): Promise<any> {
  const t = normalizeToken(token);
  if (!t) throw new RewriteError("Missing auth token.");
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/projects/${PROJECT}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    throw new RewriteError(`Network error calling ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new RewriteError(
      json?.error || json?.message || `${path} HTTP ${res.status}`,
      res.status,
      json
    );
  }
  return json;
}

export async function getAvailable(token: string): Promise<any> {
  return authedCall("GET", "tasks/available", token);
}

export async function claimTask(token: string): Promise<any> {
  return authedCall("POST", "tasks/claim", token, {});
}

export async function submitRewrite(
  token: string,
  taskId: string,
  rewriteText: string
): Promise<any> {
  return authedCall("POST", "tasks/submit", token, { taskId, rewriteText });
}
