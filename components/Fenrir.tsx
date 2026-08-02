"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FenrirSubmission,
  FenrirFinding,
  FenrirProfile,
  FenrirGithubConnection,
} from "@/lib/fenrir";
import {
  analyzeDescription,
  MAX_CHARS,
  MAX_WORDS,
  MAX_SENTENCES,
} from "@/lib/fenrirTaskDesc";
import {
  findingProgress,
  submissionProgress,
  findingNeedsRevision,
  isHardRejected,
} from "@/lib/fenrirPipeline";
import type { FenrirProgress } from "@/lib/fenrirPipeline";
import { normalizeRepoUrl } from "@/lib/repoUrl";

const POLL_MS = 15_000;
// How many patch submissions to run at once per repo. Browsers cap ~6 concurrent
// connections per origin anyway, so 6 saturates the pipe without a thundering
// herd of hundreds of in-flight submits.
const PATCH_CONCURRENCY = 6;
// Same idea for bulk deletes, plus a per-request timeout so one hung delete can
// never freeze the whole batch (leaving the button stuck on "Deleting…").
const DELETE_CONCURRENCY = 6;
const DELETE_TIMEOUT_MS = 20_000;
// Detail fetches are large (100s of KB per repo). Bound how many run at once and
// give each a timeout + a retry so a transient stall doesn't blank a repo to
// "Failed to fetch". Auto-patch is likewise capped so it can't storm the
// connection pool and starve deletes / detail fetches.
const DETAIL_FETCH_CONCURRENCY = 4;
const DETAIL_TIMEOUT_MS = 25_000;
const DETAIL_ATTEMPTS = 2;
const AUTO_PATCH_CONCURRENCY = 3;
// A transient auto-patch failure (timeout / network / AfterQuery hiccup) should
// NOT permanently mark a task handled — retry it up to this many times before
// giving up. Resolution errors ("no patch maps") are never retried.
const AUTO_PATCH_MAX_RETRIES = 4;
const REVISE_CONCURRENCY = 4;
// Auto-submit intakes brand-new repos, so keep it gentle: a couple at a time and
// a slower poll than the task poll — updates.json changes on a human/agent
// timescale (a repo gets built every few minutes at best), not a UI timescale.
const AUTO_SUBMIT_CONCURRENCY = 2;
const UPDATES_POLL_MS = 20_000;
// PoC submission uploads a file per crashing input and creates a task each, so
// keep it to a couple of repos at a time.
const AUTO_POC_CONCURRENCY = 2;
// Local folder names are a cheap filesystem read, and they change while the app
// is open (the builder keeps adding <repo>_submission folders), so re-read them
// often — this list decides what the "Only my repositories" filter shows and what
// the auto-handlers are allowed to touch.
const LOCAL_NAMES_POLL_MS = 15_000;
// The /submissions LIST endpoint can be slow (10s+ once you have many repos), so
// give it a generous timeout and never let poll ticks stack. The per-repo DETAIL
// fetches (task states — what you actually watch) are fast, so poll them every
// POLL_MS while re-fetching the slow list only every LIST_POLL_MS.
const SUBMISSIONS_TIMEOUT_MS = 45_000;
const LIST_POLL_MS = 60_000;
// Retry a delete this many times on transient failures (timeout / 5xx) before
// giving up — AfterQuery is intermittently slow and a retry usually succeeds.
const DELETE_ATTEMPTS = 3;
// Backstop: any repo-level bulk key auto-clears after this long, so a hung
// request can never leave the UI stuck on "Deleting…" / "Submitting…".
const BULK_MAX_MS = 180_000;

function fmt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Read a File as raw base64 (no data: prefix) — for the PoC upload. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Could not read file"));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

function dur(sec?: number): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** Colour a status / stage badge by coarse Fenrir lifecycle state. */
function badgeClass(s = ""): string {
  const t = s.toLowerCase();
  // Passing difficulty bands get their own distinctive pills (both are "passed").
  if (t.includes("very hard") || t.includes("very_hard"))
    return "border border-emerald-500 bg-white text-emerald-700";
  if (t.includes("bundle"))
    return "border border-amber-400 bg-emerald-700 text-amber-50";
  // Passed but quality-flagged → a bright solid yellow, distinct from the dark
  // amber "needs revision / action" pills and the green passed pills.
  if (t.includes("flag"))
    return "border border-amber-300 bg-amber-400 text-neutral-900";
  if (
    t.includes("accept") ||
    t.includes("approv") ||
    t.includes("complete") ||
    t.includes("review") ||
    t === "terminal"
  )
    return "bg-emerald-900 text-emerald-200";
  if (
    t.includes("revis") ||
    t.includes("too easy") ||
    t.includes("too_easy") ||
    t.includes("needs") ||
    t.includes("validat")
  )
    return "bg-amber-900 text-amber-200";
  if (t.includes("reject") || t.includes("fail") || t.includes("blocked"))
    return "bg-red-900 text-red-200";
  if (t.includes("action")) return "bg-amber-900 text-amber-200";
  if (t.includes("verif") || t.includes("probe"))
    return "bg-violet-900 text-violet-200";
  if (
    t.includes("fuzz") ||
    t.includes("running") ||
    t.includes("triag") ||
    t.includes("pending") ||
    t.includes("await")
  )
    return "bg-sky-900 text-sky-200";
  return "bg-neutral-800 text-neutral-400";
}

function Badge({ children }: { children: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${badgeClass(children)}`}>{children}</span>
  );
}

const isAction = (s = "") => /action|await/i.test(s);
const isAccepted = (s = "") => /approv|accept/i.test(s);
function findingNeedsAction(f: FenrirFinding): boolean {
  return isAction(f.status ?? "") || f.pipelineStage === "awaiting_patch";
}
/** A patch has been submitted for this task (it's being verified). */
function findingSubmitted(f: FenrirFinding): boolean {
  const s = `${f.status ?? ""} ${f.pipelineStage ?? ""}`.toLowerCase();
  return /patch_submitted|verif/.test(s) || (!!f.patch && Object.keys(f.patch).length > 0);
}
/** A task you can (re)submit a patch for: anything not accepted/in-progress —
 *  includes action-required, awaiting_patch, rejected, needs-revision,
 *  quality-flagged, too-easy, failed. */
function findingPatchable(f: FenrirFinding): boolean {
  const s = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${f.step ?? ""}`.toLowerCase();
  if (/accept|approv|complet/.test(s)) return false;
  return /action|await|reject|revision|flag|too.?easy|fail/.test(s);
}

/** No backend field marks when the build harness finishes — the API returns the
 *  SAME JSON while "Building harness" and after ("Fuzzing"); only elapsed time
 *  changes (confirmed by probing the live API — every pipeline sub-endpoint 404s
 *  and the response is byte-identical). So we treat the first
 *  BUILD_HARNESS_WINDOW_MS after dispatch (while the repo is still in the initial
 *  fuzzing phase with no findings) as "still building" and lock Submit PoCs
 *  until then. Bump the window if your builds run longer. */
const BUILD_HARNESS_WINDOW_MS = 3 * 60_000; // ~3 min

function submissionBuildingHarness(s: FenrirSubmission, findings: FenrirFinding[]): boolean {
  if (findings.length > 0) return false; // findings surfaced → harness built
  const blob = `${s.status ?? ""} ${s.pipelineStage ?? ""}`.toLowerCase();
  if (!/fuzz|initial_fuzz/.test(blob)) return false; // only the initial fuzzing phase
  if (/verif|review|findings_ready|reject|fail|approv|accept|complet/.test(blob)) return false;
  const t = Date.parse(
    String((s as unknown as Record<string, unknown>).dispatchedAt || s.submittedAt || "")
  );
  if (!Number.isFinite(t)) return true; // no timestamp → assume still building
  return Date.now() - t < BUILD_HARNESS_WINDOW_MS;
}

/** A submission that terminally failed / was rejected — e.g. the build harness
 *  was rejected, the initial fuzzing died on infra, or the build itself failed.
 *  A dead repo: there is no PoC / patch / revise / accept path left, so the only
 *  sensible action is to delete it. Reads the authoritative pipelineStage / phase
 *  / step and the `pipelineFailure` object — never the friendly `status`, which
 *  can still read "Review Ready" on an already-dead repo. */
function submissionDead(s: FenrirSubmission, findings: FenrirFinding[] = []): boolean {
  // A pipeline failure is NOT a dead repo while any finding is still live
  // (verifying / awaiting / completed / accepted). A fuzzing-stage failure is a
  // side-channel — the submitted PoCs can still be verified and accepted (e.g.
  // a repo whose auto-fuzz build failed a static check but whose 12 findings are
  // all "Review Ready"/"Very Hard"). Only a failure with nothing to salvage —
  // no findings, or every finding hard-rejected — is a dead, delete-only repo.
  if (findings.some((f) => !isHardRejected(f))) return false;
  const o = s as unknown as Record<string, unknown>;
  if (o.pipelineFailure && typeof o.pipelineFailure === "object") return true;
  const stage = (s.pipelineStage ?? "").toLowerCase();
  const step = (s.step ?? "").toLowerCase();
  // A completed / approved terminal repo is NOT dead, even if a stray fail token
  // shows up elsewhere.
  if (/complet|approv|accept/.test(stage)) return false;
  if (/reject|fail/.test(stage)) return true;
  return (s.phase ?? "") === "terminal" && /reject|fail/.test(step);
}

/** Short red label for a dead repo — prefers the pipeline failure's stage so a
 *  build-harness rejection reads as such, else falls back to Rejected / Failed. */
function submissionDeadLabel(s: FenrirSubmission): string {
  const pf = (s as unknown as Record<string, unknown>).pipelineFailure as
    | { stage?: string; reason?: string }
    | undefined;
  const stage = (pf?.stage ?? s.pipelineStage ?? "").toLowerCase();
  if (/build|harness/.test(stage)) return "Build harness rejected";
  if (/fuzz/.test(stage)) return "Fuzzing failed";
  if (/reject/.test(`${stage} ${s.pipelineStage ?? ""}`)) return "Rejected";
  return "Failed";
}

/** A finding is safe to patch only once the repo's build harness has passed and
 *  this PoC is verified — i.e. it is PAST the "Validating PoC" / initial build
 *  stage. Submitting a patch during that window (before the repo could still be
 *  Rejected) risks getting the AfterQuery account blocked. */
function findingBuildVerified(f: FenrirFinding): boolean {
  const s = `${f.pipelineStage ?? ""} ${f.step ?? ""}`.toLowerCase();
  if (/poc_validat|validating|poc_intake|initial_fuzz|\bfuzz\b/.test(s)) return false;
  return true;
}

function findingAccepted(f: FenrirFinding): boolean {
  return isAccepted(f.status ?? "") || isAccepted(f.pipelineStage ?? "");
}


/** Whether a task is REJECTED only — never "needs review/revision", "quality
 *  flagged", or "too easy" (those are revise-and-resubmit, not deletable). */
function isRejected(f: FenrirFinding): boolean {
  // Single source of truth shared with the red "Rejected" bar, so the count and
  // the display always agree ("too easy" / needs-revision are excluded there).
  return isHardRejected(f);
}

/** Broader than findingNeedsRevision (which drives the amber "Revise patch"
 *  button): ANY revision-worthy task — including ones the difficulty probe
 *  flagged "too easy" that DON'T need the revise-patch click — so "Delete
 *  revision" can clear them all at once. */
function findingRevisionWorthy(f: FenrirFinding): boolean {
  if (isHardRejected(f)) return false; // hard-rejected → "Delete rejected", not this
  if (findingNeedsRevision(f)) return true; // the amber "Needs Revision" pill (too easy)
  const o = f as unknown as Record<string, unknown>;
  const dp = o.difficultyProbe as Record<string, unknown> | undefined;
  const band = dp && typeof dp.band === "string" ? dp.band.toLowerCase() : "";
  if (/too.?easy|too.?simple/.test(band)) return true;
  // A task awaiting your action that was bounced back for a revised resubmit —
  // its previous patch was rejected (step "rejected") OR its description review
  // isn't a clean "pass". These are the "revise & re-attach" tasks. Fresh
  // awaiting-patch tasks (step "verify", verdict "pass") are left alone.
  const state = `${f.status ?? ""} ${f.pipelineStage ?? ""}`.toLowerCase();
  if (/await|action.?required/.test(state)) {
    if (/reject/.test((f.step ?? "").toLowerCase())) return true;
    const dr = o.descriptionReview as Record<string, unknown> | undefined;
    const verdict = dr && typeof dr.verdict === "string" ? dr.verdict.toLowerCase() : "";
    if (verdict && verdict !== "pass") return true;
  }
  return false;
}

/** A FRESH awaiting-patch / Action-Required task (a valid crash you could still
 *  patch) — NOT one flagged for revision (those belong to the "Needs revision"
 *  category). Backs the destructive "Awaiting patch" delete category. */
function findingAwaiting(f: FenrirFinding): boolean {
  if (findingRevisionWorthy(f)) return false; // flagged → Delete revision
  if (isHardRejected(f)) return false;
  const state = `${f.status ?? ""} ${f.pipelineStage ?? ""}`.toLowerCase();
  return /await/.test(state) || f.status === "Action Required";
}

/** The Fenrir server only lets you delete a finding that is awaiting a patch,
 *  rejected, or needs-revision. Once it enters verification (patch_verification,
 *  bug_dedup, difficulty_probe, verified) or is approved/completed it is LOCKED —
 *  DELETE returns 409 "This bug can no longer be deleted…". Use this to disable
 *  the delete controls (and explain why) instead of failing silently. */
function findingDeletable(f: FenrirFinding): boolean {
  return isHardRejected(f) || findingRevisionWorthy(f) || findingAwaiting(f);
}

/** The bulk-cleanup categories offered on the at-a-glance dashboards. These are
 *  the SAME three buckets a repo card's "Delete ▾" menu uses, just applied to
 *  every repo in the current view at once — so the dashboard and the per-repo
 *  menu always agree on what each category means. Together they cover exactly
 *  the tasks `findingDeletable` allows. */
type CleanupKind = "rejected" | "revision" | "awaiting";

const CLEANUP_ORDER: CleanupKind[] = ["rejected", "revision", "awaiting"];

const CLEANUP_KINDS: Record<
  CleanupKind,
  {
    match: (f: FenrirFinding) => boolean;
    /** Menu-item label — mirrors the per-repo Delete menu. */
    label: string;
    /** Log / status-message noun. */
    noun: string;
    confirm: (n: number, scope: string) => string;
  }
> = {
  rejected: {
    match: isRejected,
    label: "Rejected (closed patches)",
    noun: "rejected",
    confirm: (n, scope) =>
      `Delete ${n} rejected task(s) across all ${scope} repos?\n\nAccepted-quality tasks (In Review / Too Hard / Approved / Need Bundle) are kept.`,
  },
  revision: {
    match: findingRevisionWorthy,
    label: "Needs revision (flagged)",
    noun: "needs-revision",
    confirm: (n, scope) =>
      `Delete ${n} needs-revision task(s) across all ${scope} repos?\n\nThese were flagged too easy / bounced back — Auto-revise can reopen them for a new patch instead.`,
  },
  awaiting: {
    match: findingAwaiting,
    label: "Awaiting patch (unpatched)",
    noun: "awaiting-patch",
    confirm: (n, scope) =>
      `Delete ${n} awaiting-patch task(s) across all ${scope} repos?\n\nThese are valid crashes you haven't patched — deleting removes them from AfterQuery (your local PoC files stay).`,
  },
};

/** Coarse status buckets used to group a repo's tasks (AfterQuery style). */
const FINDING_GROUPS = [
  { key: "action", label: "Needs you", dot: "bg-amber-400" },
  { key: "progress", label: "In progress", dot: "bg-sky-400" },
  { key: "accepted", label: "Accepted", dot: "bg-emerald-400" },
  { key: "rejected", label: "Rejected", dot: "bg-red-400" },
] as const;

/** Which group a task belongs to. */
function findingGroupKey(f: FenrirFinding): (typeof FINDING_GROUPS)[number]["key"] {
  if (findingAccepted(f)) return "accepted";
  if (isRejected(f)) return "rejected";
  if (findingNeedsRevision(f) || findingNeedsAction(f)) return "action";
  return "progress"; // validating PoC / verifying / quick screen / difficulty / submission
}

/** Group a repo's findings (keeping each one's original index for patch↔map
 *  matching), preserving the fixed group order and dropping empty groups. */
function groupFindings(findings: FenrirFinding[]) {
  const withIdx = findings.map((f, i) => ({ f, i }));
  return FINDING_GROUPS.map((g) => ({
    ...g,
    items: withIdx.filter(({ f }) => findingGroupKey(f) === g.key),
  })).filter((g) => g.items.length > 0);
}

/** Name the sanitizer from its output, for the section label (like AfterQuery). */
function sanitizerLabel(text = ""): string {
  const m = text.match(
    /(AddressSanitizer|LeakSanitizer|UndefinedBehaviorSanitizer|ThreadSanitizer|MemorySanitizer)/
  );
  return m ? m[1] : "Sanitizer output";
}

// ── Compact status row helpers ───────────────────────────────────────────────

/** Known AddressSanitizer / UBSan / libFuzzer crash classes, match priority. */
const BUG_CLASSES = [
  "heap-use-after-free",
  "stack-use-after-return",
  "stack-use-after-scope",
  "heap-buffer-overflow",
  "stack-buffer-overflow",
  "global-buffer-overflow",
  "use-after-poison",
  "alloc-dealloc-mismatch",
  "attempting double-free",
  "double-free",
  "bad-free",
  "use-after-free",
  "stack-overflow",
  "negative-size-param",
  "requested allocation size",
  "out-of-memory",
  "detected memory leaks",
  "memory leak",
  "null-dereference",
  "SEGV",
  "segmentation fault",
  "signed integer overflow",
  "division by zero",
  "undefined behavior",
  "assertion",
  "abort",
  "timeout",
];

/** Collapse a matched crash phrase to a short lowercase label. */
function normBugClass(hit: string): string {
  const t = hit.toLowerCase();
  if (t.includes("double-free") || t.includes("double free")) return "double-free";
  if (t.includes("memory leak") || t.includes("detected memory leaks")) return "memory-leak";
  if (t.includes("segv") || t.includes("segmentation")) return "SEGV";
  if (t.includes("null")) return "null-deref";
  if (t.includes("out-of-memory") || t.includes("allocation size")) return "out-of-memory";
  if (t.includes("assert")) return "assertion";
  return t.replace(/\s+/g, "-");
}

/** Best-effort bug class from a finding's crash text (sanitizer + summary). */
function deriveBugClass(f: FenrirFinding): string {
  const o = f as Record<string, unknown>;
  const blob = [
    f.crash?.sanitizerOutput,
    f.crash?.generatedDescription,
    f.description,
    Array.isArray(o.match) ? (o.match as unknown[]).join(" ") : "",
  ]
    .filter(Boolean)
    .join("  ")
    .toLowerCase();
  for (const c of BUG_CLASSES) if (blob.includes(c.toLowerCase())) return normBugClass(c);
  return "crash";
}

/** Format one crash frame as `function::module` from an unknown-shaped value. */
function frameLabel(frame: unknown): string {
  if (!frame) return "";
  if (typeof frame === "string") return frame.trim();
  if (typeof frame === "object") {
    const o = frame as Record<string, unknown>;
    const fn = pickStr(o, ["function", "func", "name", "symbol", "frame", "method"]) || "";
    const modRaw = pickStr(o, ["module", "file", "fileName", "source", "unit"]) || "";
    const mod = modRaw ? modRaw.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, "") : "";
    return fn && mod ? `${fn}::${mod}` : fn || mod;
  }
  return "";
}

/** The crashing call site, best-effort: top crash frames (outer → inner), else
 *  parsed from the generated summary, else the harness name. */
function crashLocation(f: FenrirFinding): string {
  const frames = f.crash?.crashFrames;
  if (Array.isArray(frames) && frames.length) {
    const labels = frames.map(frameLabel).filter(Boolean);
    if (labels.length) return labels.slice(0, 2).reverse().join(" → ");
  }
  const text = `${f.crash?.generatedDescription ?? ""} ${f.description ?? ""}`;
  const paren = text.match(/\b([A-Za-z_][A-Za-z0-9_]+)\s*\(([^)]*\.[ch][a-z]*)\)/);
  if (paren) {
    const mod = paren[2].split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, "");
    return `${paren[1]}::${mod}`;
  }
  const thru = text.match(/\b(?:reached through|through|via|in)\s+([A-Za-z_][A-Za-z0-9_]{2,})/);
  if (thru) return thru[1];
  return f.harnessName || "";
}

/** bug class + crash location for the compact task row. */
function findingTitle(f: FenrirFinding): { bugClass: string; location: string } {
  return { bugClass: deriveBugClass(f), location: crashLocation(f) };
}

/** A slim segmented meter that fills to a FenrirProgress: green done, a pulsing
 *  sky cell at the frontier while active, red if the pipeline failed. */
function StageMeter({ progress, cells = 9 }: { progress: FenrirProgress; cells?: number }) {
  const filled = progress.percent <= 0 ? 0 : Math.max(1, Math.round(progress.percent * cells));
  return (
    <div
      className="flex shrink-0 items-center gap-[3px]"
      title={progress.steps.map((s) => `${s.label}: ${s.state}`).join("  ·  ")}
      aria-label={`progress: ${progress.currentLabel}`}
    >
      {Array.from({ length: cells }).map((_, i) => {
        let cls = "bg-neutral-700";
        if (i < filled)
          cls = progress.failed ? "bg-red-500" : progress.warn ? "bg-amber-500" : "bg-emerald-500";
        else if (i === filled && progress.active) cls = "bg-sky-400 animate-pulse";
        else if (i === filled && progress.failed) cls = "bg-red-500";
        return <span key={i} className={`h-1.5 w-2.5 rounded-sm ${cls}`} />;
      })}
    </div>
  );
}

/** For a too-easy finding, which gate flagged it and its solve count: the Sonnet
 *  pre-filter (Quick Screen) if it never reached the probe, otherwise the GPT-5.5
 *  difficulty probe. */
function probeFailure(
  f: FenrirFinding
): { stage: "Sonnet" | "Difficulty"; passed: number; total: number } | null {
  const dp = (f as unknown as Record<string, unknown>).difficultyProbe as
    | Record<string, unknown>
    | undefined;
  if (!dp || typeof dp !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const opusTrials = num(dp.opusTrialCount);
  if (opusTrials > 0)
    return { stage: "Difficulty", passed: num(dp.opusPassCount), total: opusTrials };
  const sonnetTrials = num(dp.sonnetTrialCount);
  if (sonnetTrials > 0)
    return { stage: "Sonnet", passed: num(dp.sonnetPassCount), total: sonnetTrials };
  return null;
}

/** Format the difficulty-probe result + coaching from the finding's real
 *  `difficultyProbe` object: band, Sonnet pre-filter, GPT-5.5 probe, and the
 *  "why too easy / how to make it land in band" coaching summary. */
function difficultyProbeText(f: FenrirFinding): string[] {
  const dp = (f as unknown as Record<string, unknown>).difficultyProbe as
    | Record<string, unknown>
    | undefined;
  if (!dp || typeof dp !== "object") return [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const band = str(dp.band);
  const model = str(dp.model);
  const bandLabel =
    band === "too_easy" ? "Too easy" : band === "in_band" ? "In band" : band || "result";
  const lines: string[] = [`Difficulty probe — ${bandLabel}${model ? ` (${model})` : ""}`];
  const st = num(dp.sonnetTrialCount);
  if (st) lines.push(`  Sonnet pre-filter: ${num(dp.sonnetPassCount) ?? 0}/${st} solved`);
  const ot = num(dp.opusTrialCount);
  if (ot) lines.push(`  GPT-5.5 probe: ${num(dp.opusPassCount) ?? 0}/${ot} solved`);
  const cs = dp.coachingSummary as Record<string, unknown> | undefined;
  if (cs && typeof cs === "object") {
    if (str(cs.whyTooEasy)) lines.push(`Why it was too easy: ${str(cs.whyTooEasy)}`);
    if (str(cs.howToAdjust)) lines.push(`How to make it land in band: ${str(cs.howToAdjust)}`);
  }
  return lines;
}

/** Text form of a task's review feedback: rejection OR "too easy" (with the
 *  GPT-5.5 difficulty-probe ratio + coaching). */
function findingFeedbackText(f: FenrirFinding): string {
  const o = f as Record<string, unknown>;
  const rejected = isRejected(f);
  const probes = collectProbes(f);
  const blob = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${f.step ?? ""}`.toLowerCase();
  const tooEasy =
    !rejected &&
    (/too.?easy/.test(blob) ||
      probes.some((p) => p.total != null && (p.solved ?? 0) > Math.floor(p.total * 0.3)));
  const needsRevision = !rejected && !tooEasy && /revision|action required|needs/.test(blob);
  const lines: string[] = [];
  if (rejected) lines.push("Rejected");
  else if (tooEasy) lines.push("Too easy — make it harder");
  else if (needsRevision) lines.push("Needs revision");
  const why = pickStr(o, ["why", "whyRejected", "whyTooEasy", "whyEasy"]);
  const action = pickStr(o, [
    "whatToDo",
    "howToHarder",
    "howToMakeHarder",
    "harder",
    "remediation",
    "howToFix",
    "suggestion",
  ]);
  const generic = pickStr(o, [
    "feedback",
    "reviewFeedback",
    "review",
    "message",
    "statusMessage",
    "displayStatus",
    "reason",
    "rejectionReason",
    "note",
    "notes",
    "detail",
    "details",
    "verdict",
    "result",
  ]);
  if (generic) lines.push(generic);
  if (why) lines.push(`${rejected ? "Why" : "Why it was too easy"}: ${why}`);
  if (action) lines.push(`${rejected ? "What to do" : "How to make it land in band"}: ${action}`);
  const descReview = o.descriptionReview as { verdict?: string; notes?: string } | undefined;
  if (descReview && typeof descReview === "object" && (descReview.verdict || descReview.notes)) {
    lines.push(
      `Description review${descReview.verdict ? ` — ${descReview.verdict}` : ""}${
        descReview.notes ? `: ${descReview.notes}` : ""
      }`
    );
  }
  for (const line of difficultyProbeText(f)) lines.push(line);
  for (const p of probes) {
    const total = p.total ?? (p.trials.length || null);
    const solved = p.solved ?? p.trials.filter((t) => t.solved).length;
    lines.push(`${p.label}${p.model ? ` (${p.model})` : ""}: ${solved}/${total ?? "?"} solved`);
    p.trials.forEach((t, i) => lines.push(`  Trial ${i + 1} — ${t.solved ? "solved" : "failed"}`));
  }
  return lines.length ? lines.join("\n") : "(no review feedback)";
}

/** Every review/probe/trial field on a finding, serialized verbatim — this is
 *  what carries the full "why it was too easy / how to make it harder" text, the
 *  difficulty-probe breakdown, and each trial's transcript (how the agent solved
 *  it). Scanned by key so it survives whatever exact schema the API uses. */
function reviewRawDetails(f: FenrirFinding): string {
  const o = f as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (
      /probe|trial|review|verdict|reject|revision|feedback|easiness|band|filter|solved|whyEasy|whyTooEasy|howTo/i.test(
        k
      ) &&
      o[k] != null
    ) {
      picked[k] = o[k];
    }
  }
  try {
    return Object.keys(picked).length ? JSON.stringify(picked, null, 2) : "";
  } catch {
    return "";
  }
}

/** One task's info: crash summary, sanitizer output, review feedback, and the
 *  full raw review/probe/trial details. */
function findingCrashText(f: FenrirFinding): string {
  const head = `### ${f.id}${f.harnessName ? `  (${f.harnessName})` : ""}  [${
    f.status || "?"
  } / ${f.pipelineStage || "?"}]`;
  const summary = f.description || f.crash?.generatedDescription || "(none)";
  const san = f.crash?.sanitizerOutput || "(none)";
  const parts = [
    head,
    `## 1. Crash summary\n${summary}`,
    `## 2. Sanitizer output\n${san}`,
    `## 3. Review feedback\n${findingFeedbackText(f)}`,
  ];
  const raw = reviewRawDetails(f);
  if (raw) parts.push(`## 4. Full review details (probe + trials, raw)\n\`\`\`json\n${raw}\n\`\`\``);
  return parts.join("\n\n");
}

/** All tasks' 3-piece info for a repo, concatenated. */
function repoCrashText(repoLabel: string, findings: FenrirFinding[]): string {
  const sep = "\n\n" + "=".repeat(60) + "\n\n";
  return `# ${repoLabel} — ${findings.length} task(s)\n\n` + findings.map(findingCrashText).join(sep);
}

/** Button that copies text to the clipboard and flashes "Copied ✓". */
function CopyButton({
  text,
  label,
  title,
  disabled,
  className,
}: {
  text: string;
  label: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button
      onClick={copy}
      disabled={disabled || !text}
      title={title}
      className={
        className ||
        "rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
      }
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface ProbeView {
  label: string;
  solved: number | null;
  total: number | null;
  model: string | null;
  trials: { label: string; solved: boolean }[];
}

/** Pull difficulty-probe / pre-filter results off a finding (defensive). */
function collectProbes(f: FenrirFinding): ProbeView[] {
  const o = f as Record<string, unknown>;
  const out: ProbeView[] = [];
  const tryObj = (key: string, label: string) => {
    const p = o[key];
    if (!p || typeof p !== "object") return;
    const po = p as Record<string, unknown>;
    const solved = pickNum(po, ["solved", "solveCount", "passed", "successes", "solvedCount"]);
    const total = pickNum(po, ["total", "runs", "attempts", "runCount", "n"]);
    const model = pickStr(po, ["model", "name"]);
    const raw = Array.isArray(po.trials) ? po.trials : Array.isArray(po.runs) ? po.runs : [];
    const trials = raw.map((t, i) => {
      const to = (t || {}) as Record<string, unknown>;
      return {
        label: pickStr(to, ["label", "name"]) || `Trial ${i + 1}`,
        solved: Boolean(to.solved ?? to.success ?? to.passed),
      };
    });
    if (solved != null || total != null || trials.length)
      out.push({ label, solved, total, model, trials });
  };
  tryObj("difficultyProbe", "GPT-5.5 difficulty probe");
  tryObj("probe", "Difficulty probe");
  tryObj("preFilter", "Pre-filter");
  tryObj("prefilter", "Pre-filter");
  tryObj("easinessProbe", "Pre-filter");
  return out;
}

function ProbeBox({ p }: { p: ProbeView }) {
  const [open, setOpen] = useState(false);
  const total = p.total ?? (p.trials.length || null);
  const solved = p.solved ?? p.trials.filter((t) => t.solved).length;
  const pct = total ? Math.min(100, Math.round((solved / total) * 100)) : 0;
  return (
    <div className="mt-2 rounded border border-amber-900/50 bg-neutral-950/60 p-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-neutral-300">
          {p.label}
          {p.model ? <span className="text-neutral-500"> · {p.model}</span> : ""}
        </span>
        {total != null && <span className="text-amber-300">{solved}/{total}</span>}
      </div>
      {total != null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {p.trials.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] text-sky-400 hover:text-sky-300"
          >
            {open ? "Hide trials" : `See how the agent solved it (${p.trials.length})`}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5">
              {p.trials.map((t, i) => (
                <li key={i} className="text-[11px] text-neutral-400">
                  {t.label} —{" "}
                  <span className={t.solved ? "text-red-400" : "text-emerald-400"}>
                    {t.solved ? "solved" : "failed"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** AfterQuery-style review feedback box: Rejected / Needs revision / Too easy.
 *  Shows the server's verbatim message when present. */
function FindingFeedback({ f }: { f: FenrirFinding }) {
  const o = f as Record<string, unknown>;
  const blob = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${f.step ?? ""} ${
    typeof o.rejectionReason === "string" ? o.rejectionReason : ""
  }`.toLowerCase();
  const probes = collectProbes(f);
  const rejected = isRejected(f);
  // Real difficulty-probe schema (band + coaching), preferred over field guesses.
  const dp = o.difficultyProbe as Record<string, unknown> | undefined;
  const cs =
    dp && typeof dp === "object"
      ? (dp.coachingSummary as Record<string, unknown> | undefined)
      : undefined;
  const tooEasy =
    !rejected &&
    (dp?.band === "too_easy" ||
      /too.?easy/.test(blob) ||
      probes.some((p) => p.total != null && (p.solved ?? 0) > Math.floor(p.total * 0.3)));
  const needsRevision = !rejected && !tooEasy && /revision|action required|needs/.test(blob);

  // Prefer the real coaching summary; fall back to a wide field scan.
  const why =
    (cs && typeof cs.whyTooEasy === "string" ? cs.whyTooEasy : null) ||
    pickStr(o, ["why", "whyRejected", "whyTooEasy", "whyEasy"]);
  const action =
    (cs && typeof cs.howToAdjust === "string" ? cs.howToAdjust : null) ||
    pickStr(o, ["whatToDo", "howToHarder", "howToMakeHarder", "harder", "remediation", "howToFix", "suggestion"]);
  const message = pickStr(o, [
    "feedback",
    "reviewFeedback",
    "review",
    "message",
    "statusMessage",
    "displayStatus",
    "note",
    "notes",
    "detail",
    "details",
  ]);
  const probeSummary = (() => {
    if (!dp) return "";
    const parts: string[] = [];
    const band = typeof dp.band === "string" ? (dp.band === "too_easy" ? "Too easy" : dp.band) : "";
    if (band) parts.push(band);
    if (typeof dp.model === "string") parts.push(dp.model as string);
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    if (n(dp.sonnetTrialCount)) parts.push(`Sonnet ${n(dp.sonnetPassCount)}/${n(dp.sonnetTrialCount)}`);
    if (n(dp.opusTrialCount)) parts.push(`GPT-5.5 ${n(dp.opusPassCount)}/${n(dp.opusTrialCount)}`);
    return parts.length ? `Difficulty probe — ${parts.join(" · ")}` : "";
  })();

  if (!rejected && !tooEasy && !needsRevision && !message && !probes.length && !dp) return null;

  const heading = rejected
    ? "Rejected"
    : tooEasy
    ? "Too easy — but you can make it harder"
    : needsRevision
    ? "Needs revision"
    : "Review";

  return (
    <div className="mt-2 rounded border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs">
      <div className="font-medium text-amber-300">
        ⚠ {heading}
        {f.rejectionCount ? (
          <span className="text-amber-400/70"> · attempt {f.rejectionCount}</span>
        ) : null}
      </div>
      {probeSummary && (
        <div className="mt-1 text-[11px] font-medium text-amber-300/80">{probeSummary}</div>
      )}
      {(() => {
        const fail = probeFailure(f);
        if (!fail) return null;
        return (
          <div className="mt-1 text-amber-200/90">
            <span className="font-medium text-amber-300/90">Flagged too easy at: </span>
            {fail.stage === "Sonnet" ? "Sonnet pre-filter (Quick Screen)" : "GPT-5.5 difficulty probe"} — solved{" "}
            {fail.passed}/{fail.total}
          </div>
        );
      })()}
      {/* The reviewer's exact text first (most accurate), then parsed why/how. */}
      {message && <div className="mt-1 whitespace-pre-wrap text-amber-200/80">{message}</div>}
      {why && (
        <div className="mt-1 text-amber-200/80">
          <span className="font-medium text-amber-300/90">
            {rejected ? "Why: " : "Why it was too easy: "}
          </span>
          {why}
        </div>
      )}
      {action && (
        <div className="mt-1 text-amber-200/80">
          <span className="font-medium text-amber-300/90">
            {rejected ? "What to do: " : "How to make it land in band: "}
          </span>
          {action}
        </div>
      )}
      {!message && !why && !action && (
        <div className="mt-1 text-amber-200/70">
          {rejected
            ? "Revise the PoC / patch / description and re-submit."
            : tooEasy
            ? "Make the bug reach through a deeper, more intricate code path."
            : "Revise the task description below, then re-attach the patch and resubmit."}
        </div>
      )}
      {probes.map((p, i) => (
        <ProbeBox key={i} p={p} />
      ))}
    </div>
  );
}

type DetailState =
  | { submission: FenrirSubmission; findings: FenrirFinding[] }
  | "loading"
  | string
  | undefined;

/** The server occasionally returns the SAME finding id twice — e.g. an Approved
 *  row and a Rejected (deduped-twin) row for one bug — which makes any id-keyed
 *  diff flip-flop (Approved → Rejected → Approved …). Keep one canonical row per
 *  id: the most-settled state (a real Approved outweighs a duplicate Rejected),
 *  tie-broken by the latest updatedAt. Preserves first-seen order. */
function dedupeFindings(findings: FenrirFinding[]): FenrirFinding[] {
  const rank = (f: FenrirFinding) => {
    const b = `${f.status ?? ""} ${f.pipelineStage ?? ""}`.toLowerCase();
    if (/approv|accept|complet|review.?ready|very.?hard/.test(b)) return 4; // settled positive
    if (/await|action|verif|probe|dedup|bug_/.test(b)) return 3; // in progress
    if (/reject|fail/.test(b)) return 1; // negative
    return 2;
  };
  const best = new Map<string, FenrirFinding>();
  for (const f of findings) {
    const cur = best.get(f.id);
    if (
      !cur ||
      rank(f) > rank(cur) ||
      (rank(f) === rank(cur) && (f.updatedAt ?? "") > (cur.updatedAt ?? ""))
    )
      best.set(f.id, f);
  }
  const seen = new Set<string>();
  const out: FenrirFinding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(best.get(f.id)!);
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight at once — so a repo's
 *  patches submit concurrently (bounded) instead of one-at-a-time. Preserves
 *  "handle each once" semantics; errors inside fn are the caller's concern. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const isTerminalPositive = (f: FenrirFinding) =>
  /approv|accept|complet|review.?ready|very.?hard/i.test(`${f.status ?? ""} ${f.pipelineStage ?? ""}`);
const isTerminalNegative = (f: FenrirFinding) =>
  !isTerminalPositive(f) && /reject|fail/i.test(`${f.status ?? ""} ${f.pipelineStage ?? ""}`);

/** Merge a fresh poll into the previously-stored findings, keeping a settled
 *  state STICKY. The server intermittently reports an already-Approved finding
 *  as Rejected and back (its dedup pipeline racing), which otherwise makes every
 *  count and the activity log flip-flop A→R→A forever. Once a finding is
 *  terminal-positive (Approved/completed) we ignore a later regression to
 *  Rejected/failed; every other update (progress, or an upgrade to positive)
 *  passes through. */
function mergeFindings(prev: FenrirFinding[], incoming: FenrirFinding[]): FenrirFinding[] {
  const prevById = new Map(prev.map((f) => [f.id, f]));
  return dedupeFindings(incoming).map((next) => {
    const old = prevById.get(next.id);
    if (old && isTerminalPositive(old) && isTerminalNegative(next)) return old; // ignore regression
    return next;
  });
}

export default function Fenrir({ manualToken }: { manualToken: string }) {
  const [subs, setSubs] = useState<FenrirSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>(""); // id currently acting on
  // Repo-level bulk actions in flight (keys like "bulk-patch:<id>"). A Set so
  // concurrent bulk actions on DIFFERENT repos don't clobber each other — a
  // single string let repo B's click clear repo A's busy state.
  const [bulkBusy, setBulkBusy] = useState<Set<string>>(new Set());
  // Safety-net timers so a bulk key can NEVER stay set forever (a hung request
  // otherwise leaves the button stuck on "…" and every delete disabled). Each
  // key auto-clears after BULK_MAX_MS unless endBulk clears it first.
  const bulkTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clearBulkKey = useCallback((key: string) => {
    const t = bulkTimers.current.get(key);
    if (t) {
      clearTimeout(t);
      bulkTimers.current.delete(key);
    }
    setBulkBusy((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const startBulk = useCallback(
    (key: string) => {
      setBulkBusy((prev) => new Set(prev).add(key));
      const existing = bulkTimers.current.get(key);
      if (existing) clearTimeout(existing);
      bulkTimers.current.set(key, setTimeout(() => clearBulkKey(key), BULK_MAX_MS));
    },
    [clearBulkKey]
  );
  const endBulk = clearBulkKey;
  // Self-heal: every few seconds drop any bulkBusy key that has NO backing timer.
  // A real in-flight op always registers a timer in startBulk; a key without one
  // is stale (e.g. left over from an old hung request, preserved across a hot
  // reload) and would otherwise keep the delete UI stuck on "Deleting…" forever.
  useEffect(() => {
    const id = setInterval(() => {
      setBulkBusy((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const key of prev) {
          if (!bulkTimers.current.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 8000);
    return () => clearInterval(id);
  }, []);
  const [attn, setAttn] = useState<"all" | "action">("all");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Work folders (tabs) + the active one; tasks are scoped to its local repos.
  const [folders, setFolders] = useState<{ key: string; label: string }[]>([]);
  const [folder, setFolder] = useState<string>("");
  const [localNames, setLocalNames] = useState<Set<string>>(new Set());
  const [namesReady, setNamesReady] = useState(false);
  // "Only my repositories" — checked: show just repos with a matching local
  // folder; unchecked (default): show every submission the account has.
  const ONLY_LOCAL_KEY = "pluto.fenrir.onlyLocal";
  const [onlyLocal, setOnlyLocal] = useState(false);
  useEffect(() => {
    setOnlyLocal(localStorage.getItem(ONLY_LOCAL_KEY) === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem(ONLY_LOCAL_KEY, onlyLocal ? "1" : "0");
  }, [onlyLocal]);
  // "Overview" — show/hide the at-a-glance dashboard. Defaults to shown, so the
  // stored value is read as "hidden unless explicitly turned off".
  const OVERVIEW_KEY = "pluto.fenrir.showOverview";
  const [showOverview, setShowOverview] = useState(true);
  useEffect(() => {
    setShowOverview(localStorage.getItem(OVERVIEW_KEY) !== "0");
  }, []);
  useEffect(() => {
    localStorage.setItem(OVERVIEW_KEY, showOverview ? "1" : "0");
  }, [showOverview]);
  // Baseline of finding id → updatedAt, to flag NEW / MODIFIED tasks since you
  // last acknowledged them ("Mark seen").
  const SEEN_KEY = "pluto.fenrir.seen";
  const [seen, setSeen] = useState<Record<string, string>>({});
  // Archived repos: hidden from the active list so you only see the repos
  // you're still working on. Persisted locally; a toggle reveals the archive.
  const ARCHIVE_KEY = "pluto.fenrir.archived";
  const ACCEPTED_KEY = "pluto.fenrir.accepted";
  const FAVORITES_KEY = "pluto.fenrir.favorites";
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  // ♥ Favorited repos — a personal "important memory" bookmark, cross-bucket, so
  // you can find a repo again without recalling its exact name.
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  // Which bucket the list shows: working set, accepted, archived, or favorites.
  const [view, setView] = useState<"active" | "accepted" | "archived" | "favorites">("active");
  // Accepted-view band drill-down (click a ring to filter the repo list).
  const [acceptedBandFilter, setAcceptedBandFilter] = useState<string | null>(null);
  // The band filter is set by clicking a dashboard ring, so hiding the dashboard
  // would leave the repo list filtered by a control you can no longer see (and
  // can't clear). Drop the filter whenever the Overview is switched off.
  useEffect(() => {
    if (!showOverview) setAcceptedBandFilter(null);
  }, [showOverview]);
  // Findings reopened for a new patch this session (revise {kind:patch}); until
  // a finding is revised, its patch-submit buttons stay disabled.
  const [revised, setRevised] = useState<Set<string>>(new Set());
  const toggleArchive = useCallback((id: string) => {
    setArchived((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore quota */
      }
      return next;
    });
  }, []);
  const toggleAccepted = useCallback((id: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore quota */
      }
      return next;
    });
  }, []);
  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore quota */
      }
      return next;
    });
  }, []);
  // Which repos are expanded (default collapsed → compact list).
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggleOpen = useCallback(
    (id: string) =>
      setOpenIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
    []
  );

  // Auto-handler: auto-patch awaiting_patch findings from the local Fenrir/ folder.
  const AUTO_KEY = "pluto.fenrir.autoEnabled";
  const MAX_LOG = 600;
  const REVISE_KEY = "pluto.fenrir.autoRevise";
  const SUBMIT_KEY = "pluto.fenrir.autoSubmit";
  const POC_KEY = "pluto.fenrir.autoPoc";
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoRevise, setAutoRevise] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [autoPoc, setAutoPoc] = useState(false);
  const [log, setLog] = useState<{ t: number; text: string; sid?: string }[]>([]);
  const [showLog, setShowLog] = useState(false);
  /** findingIds already auto-patched this session (never auto-resubmit). */
  const handledRef = useRef<Set<string>>(new Set());
  /** Repo keys handled THIS session, so a poll tick doesn't re-queue something
   *  already in flight. The durable record lives server-side in
   *  .auto-submit-log.json — this is only a short-lived guard, never the
   *  authority (browser storage can't be trusted to outlive a cleared cache). */
  const autoSubmitDone = useRef<Set<string>>(new Set());
  /** Last "why nothing is queued" summary per handler, so the explanation is
   *  logged when it changes instead of every poll tick. */
  const autoIdleRef = useRef<Map<string, string>>(new Map());
  /** last seen "stage/status" per findingId, for change logging. */
  const prevStagesRef = useRef<Map<string, string>>(new Map());

  // `sid` tags the entry with its submission (repo) so each RepoCard can show
  // its own log. Finding-scoped messages start with "<submissionId>:…", so we
  // fall back to parsing that when no sid is passed.
  const pushLog = useCallback((text: string, sid?: string) => {
    // Finding-scoped messages embed "<submissionId>:<hash>" — pull the repo out
    // of the text when the caller didn't pass one explicitly.
    const owner = sid ?? text.match(/\b([A-Za-z0-9]{16,}):[a-z0-9:]+/)?.[1];
    setLog((l) => [{ t: Date.now(), text, sid: owner }, ...l].slice(0, MAX_LOG));
  }, []);

  // Load/persist the auto toggle.
  useEffect(() => {
    setAutoEnabled(localStorage.getItem(AUTO_KEY) === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem(AUTO_KEY, autoEnabled ? "1" : "0");
  }, [autoEnabled]);
  useEffect(() => {
    setAutoRevise(localStorage.getItem(REVISE_KEY) === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem(REVISE_KEY, autoRevise ? "1" : "0");
  }, [autoRevise]);
  useEffect(() => {
    setAutoSubmit(localStorage.getItem(SUBMIT_KEY) === "1");
    // No done-set to restore: what has been submitted is read from the server
    // ledger on every poll, so there is exactly one source of truth.
    localStorage.removeItem("pluto.fenrir.autoSubmitDone"); // drop the old copy
  }, []);
  useEffect(() => {
    localStorage.setItem(SUBMIT_KEY, autoSubmit ? "1" : "0");
  }, [autoSubmit]);
  useEffect(() => {
    setAutoPoc(localStorage.getItem(POC_KEY) === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem(POC_KEY, autoPoc ? "1" : "0");
  }, [autoPoc]);

  // Load the configured work folders (tabs).
  useEffect(() => {
    fetch("/api/fenrir/folders", { method: "POST", cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.folders) && d.folders.length) {
          setFolders(d.folders);
          setFolder((cur) => cur || d.folders[0].key);
        }
      })
      .catch(() => {});
  }, []);

  // Load the NEW/MODIFIED baseline.
  useEffect(() => {
    try {
      setSeen(JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"));
    } catch {
      /* ignore corrupt */
    }
  }, []);

  // Load the archived-repo list.
  useEffect(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
      if (Array.isArray(arr)) setArchived(new Set(arr.filter((x) => typeof x === "string")));
    } catch {
      /* ignore corrupt */
    }
  }, []);

  // Load the accepted-repo list.
  useEffect(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(ACCEPTED_KEY) || "[]");
      if (Array.isArray(arr)) setAccepted(new Set(arr.filter((x) => typeof x === "string")));
    } catch {
      /* ignore corrupt */
    }
  }, []);

  // Load the ♥ favorites list.
  useEffect(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
      if (Array.isArray(arr)) setFavorites(new Set(arr.filter((x) => typeof x === "string")));
    } catch {
      /* ignore corrupt */
    }
  }, []);

  /** Re-read the active folder's repo names from disk. */
  const refreshLocalNames = useCallback(async () => {
    if (!folder) return;
    try {
      const res = await fetch("/api/fenrir/local-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
        cache: "no-store",
      });
      const d = await res.json();
      if (d.ok) {
        setLocalNames(new Set((d.names || []).map((n: string) => n.toLowerCase())));
        setNamesReady(true);
      }
    } catch {
      /* transient — the next tick retries */
    }
  }, [folder]);

  // Fetch the active folder's repo names, then KEEP re-reading them. The builder
  // creates <repo>_submission folders while the app is open, and this list gates
  // both the "Only my repositories" filter and every auto-handler's scope — so a
  // one-shot read meant a freshly created repo stayed invisible (and untouched by
  // the auto-handlers) until you reloaded the page.
  useEffect(() => {
    if (!folder) return;
    setNamesReady(false);
    void refreshLocalNames();
    const id = setInterval(() => void refreshLocalNames(), LOCAL_NAMES_POLL_MS);
    return () => clearInterval(id);
  }, [folder, refreshLocalNames]);


  const [me, setMe] = useState<{
    profile: FenrirProfile | null;
    github: FenrirGithubConnection | null;
    stats: Record<string, unknown> | null;
  } | null>(null);

  // Per-repo findings ("tasks"), keyed by submissionId. Loaded for every repo so
  // tasks always show beneath their repo (Silver-style), no expand needed.
  const [detail, setDetail] = useState<Record<string, DetailState>>({});

  const tokenBody = useMemo(
    () => JSON.stringify({ token: manualToken?.trim() || undefined }),
    [manualToken]
  );

  /** Fetch one repo's findings and merge in (no "loading" flash on refresh).
   *  Times out + retries, and on final failure KEEPS the last-good findings
   *  instead of blanking the repo to "Failed to fetch". */
  const loadDetail = useCallback(
    async (submissionId: string, markLoading = false) => {
      if (markLoading)
        setDetail((d) =>
          d[submissionId] && typeof d[submissionId] === "object"
            ? d
            : { ...d, [submissionId]: "loading" }
        );
      for (let attempt = 1; attempt <= DETAIL_ATTEMPTS; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT_MS);
        try {
          const res = await fetch("/api/fenrir/submission", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: manualToken?.trim() || undefined, submissionId }),
            cache: "no-store",
            signal: ctrl.signal,
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "Failed to load tasks");
          setDetail((d) => {
            const prevEntry = d[submissionId];
            const prevFindings =
              prevEntry && typeof prevEntry === "object" ? prevEntry.findings : [];
            return {
              ...d,
              [submissionId]: {
                submission: data.submission,
                findings: mergeFindings(
                  prevFindings,
                  Array.isArray(data.findings) ? data.findings : []
                ),
              },
            };
          });
          return; // success
        } catch (e) {
          if (attempt < DETAIL_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
            continue;
          }
          // Final failure — keep prior good data; only surface an error if this
          // repo never loaded (so a transient stall doesn't wipe the task list).
          setDetail((d) => {
            const prev = d[submissionId];
            if (prev && typeof prev === "object") return d;
            return { ...d, [submissionId]: (e as Error).message };
          });
        } finally {
          clearTimeout(timer);
        }
      }
    },
    [manualToken]
  );

  /** Load repos' findings with BOUNDED concurrency (each payload is large — 100s
   *  of KB). Archived repos are skipped unless `includeArchived`. */
  const loadAllDetails = useCallback(
    async (list: FenrirSubmission[], includeArchived = false) => {
      const targets = includeArchived ? list : list.filter((s) => !archived.has(s.id));
      await mapPool(targets, DETAIL_FETCH_CONCURRENCY, (s) => loadDetail(s.id));
    },
    [loadDetail, archived]
  );

  const loadInFlightRef = useRef(false);
  /** A refresh was requested while one was already running — run it once the
   *  current one finishes instead of dropping it. Without this, the refresh
   *  fired right after an auto-submit is silently discarded whenever it lands
   *  during the (slow, up to 45s) list poll, so the new repo doesn't appear
   *  until something else happens to reload the list. */
  const loadAgainRef = useRef(false);
  const loadFnRef = useRef<(includeArchived?: boolean) => void>(() => {});
  const load = useCallback(
    async (includeArchived = false) => {
      // Never let a poll tick pile up on a still-running load — the slow list
      // endpoint would otherwise accumulate overlapping 30s+ requests and clog
      // the pool so nothing refreshes. A manual Reload (includeArchived) still
      // forces through; anything else is coalesced into one follow-up run.
      if (loadInFlightRef.current && !includeArchived) {
        loadAgainRef.current = true;
        return;
      }
      loadInFlightRef.current = true;
      setErr("");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SUBMISSIONS_TIMEOUT_MS);
      try {
        const res = await fetch("/api/fenrir/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: tokenBody,
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to load Fenrir submissions");
        const list: FenrirSubmission[] = Array.isArray(data.submissions) ? data.submissions : [];
        setSubs(list);
        loadAllDetails(list, includeArchived); // fire-and-forget; merges as each resolves
      } catch (e) {
        setErr(
          (e as Error).name === "AbortError"
            ? "Submissions list is slow (AfterQuery) — will retry on the next refresh."
            : (e as Error).message
        );
      } finally {
        clearTimeout(timer);
        loadInFlightRef.current = false;
        setLoading(false);
        // Serve the refresh that arrived mid-flight (e.g. from an auto-submit).
        if (loadAgainRef.current) {
          loadAgainRef.current = false;
          setTimeout(() => loadFnRef.current(false), 0);
        }
      }
    },
    [tokenBody, loadAllDetails]
  );
  useEffect(() => {
    loadFnRef.current = load;
  }, [load]);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/fenrir/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: tokenBody,
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok) setMe({ profile: data.profile, github: data.github, stats: data.stats });
    } catch {
      /* header is best-effort */
    }
  }, [tokenBody]);

  // Mirror `subs`/`view` into refs so the detail-poll can read them without
  // re-subscribing the interval on every change.
  const subsRef = useRef<FenrirSubmission[]>([]);
  useEffect(() => {
    subsRef.current = subs;
  }, [subs]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // Auto-patch/revise act on EVERY repo with a local folder, whichever tab you're
  // on, so while either is enabled the poll must fetch every repo's tasks —
  // including archived ones the current tab doesn't show. Tracked in a ref so the
  // poll interval reads the live value without re-subscribing.
  const autoNeedsAllRef = useRef(false);
  useEffect(() => {
    autoNeedsAllRef.current = autoEnabled || autoRevise;
  }, [autoEnabled, autoRevise]);

  const detailPollBusy = useRef(false);
  useEffect(() => {
    load(false); // initial full load (list + details)
    loadMe();
    // Fast: refresh task states every POLL_MS. Archived repos are included while
    // the Archived/Favorites tab is open (so they update as you watch) and
    // whenever an auto-handler is on (so it can work in any tab).
    const detailId = setInterval(() => {
      if (detailPollBusy.current || !subsRef.current.length) return;
      detailPollBusy.current = true;
      void loadAllDetails(
        subsRef.current,
        viewRef.current === "archived" ||
          viewRef.current === "favorites" ||
          autoNeedsAllRef.current
      ).finally(() => {
        detailPollBusy.current = false;
      });
    }, POLL_MS);
    // Slow: re-fetch the submission LIST occasionally (that endpoint is slow).
    const listId = setInterval(() => load(false), LIST_POLL_MS);
    return () => {
      clearInterval(detailId);
      clearInterval(listId);
    };
  }, [load, loadMe, loadAllDetails]);

  // Load every repo's tasks immediately when you open the archived/favorites tabs
  // or switch an auto-handler on — don't make it wait up to POLL_MS for the first
  // tick. After that the detail-poll keeps them live.
  useEffect(() => {
    const needAll = view === "archived" || view === "favorites" || autoEnabled || autoRevise;
    if (needAll && subsRef.current.length) void loadAllDetails(subsRef.current, true);
  }, [view, autoEnabled, autoRevise, loadAllDetails]);

  // Auto-clear the inline action message.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  /** POST to any Fenrir route, then refresh the list (and one repo's tasks). */
  const postTo = useCallback(
    async (
      url: string,
      payload: Record<string, unknown>,
      refreshId?: string,
      busyKey?: string
    ): Promise<boolean> => {
      setBusy(busyKey ?? String(payload.submissionId || payload.findingId || url));
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: manualToken?.trim() || undefined, ...payload }),
          cache: "no-store",
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Request failed");
        await load();
        if (refreshId) await loadDetail(refreshId);
        setMsg({ text: "✓ Done", ok: true });
        return true;
      } catch (e) {
        setMsg({ text: (e as Error).message, ok: false });
        return false;
      } finally {
        setBusy("");
      }
    },
    [manualToken, load, loadDetail]
  );

  const act = useCallback(
    (payload: Record<string, unknown>, refreshId?: string) =>
      postTo("/api/fenrir/action", payload, refreshId),
    [postTo]
  );

  /** Auto-patch one finding from the local Fenrir/ folder. `index` is the
   *  finding's position in the repo's findings list (maps to fenrir.map.json). */
  const autoPatchOne = useCallback(
    async (s: FenrirSubmission, f: FenrirFinding, index: number): Promise<"ok" | "retry" | "skip"> => {
      const repoName = s.repoName || "";
      pushLog(`auto-patch ${f.id} (${repoName || s.id})…`, s.id);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
      try {
        const res = await fetch("/api/fenrir/auto-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: manualToken?.trim() || undefined,
            submissionId: s.id,
            findingId: f.id,
            findingIndex: index,
            repoName,
            folder,
            // Crash signature for robust patch↔finding matching (map `match`).
            // Include crashFrames — the crashing function symbol (e.g. an
            // `op_*` name) often lives there, not in the sanitizer text.
            crashText: [
              f.crash?.sanitizerOutput,
              f.crash?.generatedDescription,
              Array.isArray(f.crash?.crashFrames) ? JSON.stringify(f.crash?.crashFrames) : "",
              f.harnessName,
              f.description,
            ]
              .filter(Boolean)
              .join(" "),
          }),
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (!data.ok) {
          pushLog(`✗ ${f.id}: ${data.error}`, s.id);
          setMsg({ text: `patch ${f.id}: ${data.error}`, ok: false });
          // A resolution/validation failure won't fix on retry; an AfterQuery /
          // network error might, so let it retry.
          return /no patch|no local folder|no prepared submission|no crash text|no \.patch|refus|not found/i.test(
            data.error || ""
          )
            ? "skip"
            : "retry";
        }
        pushLog(
          `✓ ${f.id}: ${data.patchFileName} (${data.via})` +
            (data.described ? " + description" : " · ⚠ no description") +
            (data.descWarn ? ` · ⚠ ${data.descWarn}` : ""),
          s.id
        );
        setMsg({
          text: `patched ${f.id} → ${data.patchFileName}${data.described ? " + desc" : " (no desc!)"}`,
          ok: true,
        });
        return "ok";
      } catch (e) {
        const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
        pushLog(`✗ ${f.id}: ${msg}`, s.id);
        setMsg({ text: `patch ${f.id}: ${msg}`, ok: false });
        return "retry"; // transient — allow the loop to try again
      } finally {
        clearTimeout(timer);
      }
    },
    [manualToken, pushLog, folder]
  );

  /** Explain (once per change) why an enabled auto-handler queued nothing. The
   *  handlers act on every repo that has a matching local folder, so silence is
   *  ambiguous — this turns "it isn't working" into a specific reason in the Log. */
  const reportAutoIdle = useCallback(
    (
      handler: string,
      list: FenrirSubmission[],
      inScope: (s: FenrirSubmission) => boolean,
      candidate: (f: FenrirFinding) => boolean
    ) => {
      const scoped = list.filter(inScope);
      // Repos whose tasks haven't loaded yet can't be judged — call that out
      // rather than reporting "nothing eligible" for a repo we simply can't see.
      const unloaded = scoped.filter((s) => {
        const d = detail[s.id];
        return !(d && typeof d === "object");
      }).length;
      const tasks = scoped.reduce((n, s) => {
        const d = detail[s.id];
        return n + (d && typeof d === "object" ? d.findings.filter(candidate).length : 0);
      }, 0);
      const summary = !list.length
        ? "no repos loaded yet"
        : !scoped.length
        ? `0 of ${list.length} repos have a matching local folder in this tab`
        : unloaded === scoped.length
        ? `${scoped.length} repo(s) in scope but their tasks haven't loaded yet`
        : `${scoped.length} repo(s) in scope · ${tasks} task(s) eligible, all already handled` +
          (unloaded ? ` · ${unloaded} repo(s) still loading` : "");
      if (autoIdleRef.current.get(handler) === summary) return; // unchanged — stay quiet
      autoIdleRef.current.set(handler, summary);
      pushLog(`${handler} idle: ${summary}`);
    },
    [detail, pushLog]
  );

  // Auto-patch work queue, drained at AUTO_PATCH_CONCURRENCY at a time so a burst
  // of awaiting findings (e.g. 37 at once after Submit PoCs) can't fire dozens of
  // concurrent requests and starve deletes / detail fetches (→ "Failed to fetch").
  const autoPatchQueue = useRef<{ s: FenrirSubmission; f: FenrirFinding; i: number }[]>([]);
  const autoPatchActive = useRef(0);
  const autoPatchFails = useRef<Map<string, number>>(new Map());
  const drainAutoPatchRef = useRef<() => void>(() => {});
  useEffect(() => {
    drainAutoPatchRef.current = () => {
      while (autoPatchActive.current < AUTO_PATCH_CONCURRENCY && autoPatchQueue.current.length) {
        const item = autoPatchQueue.current.shift()!;
        autoPatchActive.current++;
        void autoPatchOne(item.s, item.f, item.i)
          .then((status) => {
            if (status === "ok" || status === "skip") return; // settled — stay handled
            // Transient failure: forget it so the next poll re-queues, up to a cap.
            const n = (autoPatchFails.current.get(item.f.id) || 0) + 1;
            autoPatchFails.current.set(item.f.id, n);
            if (n < AUTO_PATCH_MAX_RETRIES) handledRef.current.delete(item.f.id);
            else pushLog(`⚠ ${item.f.id}: auto-patch gave up after ${n} tries`, item.s.id);
          })
          .finally(() => {
            autoPatchActive.current--;
            drainAutoPatchRef.current();
          });
      }
    };
  }, [autoPatchOne, pushLog]);

  // Log stage changes, and (when enabled) auto-patch awaiting_patch findings once.
  useEffect(() => {
    const pairs: { s: FenrirSubmission; f: FenrirFinding; i: number }[] = [];
    for (const s of subs) {
      const d = detail[s.id];
      if (d && typeof d === "object") d.findings.forEach((f, i) => pairs.push({ s, f, i }));
    }
    for (const { s, f } of pairs) {
      const stage = `${f.pipelineStage || "?"}/${f.status || "?"}`;
      const prev = prevStagesRef.current.get(f.id);
      if (prev !== undefined && prev !== stage) pushLog(`${f.id}: ${prev} → ${stage}`, s.id);
      prevStagesRef.current.set(f.id, stage);
    }
    // Only auto-patch once the active folder's repo names are loaded, and only
    // for repos that actually exist in that folder.
    if (!autoEnabled || !namesReady) return;
    const inScope = (s: FenrirSubmission) =>
      !!(s.repoName && localNames.has(s.repoName.toLowerCase()));
    let queued = false;
    for (const { s, f, i } of pairs) {
      // Use EXACTLY the manual "Patch repo" rule (findingPatchable +
      // findingBuildVerified + revise-first), not a looser status check. The old
      // `findingNeedsAction` test fired while a PoC was still validating/fuzzing
      // and on tasks the server keeps locked until they're revised — both get
      // rejected, and a rejected patch burns one of the task's few attempts.
      if (!findingPatchable(f) || !findingBuildVerified(f)) continue;
      if (findingNeedsRevision(f) && !revised.has(f.id)) continue; // revise first
      if (!inScope(s)) continue; // repo must have a local folder with prepared patches
      if (handledRef.current.has(f.id)) continue;
      handledRef.current.add(f.id); // mark before awaiting → never double-submit
      autoPatchQueue.current.push({ s, f, i }); // enqueue; drained at a bounded rate
      queued = true;
    }
    if (queued) drainAutoPatchRef.current();
    else reportAutoIdle("Auto-patch", subs, inScope, (f) => findingPatchable(f) && findingBuildVerified(f));
  }, [
    detail,
    subs,
    autoEnabled,
    autoPatchOne,
    pushLog,
    namesReady,
    localNames,
    revised,
    reportAutoIdle,
  ]);

  /** Submit every prepared PoC for a repo (each becomes its own task). */
  const submitPocs = useCallback(
    async (s: FenrirSubmission) => {
      const label = s.repoName || s.id;
      if (!s.repoName) {
        const m = `${label}: submission has no repoName`;
        pushLog(`✗ PoC ${m}`, s.id);
        setMsg({ text: m, ok: false });
        return;
      }
      pushLog(`submit PoCs for ${label}…`, s.id);
      setMsg({ text: `Submitting PoCs for ${label}…`, ok: true });
      const pocBulkKey = `bulk-poc:${s.id}`;
      startBulk(pocBulkKey);
      try {
        // Hashes of PoCs already submitted for this repo (its findings) — the
        // server keys a finding by sha256(poc)[:16], carried in the finding id.
        const dd = detail[s.id];
        const known = dd && typeof dd === "object" ? dd.findings : [];
        const skipHashes = known
          .map((f) => (String(f.id).match(/([0-9a-f]{16})$/i) || [])[1]?.toLowerCase())
          .filter((h): h is string => !!h);
        const res = await fetch("/api/fenrir/auto-poc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: manualToken?.trim() || undefined,
            submissionId: s.id,
            repoName: s.repoName,
            folder,
            skipHashes,
          }),
          cache: "no-store",
        });
        const data = await res.json();
        if (!data.ok) {
          pushLog(`✗ PoC ${label}: ${data.error}`, s.id);
          setMsg({ text: `PoC ${label}: ${data.error}`, ok: false });
          return;
        }
        const results: {
          ok?: boolean;
          fileName?: string;
          error?: string;
          status?: number;
          already?: boolean;
        }[] = Array.isArray(data.results) ? data.results : [];
        const newOk = results.filter((r) => r.ok);
        const already = results.filter((r) => !r.ok && r.already);
        const failed = results.filter((r) => !r.ok && !r.already);
        pushLog(
          `PoC ${label}: ${newOk.length} new` +
            (already.length ? `, ${already.length} already submitted` : "") +
            (failed.length ? `, ${failed.length} failed` : ""),
          s.id
        );
        // Per-PoC outcome — already-submitted is a benign skip (⤼), only real
        // errors are ✗.
        for (const r of results) {
          if (r.ok) pushLog(`  ✓ ${r.fileName}: submitted`, s.id);
          else if (r.already) pushLog(`  ⤼ ${r.fileName}: already submitted — skipped`, s.id);
          else pushLog(`  ✗ ${r.fileName}: ${r.status ? `[${r.status}] ` : ""}${r.error || "failed"}`, s.id);
        }
        setMsg({
          text:
            newOk.length || (!already.length && !failed.length)
              ? `PoC ${label}: ${newOk.length} new` +
                (already.length ? `, ${already.length} already` : "") +
                (failed.length ? `, ${failed.length} failed` : "")
              : failed.length
              ? `PoC ${label}: ${failed.length} failed, ${already.length} already`
              : `PoC ${label}: all ${already.length} already submitted`,
          ok: failed.length === 0,
        });
        await load();
      } catch (e) {
        pushLog(`✗ PoC ${label}: ${(e as Error).message}`, s.id);
        setMsg({ text: `PoC ${label}: ${(e as Error).message}`, ok: false });
      } finally {
        endBulk(pocBulkKey);
      }
    },
    [manualToken, load, pushLog, folder, startBulk, endBulk, detail]
  );


  /** Submit patches for every action-required task of one repo (manual — always
   *  attempts, even if a prior auto-run handled it). */
  const patchRepo = useCallback(
    async (s: FenrirSubmission) => {
      const d = detail[s.id];
      const findings = d && typeof d === "object" ? d.findings : [];
      const todo = findings
        .map((f, i) => ({ f, i }))
        // Skip tasks that still need revising first (submission stays locked
        // until you Revise them).
        .filter(
          ({ f }) =>
            findingPatchable(f) &&
            findingBuildVerified(f) &&
            !(findingNeedsRevision(f) && !revised.has(f.id))
        );
      if (!todo.length) {
        pushLog(`${s.repoName || s.id}: no patchable tasks (revise needs-revision tasks first)`, s.id);
        return;
      }
      const bulkKey = `bulk-patch:${s.id}`;
      startBulk(bulkKey);
      try {
        // Mark all up front so the auto-loop never double-submits, then submit
        // with bounded concurrency — serial submission of every finding (2 API
        // calls each) is what made a full repo take minutes.
        todo.forEach(({ f }) => handledRef.current.add(f.id));
        await mapPool(todo, PATCH_CONCURRENCY, async ({ f, i }) => {
          await autoPatchOne(s, f, i);
        });
        await load(); // one reload after the whole batch (not per patch)
      } finally {
        endBulk(bulkKey);
      }
    },
    [detail, autoPatchOne, pushLog, revised, startBulk, endBulk, load]
  );

  /** Submit the prepared (mapped) patch for ONE task. */
  const patchOne = useCallback(
    async (s: FenrirSubmission, f: FenrirFinding, i: number) => {
      handledRef.current.add(f.id);
      await autoPatchOne(s, f, i);
      await load(); // refresh this one task's state
    },
    [autoPatchOne, load]
  );

  /** Reopen ONE needs-revision task for a new patch (revise {kind:"patch"}).
   *  Required before its patch can be (re)submitted. */
  const revisePatch = useCallback(
    async (f: FenrirFinding): Promise<boolean> => {
      // Direct call with timeout + retry, and NO global reload — the caller
      // refreshes the repo once. (postTo used to reload the whole app after each
      // revise, so a repo's worth of revises = dozens of 100s-of-KB reloads.)
      let lastErr = "unknown error";
      for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
        try {
          const res = await fetch("/api/fenrir/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: manualToken?.trim() || undefined,
              action: "revise-finding-patch",
              findingId: f.id,
            }),
            cache: "no-store",
            signal: ctrl.signal,
          });
          const data = await res.json();
          if (data.ok) {
            setRevised((prev) => new Set(prev).add(f.id));
            // A revise REOPENS the task for a fresh patch, so forget any earlier
            // auto-patch attempt on it. Without this the id stays in handledRef
            // forever and auto-patch silently skips it — which is what broke the
            // advertised loop: needs-revision → revise → awaiting → patch.
            handledRef.current.delete(f.id);
            autoPatchFails.current.delete(f.id);
            return true;
          }
          lastErr = data.error || "failed";
        } catch (e) {
          lastErr = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
        } finally {
          clearTimeout(timer);
        }
        if (attempt < DELETE_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
      }
      pushLog(`✗ revise ${f.id}: ${lastErr} (after ${DELETE_ATTEMPTS} tries)`, f.submissionId);
      return false;
    },
    [manualToken, pushLog]
  );

  /** Revise every needs-revision task in a repo (bounded concurrency), then
   *  refresh this repo once — same robust shape as bulk delete. */
  const reviseRepo = useCallback(
    async (s: FenrirSubmission) => {
      const d = detail[s.id];
      const label = s.repoName || s.id;
      const findings = d && typeof d === "object" ? d.findings : [];
      const todo = findings.filter((f) => findingNeedsRevision(f) && !revised.has(f.id));
      if (!todo.length) {
        setMsg({ text: `${label}: nothing to revise`, ok: false });
        return;
      }
      const bulkKey = `bulk-revise:${s.id}`;
      startBulk(bulkKey);
      try {
        let ok = 0,
          failed = 0;
        await mapPool(todo, REVISE_CONCURRENCY, async (f) => {
          if (await revisePatch(f)) ok++;
          else failed++;
        });
        pushLog(
          `revised ${ok}/${todo.length} task(s) in ${label}${failed ? ` · ${failed} failed` : ""}`,
          s.id
        );
        setMsg({ text: `Revised ${ok}${failed ? ` · ${failed} failed` : ""}`, ok: failed === 0 });
        await loadDetail(s.id);
      } finally {
        endBulk(bulkKey);
      }
    },
    [detail, revised, revisePatch, startBulk, endBulk, loadDetail]
  );

  // ── Auto-revise: reopen needs-revision tasks for a new patch, bounded and
  //    retry-safe (same shape as auto-patch). Combined with Auto-patch it closes
  //    the loop: needs-revision → revise → awaiting_patch → auto-patch.
  const autoReviseQueue = useRef<{ s: FenrirSubmission; f: FenrirFinding }[]>([]);
  const autoReviseActive = useRef(0);
  const autoReviseHandled = useRef<Set<string>>(new Set());
  const autoReviseFails = useRef<Map<string, number>>(new Map());
  const drainAutoReviseRef = useRef<() => void>(() => {});
  useEffect(() => {
    drainAutoReviseRef.current = () => {
      while (autoReviseActive.current < REVISE_CONCURRENCY && autoReviseQueue.current.length) {
        const item = autoReviseQueue.current.shift()!;
        autoReviseActive.current++;
        void revisePatch(item.f)
          .then((ok) => {
            if (ok) return; // success — `revised` now excludes it
            // Transient failure (revisePatch already retried its request) — allow
            // a re-queue up to a cap so a blip doesn't strand the task.
            const n = (autoReviseFails.current.get(item.f.id) || 0) + 1;
            autoReviseFails.current.set(item.f.id, n);
            if (n < AUTO_PATCH_MAX_RETRIES) autoReviseHandled.current.delete(item.f.id);
            else pushLog(`⚠ ${item.f.id}: auto-revise gave up after ${n} tries`, item.s.id);
          })
          .finally(() => {
            autoReviseActive.current--;
            drainAutoReviseRef.current();
          });
      }
    };
  }, [revisePatch, pushLog]);

  useEffect(() => {
    if (!autoRevise || !namesReady) return;
    const inScope = (s: FenrirSubmission) =>
      !!(s.repoName && localNames.has(s.repoName.toLowerCase()));
    let queued = false;
    for (const s of subs) {
      if (!inScope(s)) continue; // repo must have a matching local folder
      const d = detail[s.id];
      const findings = d && typeof d === "object" ? d.findings : [];
      for (const f of findings) {
        if (!findingNeedsRevision(f)) continue;
        if (revised.has(f.id) || autoReviseHandled.current.has(f.id)) continue;
        autoReviseHandled.current.add(f.id); // mark before awaiting → no double-revise
        autoReviseQueue.current.push({ s, f });
        queued = true;
      }
    }
    if (queued) drainAutoReviseRef.current();
    else reportAutoIdle("Auto-revise", subs, inScope, findingNeedsRevision);
  }, [
    detail,
    subs,
    autoRevise,
    namesReady,
    localNames,
    revised,
    revisePatch,
    reportAutoIdle,
  ]);

  // ── Auto-PoC: submit each repo's prepared crashing inputs once its harness has
  //    built, so the pipeline runs unattended: submit → PoC → patch → revise.
  //    Uses the SAME gating as the manual "Submit PoCs" button — in particular it
  //    waits out `submissionBuildingHarness`, because PoCs sent while the harness
  //    is still building are rejected.
  const autoPocQueue = useRef<FenrirSubmission[]>([]);
  const autoPocActive = useRef(0);
  const autoPocHandled = useRef<Set<string>>(new Set());
  const autoPocFails = useRef<Map<string, number>>(new Map());
  const drainAutoPocRef = useRef<() => void>(() => {});

  /** Submit every prepared PoC for one repo. Returns "ok" when the repo is fully
   *  dealt with, "skip" when it can never succeed, "retry" for transient errors. */
  const autoPocOne = useCallback(
    async (s: FenrirSubmission): Promise<"ok" | "retry" | "skip"> => {
      const label = s.repoName || s.id;
      if (!s.repoName) return "skip";
      // Don't resend PoCs the account already has — the server keys a finding by
      // sha256(poc)[:16], which is carried in the finding id.
      const d = detail[s.id];
      const known = d && typeof d === "object" ? d.findings : [];
      const skipHashes = known
        .map((f) => (String(f.id).match(/([0-9a-f]{16})$/i) || [])[1]?.toLowerCase())
        .filter((h): h is string => !!h);
      pushLog(`auto-poc ${label}…`, s.id);
      try {
        const res = await fetch("/api/fenrir/auto-poc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: manualToken?.trim() || undefined,
            submissionId: s.id,
            repoName: s.repoName,
            folder,
            skipHashes,
          }),
          cache: "no-store",
        });
        const data = await res.json();
        if (!data.ok) {
          pushLog(`✗ auto-poc ${label}: ${data.error}`, s.id);
          // No prepared PoCs / no local folder / broken map won't fix on retry.
          return /no local folder|no prepared submission|no PoC|could not read|fenrir\.map/i.test(
            data.error || ""
          )
            ? "skip"
            : "retry";
        }
        const results: { ok?: boolean; already?: boolean; fileName?: string; error?: string }[] =
          Array.isArray(data.results) ? data.results : [];
        const sent = results.filter((r) => r.ok).length;
        const already = results.filter((r) => !r.ok && r.already).length;
        const failed = results.filter((r) => !r.ok && !r.already).length;
        pushLog(
          `auto-poc ${label}: ${sent} new` +
            (already ? `, ${already} already` : "") +
            (failed ? `, ${failed} failed` : ""),
          s.id
        );
        if (sent) void load(false); // the new tasks should show up
        // Any outright failure → let it retry; otherwise this repo is done.
        return failed ? "retry" : "ok";
      } catch (e) {
        pushLog(`✗ auto-poc ${label}: ${(e as Error).message}`, s.id);
        return "retry";
      }
    },
    [manualToken, folder, detail, pushLog, load]
  );

  useEffect(() => {
    drainAutoPocRef.current = () => {
      while (autoPocActive.current < AUTO_POC_CONCURRENCY && autoPocQueue.current.length) {
        const s = autoPocQueue.current.shift()!;
        autoPocActive.current++;
        void autoPocOne(s)
          .then((status) => {
            if (status === "ok" || status === "skip") return; // settled
            const n = (autoPocFails.current.get(s.id) || 0) + 1;
            autoPocFails.current.set(s.id, n);
            if (n < AUTO_PATCH_MAX_RETRIES) autoPocHandled.current.delete(s.id);
            else pushLog(`⚠ ${s.repoName || s.id}: auto-poc gave up after ${n} tries`, s.id);
          })
          .finally(() => {
            autoPocActive.current--;
            drainAutoPocRef.current();
          });
      }
    };
  }, [autoPocOne, pushLog]);

  useEffect(() => {
    if (!autoPoc || !namesReady) return;
    const inScope = (s: FenrirSubmission) =>
      !!(s.repoName && localNames.has(s.repoName.toLowerCase()));
    let queued = false;
    let building = 0;
    for (const s of subs) {
      if (!inScope(s)) continue;
      if (autoPocHandled.current.has(s.id)) continue;
      const d = detail[s.id];
      if (!(d && typeof d === "object")) continue; // tasks not loaded yet — can't judge
      // Same lock as the manual button: PoCs sent mid-build are rejected.
      if (submissionBuildingHarness(s, d.findings)) {
        building++;
        continue;
      }
      autoPocHandled.current.add(s.id); // mark before awaiting → never double-send
      autoPocQueue.current.push(s);
      queued = true;
    }
    if (queued) drainAutoPocRef.current();
    else {
      // Same change-guarded reporting as the other handlers, so a repo sitting in
      // its ~3-min build window doesn't write a line on every poll tick.
      const scoped = subs.filter(inScope).length;
      const summary = !scoped
        ? `0 of ${subs.length} repos have a matching local folder in this tab`
        : building
        ? `${building} repo(s) still building their harness — PoCs sent now would be rejected`
        : `${scoped} repo(s) in scope, all already handled`;
      if (autoIdleRef.current.get("Auto-PoC") !== summary) {
        autoIdleRef.current.set("Auto-PoC", summary);
        pushLog(`Auto-PoC idle: ${summary}`);
      }
    }
  }, [autoPoc, namesReady, localNames, subs, detail, pushLog]);

  // ── Auto-submit: intake repos the builder has finished and recorded in the work
  //    folder's updates.json ("<repoUrl>, <ref>" per entry). Same shape as the
  //    other auto-handlers — opt-in, bounded, once per repo, retry-capped. This
  //    is the front of the pipeline: submit → fuzz → poc → patch.
  const autoSubmitQueue = useRef<{ repoUrl: string; ref: string; key: string }[]>([]);
  const autoSubmitActive = useRef(0);
  const autoSubmitFails = useRef<Map<string, number>>(new Map());
  const drainAutoSubmitRef = useRef<() => void>(() => {});

  /** Mark a repo as submitted WITHOUT sending it — used when it's already on the
   *  account, so deleting it later can't make it look new again. */
  const recordAlreadyOnServer = useCallback(
    async (item: { repoUrl: string; ref: string; key: string }) => {
      autoSubmitDone.current.add(item.key); // in-memory guard for this session
      try {
        await fetch("/api/fenrir/auto-submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: item.repoUrl,
            ref: item.ref,
            markOnly: true,
            via: "already-on-server",
          }),
          cache: "no-store",
        });
        pushLog(`= ${item.key}: already on the account — recorded, won't resubmit`);
      } catch {
        autoSubmitDone.current.delete(item.key); // failed to persist — retry later
      }
    },
    [pushLog]
  );

  /**
   * Make a just-submitted repo appear without a page reload.
   *
   * Two things have to catch up, and neither is instant: AfterQuery needs a
   * moment before the new repo shows in the submissions list, and its local
   * <repo>_submission folder gates the "Only my repositories" filter. So refresh
   * both, then retry on a short backoff until the repo actually shows up rather
   * than assuming one round-trip was enough.
   */
  const afterSubmitRefresh = useCallback(
    async (key: string) => {
      const delays = [0, 2_000, 5_000, 10_000, 20_000];
      for (const wait of delays) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        await Promise.all([refreshLocalNames(), load(false)]);
        const here = subsRef.current.some(
          (s) => s.repoUrl && normalizeRepoUrl(s.repoUrl) === key
        );
        if (here) {
          pushLog(`↻ ${key} now showing in the dashboard`);
          return;
        }
      }
      // Not fatal — the 60s list poll will pick it up; say so instead of leaving
      // the user wondering why a submitted repo isn't on screen.
      pushLog(`↻ ${key} submitted but not listed yet — will appear on the next refresh`);
    },
    [refreshLocalNames, load, pushLog]
  );

  /** Submit one repo URL for fuzzing. The server route records it in the durable
   *  ledger as part of the same call, so a success can never go unrecorded. */
  const autoSubmitOne = useCallback(
    async (item: { repoUrl: string; ref: string; key: string }): Promise<boolean> => {
      pushLog(`auto-submit ${item.key} (${item.ref})…`);
      try {
        const res = await fetch("/api/fenrir/auto-submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: manualToken?.trim() || undefined,
            repoUrl: item.repoUrl,
            ref: item.ref,
            intakeChoice: "submit_poc",
          }),
          cache: "no-store",
        });
        const data = await res.json();
        if (data.ok) {
          pushLog(
            data.duplicate
              ? `= ${item.key}: already on the account — recorded`
              : `✓ submitted ${item.key} → ${data.submission?.id ?? "ok"}`
          );
          return true;
        }
        pushLog(`✗ auto-submit ${item.key}: ${data.error || "failed"}`);
        return false;
      } catch (e) {
        pushLog(`✗ auto-submit ${item.key}: ${(e as Error).message}`);
        return false;
      }
    },
    [manualToken, pushLog]
  );

  useEffect(() => {
    drainAutoSubmitRef.current = () => {
      while (autoSubmitActive.current < AUTO_SUBMIT_CONCURRENCY && autoSubmitQueue.current.length) {
        const item = autoSubmitQueue.current.shift()!;
        autoSubmitActive.current++;
        void autoSubmitOne(item)
          .then((ok) => {
            if (ok) {
              // The server route already wrote the durable record; this is just
              // the in-session guard so the next poll doesn't re-queue it before
              // the ledger read comes back.
              autoSubmitDone.current.add(item.key);
              void afterSubmitRefresh(item.key);
              return;
            }
            // Transient failure — allow a bounded number of re-queues so a blip
            // doesn't strand a finished repo, then give up and leave it for the
            // manual path. NOT recorded as submitted: it never was.
            const n = (autoSubmitFails.current.get(item.key) || 0) + 1;
            autoSubmitFails.current.set(item.key, n);
            if (n >= AUTO_PATCH_MAX_RETRIES) {
              autoSubmitDone.current.add(item.key); // stop retrying every poll tick
              pushLog(
                `⚠ ${item.key}: auto-submit gave up after ${n} tries — not recorded, will retry on reload`
              );
            }
          })
          .finally(() => {
            autoSubmitActive.current--;
            drainAutoSubmitRef.current();
          });
      }
    };
  }, [autoSubmitOne, afterSubmitRefresh, pushLog]);

  // Poll updates.json and enqueue anything the durable ledger says we have NOT
  // submitted. The ledger — not the account's live repo list — is the authority:
  // a repo you deleted after it failed is gone from the account but still
  // recorded, so it is never sent again. Repos already on the account but not yet
  // recorded get recorded (not resubmitted), which closes the same hole for
  // anything submitted before this ledger existed or submitted by hand.
  const [updatesErr, setUpdatesErr] = useState<string | null>(null);
  const [updatesInfo, setUpdatesInfo] = useState<{ pending: number; recorded: number } | null>(null);
  useEffect(() => {
    if (!autoSubmit || !folder) {
      setUpdatesErr(null);
      setUpdatesInfo(null);
      return;
    }
    let stop = false;
    const tick = async () => {
      let data: {
        ok?: boolean;
        entries?: { repoUrl: string; ref: string; key: string; submitted?: boolean }[];
        error?: string;
        pending?: number;
        recorded?: number;
      };
      try {
        const res = await fetch("/api/fenrir/updates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder }),
          cache: "no-store",
        });
        data = await res.json();
      } catch {
        return; // transient — next tick retries
      }
      if (stop) return;
      if (!data.ok) {
        setUpdatesErr(data.error || "could not read updates.json");
        return;
      }
      setUpdatesErr(null);
      setUpdatesInfo({ pending: data.pending ?? 0, recorded: data.recorded ?? 0 });
      const live = new Set(
        subsRef.current.map((s) => (s.repoUrl ? normalizeRepoUrl(s.repoUrl) : "")).filter(Boolean)
      );
      const queued = new Set(autoSubmitQueue.current.map((q) => q.key));
      let added = false;
      for (const e of data.entries || []) {
        if (!e.key) continue;
        if (e.submitted) continue; // the ledger says we already sent it — done, forever
        if (autoSubmitDone.current.has(e.key) || queued.has(e.key)) continue;
        // On the account but not yet in the ledger (submitted by hand, or before
        // the ledger existed): record it instead of sending a duplicate. Without
        // this, deleting it later would make it look brand new.
        if (live.has(e.key)) {
          void recordAlreadyOnServer(e);
          continue;
        }
        autoSubmitQueue.current.push(e);
        queued.add(e.key);
        added = true;
        pushLog(`new repo in updates.json: ${e.key} (${e.ref})`);
      }
      if (added) drainAutoSubmitRef.current();
    };
    void tick();
    const id = setInterval(tick, UPDATES_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [autoSubmit, folder, pushLog, recordAlreadyOnServer]);

  /** Shared bulk-delete: deletes `targets` for one repo with bounded concurrency
   *  and a per-request timeout, so a slow/hung request can't freeze the batch.
   *  Classifies each outcome as deleted / locked (409 — mirror, in verification,
   *  approved) / failed, and reports a single clear summary. */
  const bulkDeleteFindings = useCallback(
    async (
      s: FenrirSubmission,
      targets: FenrirFinding[],
      opts: { noun: string; bulkKey: string; confirmMsg: string }
    ) => {
      const label = s.repoName || s.id;
      if (!targets.length) {
        setMsg({ text: `${label}: no ${opts.noun} to delete`, ok: false });
        return;
      }
      if (!confirm(opts.confirmMsg)) return;
      startBulk(opts.bulkKey);
      try {
        let deleted = 0,
          locked = 0,
          failed = 0;
        await mapPool(targets, DELETE_CONCURRENCY, async (f) => {
          // Retry transient failures (timeout / network / 5xx) — AfterQuery is
          // intermittently slow, and a single 20s hang shouldn't abandon a valid
          // delete. A 409 "locked" is definitive (no retry); a 404 means it's
          // already gone (count as deleted).
          let lastErr = "unknown error";
          for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
            try {
              const res = await fetch("/api/fenrir/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token: manualToken?.trim() || undefined,
                  action: "delete-finding",
                  findingId: f.id,
                }),
                cache: "no-store",
                signal: ctrl.signal,
              });
              const data = await res.json();
              if (data.ok || data.status === 404 || /not found|already removed/i.test(data.error || "")) {
                deleted++;
                return;
              }
              if (data.status === 409 || /can no longer be deleted|being processed|mirror/i.test(data.error || "")) {
                locked++;
                pushLog(`🔒 ${f.id}: locked (mirror / in verification / approved) — can't delete`, s.id);
                return;
              }
              lastErr = data.error || "failed"; // transient → retry
            } catch (e) {
              lastErr = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
            } finally {
              clearTimeout(timer);
            }
            if (attempt < DELETE_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
          }
          failed++;
          pushLog(`✗ delete ${f.id}: ${lastErr} (after ${DELETE_ATTEMPTS} tries)`, s.id);
        });
        const summary =
          `${deleted} deleted` +
          (locked ? ` · ${locked} locked` : "") +
          (failed ? ` · ${failed} failed` : "");
        pushLog(`${opts.noun}: ${summary} in ${label}`, s.id);
        setMsg({ text: `${opts.noun}: ${summary}`, ok: failed === 0 });
        // Refresh ONLY this repo (a global load() would sweep every repo).
        await loadDetail(s.id);
      } finally {
        endBulk(opts.bulkKey);
      }
    },
    [manualToken, loadDetail, pushLog, startBulk, endBulk]
  );

  /** Bulk-remove one KIND of task (rejected / needs-revision / awaiting) across
   *  every repo in `scope` — bounded concurrency, timeout, retry, then refresh
   *  only the repos it touched. `scope` is the same set the at-a-glance dashboard
   *  counted, so the Delete menu's numbers always match what actually gets
   *  deleted. Archived repos are skipped (they're excluded from that set too). */
  const cleanupFindings = useCallback(
    async (scope: FenrirSubmission[], scopeLabel: string, kind: CleanupKind) => {
      const spec = CLEANUP_KINDS[kind];
      const targets: { id: string; sid: string }[] = [];
      for (const s of scope) {
        if (archived.has(s.id)) continue;
        const d = detail[s.id];
        const findings = d && typeof d === "object" ? d.findings : [];
        for (const f of findings) if (spec.match(f)) targets.push({ id: f.id, sid: s.id });
      }
      if (!targets.length) {
        setMsg({ text: `No ${spec.noun} tasks to remove in ${scopeLabel} repos.`, ok: false });
        return;
      }
      if (!confirm(spec.confirm(targets.length, scopeLabel))) return;
      const bulkKey = `bulk-cleanup-${kind}-${scopeLabel}`;
      startBulk(bulkKey);
      try {
        let deleted = 0,
          locked = 0,
          failed = 0;
        await mapPool(targets, DELETE_CONCURRENCY, async (t) => {
          let lastErr = "unknown error";
          for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
            try {
              const res = await fetch("/api/fenrir/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token: manualToken?.trim() || undefined,
                  action: "delete-finding",
                  findingId: t.id,
                }),
                cache: "no-store",
                signal: ctrl.signal,
              });
              const data = await res.json();
              if (data.ok || data.status === 404 || /not found|already removed/i.test(data.error || "")) {
                deleted++;
                return;
              }
              if (data.status === 409 || /can no longer be deleted|being processed|mirror/i.test(data.error || "")) {
                locked++;
                return;
              }
              lastErr = data.error || "failed";
            } catch (e) {
              lastErr = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
            } finally {
              clearTimeout(timer);
            }
            if (attempt < DELETE_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
          }
          failed++;
          pushLog(`✗ delete ${t.id}: ${lastErr}`, t.sid);
        });
        const summary =
          `${deleted} removed` + (locked ? ` · ${locked} locked` : "") + (failed ? ` · ${failed} failed` : "");
        pushLog(
          `${scopeLabel} ${spec.noun} cleanup: ${summary} across ${
            new Set(targets.map((t) => t.sid)).size
          } repo(s)`
        );
        setMsg({ text: `${scopeLabel} ${spec.noun} cleanup: ${summary}`, ok: failed === 0 });
        await mapPool([...new Set(targets.map((t) => t.sid))], DETAIL_FETCH_CONCURRENCY, (sid) =>
          loadDetail(sid)
        );
      } finally {
        endBulk(bulkKey);
      }
    },
    [archived, detail, manualToken, pushLog, startBulk, endBulk, loadDetail]
  );

  /** Delete every rejected task in one repo. */
  const deleteRejected = useCallback(
    (s: FenrirSubmission) => {
      const d = detail[s.id];
      const rej = (d && typeof d === "object" ? d.findings : []).filter(isRejected);
      return bulkDeleteFindings(s, rej, {
        noun: "Rejected tasks",
        bulkKey: `bulk-delrej:${s.id}`,
        confirmMsg: `Delete ${rej.length} rejected task(s) in ${s.repoName || s.id}?`,
      });
    },
    [detail, bulkDeleteFindings]
  );

  /** Delete every needs-revision (too-easy) task in one repo. */
  const deleteRevision = useCallback(
    (s: FenrirSubmission) => {
      const d = detail[s.id];
      const rev = (d && typeof d === "object" ? d.findings : []).filter(findingRevisionWorthy);
      return bulkDeleteFindings(s, rev, {
        noun: "Needs-revision tasks",
        bulkKey: `bulk-delrev:${s.id}`,
        confirmMsg: `Delete ${rev.length} needs-revision task(s) in ${s.repoName || s.id}?`,
      });
    },
    [detail, bulkDeleteFindings]
  );

  /** Delete every FRESH awaiting-patch / Action-Required task in one repo. */
  const deleteAwaiting = useCallback(
    (s: FenrirSubmission) => {
      const d = detail[s.id];
      const aw = (d && typeof d === "object" ? d.findings : []).filter(findingAwaiting);
      return bulkDeleteFindings(s, aw, {
        noun: "Awaiting-patch tasks",
        bulkKey: `bulk-delawait:${s.id}`,
        confirmMsg: `Delete ${aw.length} awaiting-patch task(s) in ${s.repoName || s.id}?\n\nThese are valid crashes you haven't patched — deleting removes them from AfterQuery (your local PoC files stay).`,
      });
    },
    [detail, bulkDeleteFindings]
  );

  /** Baseline every currently-loaded finding as "seen" (NEW/MODIFIED markers). */
  const markSeen = useCallback(() => {
    const next: Record<string, string> = {};
    for (const s of subs) {
      const d = detail[s.id];
      if (d && typeof d === "object") for (const f of d.findings) next[f.id] = f.updatedAt || "";
    }
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  }, [subs, detail]);

  // Show only repos that have a local folder (artifacts in any work folder).
  const hasLocal = useCallback(
    (s: FenrirSubmission) => !!(s.repoName && localNames.has(s.repoName.toLowerCase())),
    [localNames]
  );
  const localCount = useMemo(() => subs.filter(hasLocal).length, [subs, hasLocal]);
  // "Only my repositories" checkbox: checked → just repos with a matching local
  // folder; unchecked (default) → every submission the account has.
  const scopedSubs = useMemo(
    () => (onlyLocal && namesReady ? subs.filter(hasLocal) : subs),
    [subs, onlyLocal, namesReady, hasLocal]
  );
  // Split the folder-scoped repos into the working set and the archive; the
  // toggle picks which one the list (and its counts) below shows.
  const archivedSubs = useMemo(
    () => scopedSubs.filter((s) => archived.has(s.id)),
    [scopedSubs, archived]
  );
  const acceptedSubs = useMemo(
    () => scopedSubs.filter((s) => accepted.has(s.id) && !archived.has(s.id)),
    [scopedSubs, accepted, archived]
  );
  // Favorites are cross-bucket: every ♥'d repo, wherever it lives.
  const favoriteSubs = useMemo(
    () => scopedSubs.filter((s) => favorites.has(s.id)),
    [scopedSubs, favorites]
  );
  const baseSubs = useMemo(
    () =>
      view === "archived"
        ? archivedSubs
        : view === "accepted"
        ? acceptedSubs
        : view === "favorites"
        ? favoriteSubs
        : scopedSubs.filter((s) => !archived.has(s.id) && !accepted.has(s.id)),
    [view, archivedSubs, acceptedSubs, favoriteSubs, scopedSubs, archived, accepted]
  );

  // The at-a-glance dashboard summarises EVERY repo — active and accepted alike —
  // so moving a repo to Accepted doesn't drop it out of the totals. (Archived is
  // a deliberate parking bucket and stays out; its count is shown separately.)
  // Deliberately NOT `visible`: that is search/attention-filtered, which would
  // make the dashboard totals — and the delete counts below — shrink as you type.
  const overviewSubs = useMemo(
    () => scopedSubs.filter((s) => !archived.has(s.id)),
    [scopedSubs, archived]
  );
  // Cleanup acts on exactly the repos the dashboard counted, so the number in the
  // Delete menu always equals the number of tasks that will actually be deleted.
  const cleanupScope = overviewSubs;
  const cleanupScopeLabel = "all";
  const cleanupKind = useCallback(
    (kind: CleanupKind) => cleanupFindings(cleanupScope, cleanupScopeLabel, kind),
    [cleanupFindings, cleanupScope, cleanupScopeLabel]
  );
  const cleanupBusyKinds = useMemo(
    () => new Set(CLEANUP_ORDER.filter((k) => bulkBusy.has(`bulk-cleanup-${k}-${cleanupScopeLabel}`))),
    [bulkBusy, cleanupScopeLabel]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? baseSubs.filter((s) =>
          `${s.repoName ?? ""} ${s.repoUrl ?? ""} ${s.status ?? ""} ${s.language ?? ""} ${
            s.pipelineStage ?? ""
          } ${s.harnessName ?? ""}`
            .toLowerCase()
            .includes(q)
        )
      : baseSubs;
    // Stable alphabetical order by repo name — otherwise the list reshuffles on
    // every poll as `updatedAt` changes.
    const nameOf = (s: FenrirSubmission) =>
      (s.repoName || s.repoOwner || s.fileName || s.id || "").toLowerCase();
    return [...rows].sort((a, b) =>
      nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" })
    );
  }, [baseSubs, search]);

  const findingsOf = useCallback(
    (id: string): FenrirFinding[] => {
      const d = detail[id];
      return d && typeof d === "object" ? d.findings : [];
    },
    [detail]
  );

  // Counts for the summary bar (respect the work-folder scope).
  const counts = useMemo(() => {
    let tasks = 0;
    let action = 0;
    let accepted = 0;
    for (const s of baseSubs) {
      const fs = detail[s.id];
      const list = fs && typeof fs === "object" ? fs.findings : [];
      tasks += list.length;
      action += list.filter(findingNeedsAction).length;
      accepted += list.filter(findingAccepted).length;
    }
    return { repos: baseSubs.length, tasks, action, accepted };
  }, [baseSubs, detail]);

  // Apply the attention filter on top of search.
  const visible = useMemo(() => {
    // The attention filter only applies inside the Active bucket.
    if (attn === "all" || view !== "active") return filtered;
    return filtered.filter((s) => {
      const fs = findingsOf(s.id);
      return isAction(s.status ?? "") || fs.some(findingNeedsAction); // attn === "action"
    });
  }, [filtered, attn, findingsOf, view]);

  /** Does this repo have a task in the given accepted-quality band? */
  const matchesBand = useCallback(
    (s: FenrirSubmission, band: string) => {
      const d = detail[s.id];
      const findings = d && typeof d === "object" ? d.findings : [];
      return findings.some((f) => findingBand(f) === band);
    },
    [detail]
  );
  // Repo cards for the current tab, narrowed by the dashboard's band filter.
  const cards = useMemo(() => {
    if (!acceptedBandFilter || (view !== "accepted" && view !== "active")) return visible;
    return visible.filter((s) => matchesBand(s, acceptedBandFilter));
  }, [visible, acceptedBandFilter, view, matchesBand]);
  // The dashboard now spans active AND accepted, so a band can match repos this
  // tab doesn't list. Count those so we can point at them instead of rendering
  // an empty page under a dashboard that just said the band has tasks.
  const bandElsewhere = useMemo(() => {
    if (!acceptedBandFilter || cards.length) return 0;
    return overviewSubs.filter((s) => matchesBand(s, acceptedBandFilter)).length;
  }, [acceptedBandFilter, cards.length, overviewSubs, matchesBand]);

  // sid → repo label, for tagging rows in the combined ("all repos") log.
  const repoNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subs) m.set(s.id, s.repoName || s.id);
    return m;
  }, [subs]);

  return (
    <div>
      <p className="mb-3 text-sm text-neutral-400">
        Fuzzing tasks on AfterQuery&apos;s Fenrir project. Each <b>repo</b> is listed below; its{" "}
        <b>tasks</b> (one per surfaced crash) appear under it. Patch each, then it&apos;s gated by a
        GPT-5.5 difficulty check (accepted at 0–3/10).
      </p>

      {/* Contributor / GitHub header */}
      {me && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
          {me.profile?.email && <span>{me.profile.email}</span>}
          {me.stats && "inBandApprovedTasks" in me.stats && (
            <span>
              in-band approved:{" "}
              <span className="text-emerald-400">{String(me.stats.inBandApprovedTasks)}</span>
            </span>
          )}
          <span>
            GitHub:{" "}
            {me.github?.connected ? (
              <span className="text-emerald-400">✓ {me.github.githubLogin}</span>
            ) : (
              <span className="text-amber-400">not connected</span>
            )}
          </span>
          {me.profile?.contributorPocEnabled && <span className="text-neutral-500">PoC enabled</span>}
        </div>
      )}

      {/* Folder tabs — one per work folder; each shows that folder's tasks. */}
      <div className="mb-4 flex gap-1 border-b border-neutral-800 text-sm">
        {folders.map((fo) => (
          <button
            key={fo.key}
            onClick={() => setFolder(fo.key)}
            className={`-mb-px border-b-2 px-3 py-2 ${
              folder === fo.key
                ? "border-sky-500 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {fo.label}
          </button>
        ))}
      </div>

      {namesReady && (
        <div className="mb-4 text-xs text-neutral-500">
          {onlyLocal ? (
            <>
              Showing only repos with local artifacts — {localCount} of {subs.length} submissions
              (matched by <b>repoName</b> across all work folders).
            </>
          ) : (
            <>
              Showing all {subs.length} submissions — {localCount} have local artifacts (matched by{" "}
              <b>repoName</b> across all work folders).
            </>
          )}
        </div>
      )}

      {err && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      {/* Summary + quick filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {/* Attention filters only apply inside the Active bucket. */}
        {view === "active" &&
          (
            [
              {
                key: "all",
                label: `All · ${counts.repos} repos · ${counts.tasks} tasks`,
                on: "border-sky-600 bg-sky-950/50 text-sky-300",
              },
              {
                key: "action",
                label: `Needs action · ${counts.action}`,
                on: "border-amber-600 bg-amber-950/50 text-amber-300",
              },
            ] as const
          ).map((c) => (
            <button
              key={c.key}
              onClick={() => setAttn(c.key)}
              className={`rounded-full border px-3 py-1 ${
                attn === c.key ? c.on : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {c.label}
            </button>
          ))}
        {view !== "active" && (
          <span
            className={`rounded-full border px-3 py-1 ${
              view === "accepted"
                ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
                : view === "favorites"
                ? "border-rose-700 bg-rose-950/40 text-rose-300"
                : "border-violet-700 bg-violet-950/40 text-violet-300"
            }`}
          >
            {view === "accepted" ? "Accepted" : view === "favorites" ? "♥ Favorites" : "Archived"} ·{" "}
            {counts.repos} repos · {counts.tasks} tasks
          </span>
        )}
        {/* Buckets: Active / Accepted / Archived (move repos with their buttons). */}
        <button
          onClick={() => setView((v) => (v === "accepted" ? "active" : "accepted"))}
          title="Show repos you've marked Accepted (moved with each repo's Accepted button)"
          className={`rounded-full border px-3 py-1 ${
            view === "accepted"
              ? "border-emerald-600 bg-emerald-950/50 text-emerald-300"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          {view === "accepted" ? "← Active repos" : `Accepted · ${acceptedSubs.length}`}
        </button>
        <button
          onClick={() => setView((v) => (v === "archived" ? "active" : "archived"))}
          title="Show archived repos (hidden from the active list)"
          className={`rounded-full border px-3 py-1 ${
            view === "archived"
              ? "border-violet-600 bg-violet-950/50 text-violet-300"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          {view === "archived" ? "← Active repos" : `Archived · ${archivedSubs.length}`}
        </button>
        <button
          onClick={() => setView((v) => (v === "favorites" ? "active" : "favorites"))}
          title="Show your ♥ favorite repos (marked with the heart on each card) — across every bucket"
          className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 ${
            view === "favorites"
              ? "border-rose-600 bg-rose-950/50 text-rose-300"
              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 21s-7.5-4.6-10-9.1C.6 8.9 2 5.5 5.2 5.5c1.9 0 3.2 1 3.8 2 .6-1 2-2 3.8-2 3.2 0 4.6 3.4 3.2 6.4C19.5 16.4 12 21 12 21z" />
          </svg>
          {view === "favorites" ? "← Active repos" : `Favorites · ${favoriteSubs.length}`}
        </button>
        {msg && (
          <span className={`ml-auto ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>
            {msg.text}
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repo / status / stage / harness…"
          className="min-w-[220px] flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-sky-600"
        />
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            autoEnabled
              ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Auto-submit the matching prepared patch from the local Fenrir/ folder for each patchable task, across every repo with a local folder in any tab (once per task)."
        >
          <input
            type="checkbox"
            checked={autoEnabled}
            onChange={(e) => setAutoEnabled(e.target.checked)}
            className="h-4 w-4 accent-emerald-600"
          />
          Auto-patch
        </label>
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            onlyLocal
              ? "border-sky-700 bg-sky-950/40 text-sky-300"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Checked: show only repos with a matching local folder. Unchecked: show every submission on the account."
        >
          <input
            type="checkbox"
            checked={onlyLocal}
            onChange={(e) => setOnlyLocal(e.target.checked)}
            className="h-4 w-4 accent-sky-600"
          />
          Only my repositories
        </label>
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            autoRevise
              ? "border-amber-700 bg-amber-950/40 text-amber-300"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Auto-revise every needs-revision task (revise {kind:patch}) so it can be re-patched — with Auto-patch on, this closes the loop: needs-revision → revise → awaiting → patch."
        >
          <input
            type="checkbox"
            checked={autoRevise}
            onChange={(e) => setAutoRevise(e.target.checked)}
            className="h-4 w-4 accent-amber-600"
          />
          Auto-revise
        </label>
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            autoSubmit
              ? "border-sky-700 bg-sky-950/40 text-sky-300"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Watch the active folder's updates.json and submit each newly created repo for fuzzing (once per repo)."
        >
          <input
            type="checkbox"
            checked={autoSubmit}
            onChange={(e) => setAutoSubmit(e.target.checked)}
            className="h-4 w-4 accent-sky-600"
          />
          Auto-submit
        </label>
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            autoPoc
              ? "border-violet-700 bg-violet-950/40 text-violet-300"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Submit every prepared PoC from each repo's <repo>_submission/ folder once its harness has built — the step between Auto-submit and Auto-patch."
        >
          <input
            type="checkbox"
            checked={autoPoc}
            onChange={(e) => setAutoPoc(e.target.checked)}
            className="h-4 w-4 accent-violet-600"
          />
          Auto-PoC
        </label>
        <label
          className={`flex items-center gap-1.5 rounded border px-3 py-2 text-xs ${
            showOverview
              ? "border-neutral-600 bg-neutral-800/60 text-neutral-200"
              : "border-neutral-700 text-neutral-400"
          }`}
          title="Show the at-a-glance dashboard (band rings, repo-quality tiles and the bulk Delete menu) above the repo list."
        >
          <input
            type="checkbox"
            checked={showOverview}
            onChange={(e) => setShowOverview(e.target.checked)}
            className="h-4 w-4 accent-neutral-400"
          />
          Overview
        </label>
        <button
          onClick={() => setShowLog((s) => !s)}
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          title="Combined log across all repos — each repo also has its own log inside its card"
        >
          Log · all ({log.length})
        </button>
        <button
          onClick={() =>
            setOpenIds((prev) =>
              prev.size >= visible.length
                ? new Set()
                : new Set(visible.map((s) => s.id))
            )
          }
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          {openIds.size >= visible.length && visible.length > 0 ? "Collapse all" : "Expand all"}
        </button>
        <button
          onClick={markSeen}
          title="Baseline all current tasks — clears the NEW / MOD markers until something changes"
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Mark seen
        </button>
        <button
          onClick={() => load(true)}
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          title="Refresh all repos now, including archived (the background poll refreshes archived while the Archived tab is open or an auto-handler is on)"
        >
          Reload
        </button>
      </div>

      {autoSubmit && autoPoc && autoEnabled && autoRevise && (
        <div className="mb-3 rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300/90">
          <b>Full pipeline ON</b> — updates.json → submit → PoC → patch → revise, unattended. Each
          stage waits for the one before it (PoCs wait for the harness build, patches wait for PoC
          verification, revises reopen bounced tasks for a new patch). Watch the Log.
        </div>
      )}

      {autoPoc && (
        <div className="mb-3 rounded border border-violet-900 bg-violet-950/30 px-3 py-2 text-xs text-violet-300/90">
          Auto-PoC ON — submitting each repo&apos;s prepared crashing inputs from its{" "}
          <b>&lt;repo&gt;_submission/</b> folder, once per repo, skipping PoCs the account already
          has. Repos still building their harness are left alone until the build window passes.
        </div>
      )}

      {(autoEnabled || autoRevise) && (
        <div className="mb-3 rounded border border-violet-900 bg-violet-950/30 px-3 py-2 text-xs text-violet-300/90">
          {autoEnabled && "Auto-patch"}
          {autoEnabled && autoRevise && " + "}
          {autoRevise && "Auto-revise"} ON — runs on <b>every repo with a matching local folder</b>,
          in any tab (active, accepted, archived), regardless of which one you&apos;re viewing.
          Background{" "}
          {autoEnabled ? "patching" : ""}
          {autoEnabled && autoRevise ? " / " : ""}
          {autoRevise ? "revising" : ""} continues while you work elsewhere. Each task is handled
          once (patches consume rejection attempts); check the Log.
        </div>
      )}

      {autoSubmit && (
        <div className="mb-3 rounded border border-sky-900 bg-sky-950/30 px-3 py-2 text-xs text-sky-300/90">
          Auto-submit ON — watching <b>updates.json</b> in the active folder and submitting each repo
          that isn&apos;t already in the submitted-record. Every submission is written to{" "}
          <b>.auto-submit-log.json</b> on disk, so a repo you delete from AfterQuery is{" "}
          <b>never sent again</b>. Delete its entry there to deliberately resubmit one.
          {updatesInfo && (
            <span className="ml-2 text-sky-200/80">
              · {updatesInfo.pending} pending · {updatesInfo.recorded} recorded
            </span>
          )}
          {updatesErr && <span className="ml-2 text-red-400">⚠ {updatesErr}</span>}
        </div>
      )}

      {showLog && (
        <div className="mb-4 max-h-48 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-2 text-[11px] font-mono text-neutral-400">
          {log.length === 0 ? (
            <div className="text-neutral-600">No activity yet.</div>
          ) : (
            log.map((e, i) => (
              <div key={i}>
                <span className="text-neutral-600">
                  {new Date(e.t).toLocaleTimeString()}{" "}
                </span>
                {e.sid && (
                  <span className="text-sky-500/80">[{repoNameById.get(e.sid) ?? e.sid.slice(0, 6)}] </span>
                )}
                {e.text}
              </div>
            ))
          )}
        </div>
      )}

      {/* The at-a-glance dashboard summarises every repo (active + accepted), so
          it sits ABOVE the tab's own list and stays put even when the tab you're
          on is empty — moving repos between buckets never blanks the totals. */}
      {showOverview && !loading && (view === "accepted" || view === "active") && overviewSubs.length > 0 && (
        <div className="mb-4">
          <AcceptedOverview
            title="All repositories · at a glance"
            subs={overviewSubs}
            detail={detail}
            archivedCount={archivedSubs.length}
            bandFilter={acceptedBandFilter}
            onBandFilter={setAcceptedBandFilter}
            onCleanup={cleanupKind}
            cleanupBusy={cleanupBusyKinds}
          />
        </div>
      )}

      {/* Repos (top), each with its tasks below */}
      {loading ? (
        <div className="rounded-lg border border-neutral-800 px-3 py-6 text-center text-neutral-500">
          Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-neutral-800 px-3 py-6 text-center text-neutral-500">
          {view === "archived"
            ? "No archived repos yet — use a repo's Archive button to move it here."
            : view === "accepted"
            ? "No accepted repos yet — use a repo's Accepted button to move it here."
            : attn === "action"
            ? "No repos need action."
            : "No Fenrir repos."}
        </div>
      ) : (
        <div className="space-y-4">
          {bandElsewhere > 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-4 text-center text-sm text-neutral-400">
              No repo in the {view === "accepted" ? "Accepted" : "Active"} tab has a{" "}
              <b>{ACCEPTED_BANDS.find((b) => b.key === acceptedBandFilter)?.label}</b> task —{" "}
              {bandElsewhere} repo{bandElsewhere === 1 ? " does" : "s do"} in the other bucket.{" "}
              <button
                onClick={() => setView(view === "accepted" ? "active" : "accepted")}
                className="underline hover:text-neutral-200"
              >
                Switch to {view === "accepted" ? "Active" : "Accepted"}
              </button>{" "}
              ·{" "}
              <button
                onClick={() => setAcceptedBandFilter(null)}
                className="underline hover:text-neutral-200"
              >
                clear filter
              </button>
            </div>
          )}
          {cards.map((s) => {
            const d = detail[s.id];
            const findings = d && typeof d === "object" ? d.findings : [];
            return (
              <RepoCard
                key={s.id}
                submission={s}
                detail={d}
                findings={findings}
                busy={busy}
                bulkBusy={bulkBusy}
                onAction={act}
                postTo={postTo}
                onSubmitPocs={() => submitPocs(s)}
                onPatchRepo={() => patchRepo(s)}
                onPatchFinding={(f, i) => patchOne(s, f, i)}
                onDeleteRejected={() => deleteRejected(s)}
                onDeleteRevision={() => deleteRevision(s)}
                onDeleteAwaiting={() => deleteAwaiting(s)}
                onReviseRepo={() => reviseRepo(s)}
                onReviseFinding={(f) => revisePatch(f).then(() => loadDetail(s.id))}
                revised={revised}
                isLocal={hasLocal(s)}
                isArchived={archived.has(s.id)}
                onArchive={() => toggleArchive(s.id)}
                isAcceptedRepo={accepted.has(s.id)}
                onToggleAccepted={() => toggleAccepted(s.id)}
                seen={seen}
                log={log}
                isFavorite={favorites.has(s.id)}
                onToggleFavorite={() => toggleFavorite(s.id)}
                open={openIds.has(s.id)}
                onToggle={() => toggleOpen(s.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Accepted-view dashboard: circular band rings + task-count tiles ──────────

/** The passing bands an accepted repo can land in (validated dark palette:
 *  emerald / sky / violet / amber -600 — all checks pass on the dark surface). */
// The only outcomes that count as an accepted-quality task. Order matters —
// most-specific quality first (a "very hard" review-ready task is Too Hard).
// Order = classification PRECEDENCE (findingBand / acceptedBandOf walk this in
// order and take the first match). `approved` MUST come first: a task that has
// been Approved/Accepted is Approved even though its difficulty band is still
// "in_band" — otherwise the in_review regex (/in.?band/) would steal every
// approved-with-in_band task into In Review and the Approved ring reads 0.
const ACCEPTED_BANDS = [
  { key: "approved", label: "Approved", color: "#059669", match: /approv|accept/i },
  { key: "too_hard", label: "Too Hard", color: "#0284c7", match: /very.?hard/i },
  { key: "need_bundle", label: "Need Bundle", color: "#7c3aed", match: /bundle/i },
  { key: "in_review", label: "In Review", color: "#0d9488", match: /review.?ready|in.?band/i },
] as const;
// The "really good" tasks (the high bar): In Review + Too Hard.
const GOOD_BANDS = new Set(["in_review", "too_hard"]);
// A repo earns a quality mark once it has this many qualifying tasks — 5+ for a
// "really good" repo (In Review + Too Hard) and 5+ Approved for an "Approved
// good" repo.
const GOOD_REPO_MIN = 5;

/** The "Approved good repo" mark — a certified/approved seal (rosette + check).
 *  Emerald, no text; distinct from the amber ★ used for "really good". */
function ApprovedSeal({ className = "", title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {title ? <title>{title}</title> : null}
      <path d="M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
      <path d="m9 10 2 2 4-4" />
      <path d="M8.5 13.5 6 22l6-3 6 3-2.5-8.5" />
    </svg>
  );
}

/** The accepted-quality band of a single task, or null if it isn't one yet
 *  (awaiting a patch, verifying, rejected, too-easy, …). Only these are shown
 *  and counted in the Accepted view. */
function findingBand(f: FenrirFinding): string | null {
  const dp = (f as unknown as Record<string, unknown>).difficultyProbe as
    | Record<string, unknown>
    | undefined;
  const band = dp && typeof dp.band === "string" ? dp.band : "";
  const blob = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${band}`.toLowerCase();
  if (/reject|fail|too.?easy|too.?simple/.test(blob)) return null; // not accepted-quality
  for (const b of ACCEPTED_BANDS) if (b.match.test(blob)) return b.key;
  return null;
}

/** Repo-level band = the band of its best (most-represented, quality) task. */
function acceptedBandOf(s: FenrirSubmission, findings: FenrirFinding[] = []): string {
  for (const b of ACCEPTED_BANDS) if (findings.some((f) => findingBand(f) === b.key)) return b.key;
  const st = `${s.status ?? ""} ${s.pipelineStage ?? ""}`.toLowerCase();
  for (const b of ACCEPTED_BANDS) if (b.match.test(st)) return b.key;
  return "in_review";
}

/** A donut ring: coloured arc = value/total, count centred, label beneath.
 *  Rounded arc ends, recessive track — clickable to filter. */
function StatRing({
  value,
  total,
  label,
  color,
  active,
  onClick,
}: {
  value: number;
  total: number;
  label: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const r = 34;
  const circ = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label}: ${value} of ${total}`}
      className={`flex w-24 flex-col items-center gap-1.5 rounded-lg px-1 py-2 transition ${
        active ? "bg-neutral-800 ring-1 ring-neutral-600" : "hover:bg-neutral-800/50"
      }`}
    >
      <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0">
        <circle cx="42" cy="42" r={r} fill="none" stroke="#262626" strokeWidth="8" />
        {value > 0 && (
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${circ * frac} ${circ}`}
            transform="rotate(-90 42 42)"
          />
        )}
        <text x="42" y="50" textAnchor="middle" className="fill-neutral-100 text-2xl font-semibold">
          {value}
        </text>
      </svg>
      <span className="text-center text-xs font-medium leading-tight text-neutral-300">{label}</span>
    </button>
  );
}

/** The accepted view — every accepted repo summarised as circular status at a
 *  glance (by difficulty band + by task count), click-to-filter, per-repo
 *  Un-accept / Archive controls. */
function AcceptedOverview({
  title = "All repositories · at a glance",
  subs,
  detail,
  bandFilter,
  onBandFilter,
  archivedCount = 0,
  onCleanup,
  cleanupBusy,
}: {
  title?: string;
  subs: FenrirSubmission[];
  detail: Record<string, DetailState>;
  /** Archived repos excluded from these totals, surfaced so they aren't invisible. */
  archivedCount?: number;
  bandFilter: string | null;
  onBandFilter: (key: string | null) => void;
  /** Bulk-delete one category across every repo in this view. */
  onCleanup: (kind: CleanupKind) => void;
  /** Which categories are mid-delete right now. */
  cleanupBusy: Set<CleanupKind>;
}) {
  const rows = subs.map((s) => {
    const d = detail[s.id];
    const findings = d && typeof d === "object" ? d.findings : [];
    // Only accepted-quality tasks (Approved / In Review / Too Hard / Need Bundle)
    // — not awaiting/verifying/rejected/too-easy ones.
    const quality = findings.filter((f) => findingBand(f));
    const goodTasks = quality.filter((f) => GOOD_BANDS.has(findingBand(f)!)).length;
    const approvedTasks = quality.filter((f) => findingBand(f) === "approved").length;
    return {
      s,
      band: acceptedBandOf(s, findings),
      findings,
      quality,
      tasks: quality.length,
      goodTasks,
      approvedTasks,
    };
  });
  const total = rows.length; // repo count
  const allQuality = rows.flatMap((r) => r.quality);
  const totalTasks = allQuality.length; // accepted-quality tasks
  const bandTaskCount = (key: string) => allQuality.filter((f) => findingBand(f) === key).length;
  // A "really good" repo has GOOD_REPO_MIN+ tasks that are In Review or Too Hard.
  const reallyGood = rows.filter((r) => r.goodTasks >= GOOD_REPO_MIN).length;
  // An "Approved good" repo has GOOD_REPO_MIN+ Approved tasks.
  const approvedGood = rows.filter((r) => r.approvedTasks >= GOOD_REPO_MIN).length;
  // Rings displayed in your order: Approved · In Review · Too Hard · Need Bundle.
  const ringOrder = ["approved", "in_review", "too_hard", "need_bundle"] as const;
  const shownCount = bandFilter
    ? rows.filter((r) => r.quality.some((f) => findingBand(f) === bandFilter)).length
    : total;
  // What each cleanup category would remove, across ALL repos in this view. The
  // categories are disjoint and together equal the deletable ("non-passed") set.
  const countOf = (match: (f: FenrirFinding) => boolean) =>
    rows.reduce((n, r) => n + r.findings.filter(match).length, 0);
  // Tasks the server won't let you delete (in verification / approved) — listed
  // as a disabled row so an empty category is explained rather than puzzling.
  const lockedCount = countOf((f) => !findingDeletable(f));
  const cleanupItems: DeleteMenuItem[] = CLEANUP_ORDER.map((kind) => {
    const spec = CLEANUP_KINDS[kind];
    const count = countOf(spec.match);
    const busy = cleanupBusy.has(kind);
    return {
      label: spec.label,
      count,
      onClick: () => onCleanup(kind),
      disabled: count === 0 || busy,
      busy,
    };
  });
  if (lockedCount > 0)
    cleanupItems.push({
      label: "In verification — can't delete",
      count: lockedCount,
      onClick: () => {},
      disabled: true,
    });
  const deletableCount = cleanupItems
    .filter((it) => !it.disabled || it.busy)
    .reduce((n, it) => n + (it.count ?? 0), 0);
  // Rejected tasks across ALL accepted repos (hard rejects only — same predicate
  // as the red "Rejected" bar; excludes needs-revision / too-easy).
  const rejectedCount = countOf(isRejected);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-base font-semibold text-neutral-100">{title}</span>
          <div className="flex items-center gap-3">
            {deletableCount === 0 && cleanupBusy.size === 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400/80">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                All clean
              </span>
            )}
            <DeleteMenu items={cleanupItems} busyLabel={cleanupBusy.size > 0} />
            <span className="text-sm text-neutral-400">
              {total} repos · {totalTasks} accepted-quality task{totalTasks === 1 ? "" : "s"}
              {rejectedCount > 0 && (
                <>
                  {" · "}
                  <span className="text-red-400/90">{rejectedCount} rejected</span>
                </>
              )}
              {archivedCount > 0 && (
                <span className="text-neutral-500" title="Archived repos are parked and excluded from these totals">
                  {" · "}
                  {archivedCount} archived (not counted)
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {/* Accepted-quality band rings — TASK counts; click to filter the list. */}
          <div className="flex flex-wrap items-start gap-2">
            {ringOrder.map((key) => {
              const b = ACCEPTED_BANDS.find((x) => x.key === key)!;
              return (
                <StatRing
                  key={key}
                  value={bandTaskCount(key)}
                  total={totalTasks}
                  label={b.label}
                  color={b.color}
                  active={bandFilter === key}
                  onClick={() => onBandFilter(bandFilter === key ? null : key)}
                />
              );
            })}
          </div>
          <div className="h-16 w-px bg-neutral-800" />
          {/* Repo quality: total accepted repos + the "really good" ones. */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-24 rounded-lg border border-neutral-800 py-3 text-center">
              <div className="text-2xl font-semibold text-neutral-100">{total}</div>
              <div className="text-xs text-neutral-500">repos</div>
            </div>
            <div
              className="w-24 rounded-lg border border-emerald-700 bg-emerald-950/30 py-3 text-center"
              title={`Repos with ${GOOD_REPO_MIN}+ tasks that are In Review or Too Hard`}
            >
              <div className="text-2xl font-semibold text-emerald-300">{reallyGood}</div>
              <div className="mt-0.5 flex justify-center text-amber-400" aria-label="really good">
                <span className="text-sm leading-none">★</span>
              </div>
            </div>
            <div
              className="w-24 rounded-lg border border-emerald-600 bg-emerald-900/40 py-3 text-center"
              title={`Approved good repos — ${GOOD_REPO_MIN}+ Approved tasks`}
            >
              <div className="text-2xl font-semibold text-emerald-200">{approvedGood}</div>
              <div className="mt-0.5 flex justify-center text-emerald-300" aria-label="approved good">
                <ApprovedSeal className="h-4 w-4" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {bandFilter && (
        <button
          onClick={() => onBandFilter(null)}
          className="text-sm text-sky-400 hover:text-sky-300"
        >
          ← filtering to {ACCEPTED_BANDS.find((b) => b.key === bandFilter)?.label} — {shownCount} of{" "}
          {total} repos · clear
        </button>
      )}
    </div>
  );
}

interface DeleteMenuItem {
  label: string;
  count?: number;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Extra-destructive (e.g. the whole repo) — rendered with a divider above. */
  separated?: boolean;
}

/** A single "Delete ▾" button that opens a menu of per-category delete actions,
 *  replacing the row of individual delete buttons. Opens on hover or click and
 *  closes on outside-click / mouse-leave / Escape. */
function DeleteMenu({
  items,
  busyLabel,
  disabled,
}: {
  items: DeleteMenuItem[];
  /** True while any of the menu's actions is running — shown on the trigger. */
  busyLabel?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = items.reduce((n, it) => n + (it.count ?? 0), 0);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-red-300 hover:bg-neutral-800 disabled:opacity-40"
        title="Delete tasks by category"
      >
        {busyLabel ? "Deleting…" : `Delete${total > 0 ? ` (${total})` : ""} ▾`}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[13rem] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
          {items.map((it, i) => (
            <div key={it.label}>
              {it.separated && i > 0 && <div className="my-1 border-t border-neutral-800" />}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                disabled={it.disabled}
                className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 ${
                  it.separated ? "text-red-400" : "text-neutral-200"
                }`}
              >
                <span>{it.busy ? "Deleting…" : it.label}</span>
                {it.count != null && (
                  <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-400">
                    {it.count}
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One repo on top, its tasks (findings) below. */
function RepoCard({
  submission: s,
  detail: d,
  findings,
  busy,
  bulkBusy,
  onAction,
  postTo,
  onSubmitPocs,
  onPatchRepo,
  onPatchFinding,
  onDeleteRejected,
  onDeleteRevision,
  onDeleteAwaiting,
  onReviseRepo,
  onReviseFinding,
  revised,
  isLocal,
  isArchived,
  onArchive,
  isAcceptedRepo,
  onToggleAccepted,
  seen,
  log,
  isFavorite,
  onToggleFavorite,
  open,
  onToggle,
}: {
  submission: FenrirSubmission;
  detail: DetailState;
  findings: FenrirFinding[];
  log: { t: number; text: string; sid?: string }[];
  isFavorite: boolean;
  onToggleFavorite: () => void;
  busy: string;
  bulkBusy: Set<string>;
  onAction: (payload: Record<string, unknown>, refreshId?: string) => void;
  postTo: (
    url: string,
    payload: Record<string, unknown>,
    refreshId?: string,
    busyKey?: string
  ) => Promise<boolean>;
  onSubmitPocs: () => void;
  onPatchRepo: () => void;
  onPatchFinding: (f: FenrirFinding, index: number) => void;
  onDeleteRejected: () => void;
  onDeleteRevision: () => void;
  onDeleteAwaiting: () => void;
  onReviseRepo: () => void;
  onReviseFinding: (f: FenrirFinding) => void;
  revised: Set<string>;
  isLocal: boolean;
  isArchived: boolean;
  onArchive: () => void;
  isAcceptedRepo: boolean;
  onToggleAccepted: () => void;
  seen: Record<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  const actionFindings = findings.filter(findingNeedsAction);
  const rejectedFindings = findings.filter(isRejected);
  const patchCount = findings.filter(
    (f) =>
      findingPatchable(f) &&
      findingBuildVerified(f) &&
      !(findingNeedsRevision(f) && !revised.has(f.id))
  ).length;
  const reviseCount = findings.filter(
    (f) => findingNeedsRevision(f) && !revised.has(f.id)
  ).length;
  const revisionCount = findings.filter(findingRevisionWorthy).length;
  const awaitingCount = findings.filter(findingAwaiting).length;
  // Tasks the server won't let you delete (in verification / approved) — shown
  // as a disabled note so it's clear WHY the delete categories are empty.
  const lockedCount = findings.filter((f) => !findingDeletable(f)).length;
  const actionCount = actionFindings.length;
  // Repo-level bulk-action busy flags — a button stays disabled from click until
  // its multi-step action finishes; a bulk action locks the sibling buttons too.
  const busyPatchRepo = bulkBusy.has(`bulk-patch:${s.id}`);
  const busyReviseRepo = bulkBusy.has(`bulk-revise:${s.id}`);
  const busyDelRej = bulkBusy.has(`bulk-delrej:${s.id}`);
  const busyDelRev = bulkBusy.has(`bulk-delrev:${s.id}`);
  const busyDelAwait = bulkBusy.has(`bulk-delawait:${s.id}`);
  const busyPoc = bulkBusy.has(`bulk-poc:${s.id}`);
  const anyBulk = [...bulkBusy].some((k) => k.endsWith(`:${s.id}`));
  // Delete-menu items, shared by the full header and the accepted header so
  // accepted repos delete exactly like active ones.
  const deleteMenuItems: DeleteMenuItem[] = [
    {
      label: "Rejected (closed patches)",
      count: rejectedFindings.length,
      onClick: onDeleteRejected,
      disabled: rejectedFindings.length === 0 || busyDelRej,
      busy: busyDelRej,
    },
    {
      label: "Needs revision (flagged)",
      count: revisionCount,
      onClick: onDeleteRevision,
      disabled: revisionCount === 0 || busyDelRev,
      busy: busyDelRev,
    },
    {
      label: "Awaiting patch (unpatched)",
      count: awaitingCount,
      onClick: onDeleteAwaiting,
      disabled: awaitingCount === 0 || busyDelAwait,
      busy: busyDelAwait,
    },
    ...(lockedCount > 0
      ? [{ label: "In verification — can't delete", count: lockedCount, onClick: () => {}, disabled: true }]
      : []),
    {
      label: "Entire repo & all tasks",
      onClick: () => {
        if (confirm(`Delete repo ${s.repoName || s.id} and its tasks?`))
          onAction({ action: "delete-submission", submissionId: s.id });
      },
      disabled: busy === s.id,
      separated: true,
    },
  ];
  const deleteBusyLabel = busyDelRej || busyDelRev || busyDelAwait || busy === s.id;
  // Accepted-view per-repo quality counts (the high bar: In Review + Too Hard).
  const inReviewCount = findings.filter((f) => findingBand(f) === "in_review").length;
  const tooHardCount = findings.filter((f) => findingBand(f) === "too_hard").length;
  const approvedCount = findings.filter((f) => findingBand(f) === "approved").length;
  const rejectedCount = findings.filter(isRejected).length;
  const isReallyGood = inReviewCount + tooHardCount >= GOOD_REPO_MIN;
  const isApprovedGood = approvedCount >= GOOD_REPO_MIN;
  // Still building the harness (first ~few min after dispatch) — lock submits.
  const building = submissionBuildingHarness(s, findings);
  // Terminally failed / rejected with nothing to salvage (e.g. build harness
  // rejected, no live findings) — dead repo: only Delete remains. Gated on the
  // detail being fully loaded so we never hide actions on a repo whose live
  // findings just haven't arrived yet (a fuzzing failure with live findings is
  // NOT dead — see submissionDead).
  const detailLoaded = d != null && typeof d === "object";
  const dead = detailLoaded && submissionDead(s, findings);
  const repoLabel = s.repoName || s.id;
  const pocKey = `poc:${s.id}`;

  // Prepared PoCs for this repo (dry-run; no token needed). Kept raw with their
  // sha256 so the count can exclude PoCs already submitted (existing findings).
  const [pocsRaw, setPocsRaw] = useState<{ sha256?: string }[] | null>(null);
  useEffect(() => {
    if (!s.repoName) {
      setPocsRaw(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      fetch("/api/fenrir/auto-poc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId: s.id, repoName: s.repoName, dryRun: true }),
        cache: "no-store",
      })
        .then((r) => r.json())
        .then((dd) => {
          // Keep the last-good list on a transient failure (don't reset to 0/[]).
          if (!cancelled && dd.ok && Array.isArray(dd.pocs)) setPocsRaw(dd.pocs);
          else if (!cancelled) setPocsRaw((prev) => prev ?? []);
        })
        .catch(() => {
          if (!cancelled) setPocsRaw((prev) => prev ?? []);
        });
    };
    refresh();
    // Re-scan periodically so the count tracks the local folder as you build it
    // (add/remove PoCs) — the old once-on-mount fetch went stale.
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [s.id, s.repoName]);
  // Hashes of PoCs already submitted (this repo's findings) — the server keys a
  // finding by sha256(poc)[:16], carried at the tail of the finding id.
  const submittedHashes = useMemo(
    () =>
      new Set(
        findings
          .map((f) => (String(f.id).match(/([0-9a-f]{16})$/i) || [])[1]?.toLowerCase())
          .filter((h): h is string => !!h)
      ),
    [findings]
  );
  // The button counts (and enables on) only PoCs not yet submitted.
  const pocCount =
    pocsRaw == null
      ? null
      : pocsRaw.filter((p) => !p.sha256 || !submittedHashes.has(String(p.sha256).toLowerCase()))
          .length;
  const onPocFile = async (file: File | undefined) => {
    if (!file) return;
    const pocBase64 = await fileToBase64(file);
    await postTo("/api/fenrir/submit-poc", { submissionId: s.id, pocBase64 }, s.id, pocKey);
  };
  const sanitizer = s.fuzzResult?.sanitizerOutput;
  // This repo's own activity log (filtered from the shared stream by sid).
  const repoLog = useMemo(() => log.filter((e) => e.sid === s.id), [log, s.id]);

  // Copy-link buttons near the repo name.
  const [copied, setCopied] = useState<"gh" | "aq" | null>(null);
  const afterqueryUrl = `https://experts.afterquery.com/projects/fenrir/${s.id}`;
  const copy = (which: "gh" | "aq", text?: string) => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1200);
    });
  };
  // ♥ Favorite toggle — filled rose when on, outline grey when off. Shared by
  // both card headers so it's the same everywhere.
  const heartBtn = (
    <button
      type="button"
      onClick={onToggleFavorite}
      title={isFavorite ? "Remove from favorites" : "Favorite this repo (find it later in ♥ Favorites)"}
      className={`shrink-0 rounded p-1 transition hover:bg-neutral-800 ${
        isFavorite ? "text-rose-400" : "text-neutral-600 hover:text-rose-300"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
        <path d="M12 21s-7.5-4.6-10-9.1C.6 8.9 2 5.5 5.2 5.5c1.9 0 3.2 1 3.8 2 .6-1 2-2 3.8-2 3.2 0 4.6 3.4 3.2 6.4C19.5 16.4 12 21 12 21z" />
      </svg>
    </button>
  );

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      {/* ── Accepted repo: a clean, minimal one-row card ──────────────── */}
      {isAcceptedRepo && (
        <div className={`flex items-center gap-3 px-4 py-3 ${open ? "border-b border-neutral-800" : ""}`}>
          <button
            onClick={onToggle}
            className="shrink-0 text-neutral-500 hover:text-neutral-200"
            title={open ? "Collapse" : "Expand tasks"}
          >
            {open ? "▾" : "▸"}
          </button>
          <span className="shrink-0 text-sm text-emerald-400" title="Accepted">
            ✓
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-neutral-100">
                {s.repoOwner && s.repoName
                  ? `${s.repoOwner}/${s.repoName}`
                  : s.repoName || s.fileName || s.id}
              </span>
              <button
                type="button"
                onClick={() => copy("gh", s.repoUrl)}
                disabled={!s.repoUrl}
                title={s.repoUrl ? "Copy GitHub link" : "No GitHub link"}
                className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
              >
                {copied === "gh" ? (
                  <span className="text-[11px] text-emerald-400">✓</span>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={() => copy("aq", afterqueryUrl)}
                title="Copy AfterQuery link"
                className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-sky-300"
              >
                {copied === "aq" ? (
                  <span className="text-[11px] text-emerald-400">✓</span>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                )}
              </button>
              {heartBtn}
            </div>
            <div className="truncate text-[11px] text-neutral-500">
              {findings.length} task{findings.length === 1 ? "" : "s"}
              {s.commitSha ? ` · ${String(s.commitSha).slice(0, 8)}` : ""}
              {!open && findings.length > 0 ? " · click ▸ to expand" : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Per-repo quality counts — green = In Review, blue = Too Hard. */}
            <span
              className="rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
              style={{ background: "#05966922", color: "#34d399" }}
              title={`${inReviewCount} In Review`}
            >
              {inReviewCount}
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
              style={{ background: "#0284c722", color: "#38bdf8" }}
              title={`${tooHardCount} Too Hard`}
            >
              {tooHardCount}
            </span>
            {rejectedCount > 0 && (
              <span
                className="rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                style={{ background: "#dc262622", color: "#f87171" }}
                title={`${rejectedCount} Rejected`}
              >
                {rejectedCount}
              </span>
            )}
            {isReallyGood && (
              <span
                className="text-sm text-amber-400"
                title={`Really good — ${inReviewCount + tooHardCount} In Review + Too Hard`}
              >
                ★
              </span>
            )}
            {isApprovedGood && (
              <ApprovedSeal
                className="h-4 w-4 text-emerald-400"
                title={`Approved good repo — ${approvedCount} Approved tasks`}
              />
            )}
            {s.status && <Badge>{s.status}</Badge>}
            <DeleteMenu busyLabel={deleteBusyLabel} items={deleteMenuItems} />
            <button
              onClick={onToggleAccepted}
              className="rounded border border-emerald-700 px-2 py-0.5 text-xs text-emerald-300 hover:bg-neutral-800"
              title="Move this repo back to your active list"
            >
              Un-accept
            </button>
            <button
              onClick={onArchive}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
              title="Archive — hide from the list"
            >
              Archive
            </button>
          </div>
        </div>
      )}
      {/* ── Full header (active / archived repos) ─────────────────────── */}
      {!isAcceptedRepo && (
      <div className={`flex items-start gap-3 px-4 py-3 ${open ? "border-b border-neutral-800" : ""}`}>
        <button
          onClick={onToggle}
          className="mt-0.5 shrink-0 text-neutral-400 hover:text-neutral-200"
          title={open ? "Collapse" : "Expand tasks"}
        >
          {open ? "▾" : "▸"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-500">
            Repo
            {isLocal ? (
              <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-300">local ✓</span>
            ) : (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-500">no local folder</span>
            )}
            {isAcceptedRepo && (
              <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-emerald-200">✓ accepted</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="truncate text-base font-semibold text-neutral-100">
              {s.repoOwner && s.repoName
                ? `${s.repoOwner}/${s.repoName}`
                : s.repoName || s.fileName || s.id}
            </span>
            <button
              type="button"
              onClick={() => copy("gh", s.repoUrl)}
              disabled={!s.repoUrl}
              title={s.repoUrl ? "Copy GitHub link" : "No GitHub link"}
              className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
            >
              {copied === "gh" ? (
                <span className="text-[11px] text-emerald-400">✓</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => copy("aq", afterqueryUrl)}
              title="Copy AfterQuery link"
              className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-sky-300"
            >
              {copied === "aq" ? (
                <span className="text-[11px] text-emerald-400">✓</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              )}
            </button>
            {heartBtn}
          </div>
          <div className="truncate text-xs text-neutral-500">
            {s.repoUrl ? (
              <a
                href={s.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-sky-400"
              >
                {s.repoUrl}
              </a>
            ) : (
              s.id
            )}
            {s.commitSha ? ` · ${String(s.commitSha).slice(0, 8)}` : ""}
            {s.language ? ` · ${s.language}` : ""}
            {s.harnessName ? ` · ${s.harnessName}` : ""}
            {s.fuzzResult?.durationSec ? ` · fuzzed ${dur(s.fuzzResult.durationSec)}` : ""}
            {s.updatedAt ? ` · ${fmt(s.updatedAt)}` : ""}
          </div>
          <div className="mt-2 text-[11px] text-neutral-500">
            {d === undefined || d === "loading" ? (
              "loading tasks…"
            ) : (
              <>
                {findings.length} task{findings.length === 1 ? "" : "s"}
                {actionCount > 0 && (
                  <span className="text-amber-400"> · {actionCount} need action</span>
                )}
                {!open && findings.length > 0 && (
                  <span className="text-neutral-600"> · click ▸ to expand</span>
                )}
              </>
            )}
          </div>
          {!isAcceptedRepo && (
            <div className="mt-2 flex items-center gap-2">
              <StageMeter progress={submissionProgress(s, findings)} cells={12} />
              <span className="text-[11px] text-neutral-500">
                {submissionProgress(s, findings).currentLabel}
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {dead ? (
            <span className="rounded border border-red-800 bg-red-950/40 px-2 py-0.5 text-xs text-red-300">
              {submissionDeadLabel(s)}
            </span>
          ) : (
            <>
              {s.status && <Badge>{s.status}</Badge>}
              {/* Hide a raw "failed"/"rejected" pipelineStage on a live repo — its
                  fuzzing side-channel failed but the findings are fine, so the
                  friendly status above already tells the true story. */}
              {s.pipelineStage && !/reject|fail/i.test(s.pipelineStage) && (
                <Badge>{s.pipelineStage}</Badge>
              )}
            </>
          )}
          <div className="flex flex-wrap justify-end gap-1">
            {/* Dead repo (build harness rejected / terminally failed) — only Delete. */}
            {dead ? (
            <button
              onClick={() => {
                if (confirm(`Delete rejected repo ${s.repoName || s.id} and its tasks?`))
                  onAction({ action: "delete-submission", submissionId: s.id });
              }}
              disabled={busy === s.id}
              className="rounded border border-red-700 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
              title={`${submissionDeadLabel(s)} — this repo can't proceed; delete it`}
            >
              {busy === s.id ? "Deleting…" : "Delete"}
            </button>
            ) : (
            <>
            {/* Full action set — hidden for Accepted repos (only Un-accept / Archive). */}
            {!isAcceptedRepo && (
            <>
            <button
              onClick={onSubmitPocs}
              disabled={pocCount === 0 || anyBulk || building}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-sky-300 hover:bg-neutral-800 disabled:opacity-40"
              title={
                building
                  ? "Building harness — wait for the build to finish before submitting PoCs (the API exposes no build-done signal, so this is a ~3 min time estimate from dispatch)"
                  : "Submit every prepared PoC from this repo's <repo>_submission/ folder"
              }
            >
              {building
                ? "Building harness…"
                : busyPoc
                ? "Submitting…"
                : `Submit PoCs${pocCount != null ? ` (${pocCount})` : ""}`}
            </button>
            <button
              onClick={onReviseRepo}
              disabled={reviseCount === 0 || anyBulk}
              className="rounded border border-amber-700 px-2 py-0.5 text-xs text-amber-300 hover:bg-neutral-800 disabled:opacity-40"
              title="Reopen every needs-revision task in this repo for a new patch (revise {kind:patch}) — required before you can submit them"
            >
              {busyReviseRepo ? "Revising…" : `Revise patches${reviseCount > 0 ? ` (${reviseCount})` : ""}`}
            </button>
            <button
              onClick={onPatchRepo}
              disabled={patchCount === 0 || anyBulk}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              title="Submit prepared patches for this repo's patchable tasks (needs-revision tasks must be revised first)"
            >
              {busyPatchRepo ? "Submitting…" : `Submit patches${patchCount > 0 ? ` (${patchCount})` : ""}`}
            </button>
            <DeleteMenu busyLabel={deleteBusyLabel} items={deleteMenuItems} />
            </>
            )}
            <button
              onClick={onToggleAccepted}
              title={
                isAcceptedRepo
                  ? "Move this repo back to your active list"
                  : "Accepted — move this repo to the Accepted tab"
              }
              className={`rounded border px-2 py-0.5 text-xs hover:bg-neutral-800 ${
                isAcceptedRepo ? "border-emerald-600 text-emerald-300" : "border-neutral-700 text-emerald-300"
              }`}
            >
              {isAcceptedRepo ? "Un-accept" : "Accepted"}
            </button>
            <button
              onClick={onArchive}
              title={
                isArchived
                  ? "Move this repo back to your active list"
                  : "Archive — hide from the active list (reopen it any time from “Archived”)"
              }
              className={`rounded border px-2 py-0.5 text-xs hover:bg-neutral-800 ${
                isArchived ? "border-violet-700 text-violet-300" : "border-neutral-700 text-neutral-300"
              }`}
            >
              {isArchived ? "Unarchive" : "Archive"}
            </button>
            </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* ── Tasks (findings) below ──────────────────────────────────── */}
      {open && (
      <div className="space-y-3 p-4">
        {/* This repo's own activity log — so you can verify one repo at a time
            instead of reading the merged cross-repo stream. */}
        <details className="rounded border border-neutral-800 bg-neutral-950" open>
          <summary className="flex cursor-pointer items-center justify-between px-2 py-1.5 text-xs font-medium text-neutral-300">
            <span>Activity log{repoLog.length ? ` · ${repoLog.length}` : ""}</span>
            <span className="text-[10px] font-normal text-neutral-500">this repo only</span>
          </summary>
          <div className="max-h-56 overflow-auto border-t border-neutral-800 p-2 text-[11px] font-mono leading-relaxed text-neutral-400">
            {repoLog.length === 0 ? (
              <div className="text-neutral-600">No activity for this repo yet.</div>
            ) : (
              repoLog.map((e, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  <span className="text-neutral-600">{new Date(e.t).toLocaleTimeString()} </span>
                  {e.text}
                </div>
              ))
            )}
          </div>
        </details>

        {/* Repo-level fuzz crash (the originally surfaced crash). */}
        {s.fuzzResult?.generatedDescription && (
          <details className="rounded border border-neutral-800 bg-neutral-950">
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-neutral-300">
              Repo fuzz crash details
            </summary>
            <div className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-neutral-300">
              {s.fuzzResult.generatedDescription}
            </div>
          </details>
        )}
        {sanitizer && (
          <details className="rounded border border-red-900/60 bg-neutral-950">
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-red-300">
              {sanitizerLabel(sanitizer)} (repo fuzz)
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-red-900/60 px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
              {sanitizer}
            </pre>
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <span>Submit a PoC input:</span>
          <input
            type="file"
            disabled={busy === pocKey || anyBulk || building}
            onChange={(e) => onPocFile(e.target.files?.[0])}
            className="text-xs text-neutral-400 file:mr-2 file:rounded file:border file:border-neutral-700 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-200 disabled:opacity-40"
          />
          {busy === pocKey && <span className="text-sky-400">uploading…</span>}
          {building && (
            <span className="text-amber-400">⏳ building harness — wait to submit</span>
          )}
        </div>

        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
          Tasks ({findings.length})
        </div>

        {d === undefined || d === "loading" ? (
          <p className="text-xs text-neutral-500">Loading tasks…</p>
        ) : typeof d === "string" ? (
          <p className="text-xs text-red-400">{d}</p>
        ) : findings.length === 0 ? (
          <p className="text-xs text-neutral-500">No tasks yet (still fuzzing or none surfaced).</p>
        ) : (
          <div className="space-y-3">
            {groupFindings(findings).map((group) => (
              <div key={group.key}>
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${group.dot}`} />
                  {group.label}
                  <span className="text-neutral-600">· {group.items.length}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map(({ f, i }) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      isNew={!(f.id in seen)}
                      isModified={f.id in seen && seen[f.id] !== (f.updatedAt || "")}
                      busy={busy}
                      onAction={onAction}
                      postTo={postTo}
                      onPatch={() => onPatchFinding(f, i)}
                      onRevise={() => onReviseFinding(f)}
                      isRevised={revised.has(f.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** One task (finding = crash) under a repo. */
function FindingCard({
  finding: f,
  isNew,
  isModified,
  busy,
  onAction,
  postTo,
  onPatch,
  onRevise,
  isRevised,
}: {
  finding: FenrirFinding;
  isNew: boolean;
  isModified: boolean;
  busy: string;
  onAction: (payload: Record<string, unknown>, refreshId?: string) => void;
  postTo: (
    url: string,
    payload: Record<string, unknown>,
    refreshId?: string,
    busyKey?: string
  ) => Promise<boolean>;
  onPatch: () => void;
  onRevise: () => void;
  isRevised: boolean;
}) {
  const [open, setOpen] = useState(false);
  const progress = findingProgress(f);
  const { bugClass, location } = findingTitle(f);
  const needsAction = findingNeedsAction(f) || progress.warn;
  // A needs-revision task is locked for submission until it's been revised.
  const needsRevision = progress.warn;
  // Until the repo's build harness has passed (still Validating PoC / building),
  // patching is unsafe — it can get the account blocked. Block it too.
  const buildPending = !findingBuildVerified(f);
  const locked = (needsRevision && !isRevised) || buildPending;
  // The server only deletes awaiting / rejected / needs-revision tasks; anything
  // in verification or approved is locked (DELETE → 409).
  const deletable = findingDeletable(f);
  // Difficulty-probe tally: how many of the 10 runs the agent solved so far
  // (accepted at 0–3/10 — fewer solves = harder = better).
  const probe = (f as unknown as Record<string, unknown>).probeProgress as
    | { phase?: string; done?: number; total?: number; passed?: number }
    | undefined;
  const probeStat =
    probe && typeof probe === "object" && probe.phase === "probe"
      ? {
          passed: typeof probe.passed === "number" ? probe.passed : 0,
          done: typeof probe.done === "number" ? probe.done : 0,
          total: typeof probe.total === "number" && probe.total > 0 ? probe.total : 10,
        }
      : null;
  // For a needs-revision (too-easy) task: which gate flagged it (Sonnet
  // pre-filter vs GPT-5.5 difficulty probe) and its solve count.
  const revisionFail = needsRevision ? probeFailure(f) : null;

  return (
    <div
      className={`rounded border bg-neutral-950 ${
        needsAction ? "border-amber-800/70" : "border-neutral-800"
      }`}
    >
      {/* ── Compact status row — click anywhere to expand ────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-900/40"
      >
        <span className="shrink-0 text-neutral-500">{open ? "▾" : "▸"}</span>

        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-neutral-200">{bugClass}</span>
          {location && (
            <>
              <span className="shrink-0 text-neutral-600">·</span>
              <span className="truncate font-mono text-xs text-neutral-400">{location}</span>
            </>
          )}
          {isNew ? (
            <span className="shrink-0 rounded bg-sky-900 px-1 py-0.5 text-[9px] font-semibold text-sky-200">
              NEW
            </span>
          ) : isModified ? (
            <span className="shrink-0 rounded bg-amber-900 px-1 py-0.5 text-[9px] font-semibold text-amber-200">
              MOD
            </span>
          ) : null}
          {findingSubmitted(f) && (
            <span className="shrink-0 rounded bg-violet-900 px-1 py-0.5 text-[9px] font-semibold text-violet-200">
              SUB
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <StageMeter progress={progress} cells={10} />
          <span
            className={`hidden w-24 text-right text-[11px] sm:inline ${
              progress.warn
                ? "text-amber-400"
                : progress.failed
                ? "text-red-400"
                : "text-neutral-500"
            }`}
          >
            {progress.currentLabel}
          </span>
          {probeStat && (
            <span
              className="hidden shrink-0 items-center gap-1 rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums sm:inline-flex"
              title={`Agent solved ${probeStat.passed} · on test case ${probeStat.done} of ${probeStat.total} — accepted at 0–3/10`}
            >
              <span
                className={
                  probeStat.passed <= 3
                    ? "text-emerald-400"
                    : probeStat.passed <= 6
                    ? "text-amber-400"
                    : "text-red-400"
                }
                title="solved by the agent"
              >
                ✓{probeStat.passed}
              </span>
              <span className="text-neutral-600">·</span>
              <span className="text-neutral-400" title="test case done / total">
                {probeStat.done}/{probeStat.total}
              </span>
            </span>
          )}
          {revisionFail && (
            <span
              className="hidden shrink-0 items-center rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-amber-300 sm:inline-flex"
              title={`Flagged too easy at the ${
                revisionFail.stage === "Sonnet" ? "Sonnet pre-filter (Quick Screen)" : "GPT-5.5 difficulty probe"
              } — the model solved ${revisionFail.passed}/${revisionFail.total}`}
            >
              {revisionFail.stage} {revisionFail.passed}/{revisionFail.total}
            </span>
          )}
          {progress.pill ? (
            <Badge>{progress.pill}</Badge>
          ) : f.status ? (
            <Badge>{f.status}</Badge>
          ) : f.pipelineStage ? (
            <Badge>{f.pipelineStage}</Badge>
          ) : null}
        </span>
      </div>

      {/* ── Expanded detail (id, actions, feedback, crash, editors) ───── */}
      {open && (
        <div className="space-y-2 border-t border-neutral-800 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-neutral-400">{f.id}</span>
            {f.harnessName && <span className="text-xs text-neutral-500">{f.harnessName}</span>}
            <span className="ml-auto flex gap-1" role="group" aria-label="task actions">
              {needsRevision && (
                <button
                  onClick={onRevise}
                  disabled={isRevised || busy === `revise:${f.id}`}
                  className="rounded border border-amber-600 px-2 py-0.5 text-xs text-amber-300 hover:bg-neutral-800 disabled:opacity-40"
                  title="Reopen this needs-revision task for a new patch (revise {kind:patch}) — required before you can submit"
                >
                  {busy === `revise:${f.id}` ? "Revising…" : isRevised ? "Revised ✓" : "Revise patch"}
                </button>
              )}
              <button
                onClick={onPatch}
                disabled={locked}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-emerald-300 hover:bg-neutral-800 disabled:opacity-40"
                title={
                  buildPending
                    ? "Waiting for the build harness to pass (repo still Validating PoC / building) — submitting a patch now can get your AfterQuery account blocked"
                    : needsRevision && !isRevised
                    ? "Revise this task first — it was bounced back (too easy / needs revision)"
                    : "Submit the prepared patch mapped to this task (from <repo>_submission/ via fenrir.map.json)"
                }
              >
                Submit prepared patch
              </button>
              <button
                onClick={() => onAction({ action: "re-probe-finding", findingId: f.id }, f.submissionId)}
                disabled={busy === f.id}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-violet-300 hover:bg-neutral-800 disabled:opacity-40"
                title="Re-run the GPT-5.5 difficulty check"
              >
                Re-probe
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete task ${f.id}?`))
                    onAction({ action: "delete-finding", findingId: f.id }, f.submissionId);
                }}
                disabled={busy === f.id || !deletable}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-red-300 hover:bg-neutral-800 disabled:opacity-40"
                title={
                  deletable
                    ? "Delete this task"
                    : "Locked — the server won't delete a task once it's in verification or approved. Deletable only while Awaiting patch / rejected / needs-revision."
                }
              >
                {deletable ? "Delete" : "Delete 🔒"}
              </button>
            </span>
          </div>

          {buildPending && (
            <div className="rounded border border-amber-800/70 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-300">
              ⏳ Build harness not verified yet (still Validating PoC / building). Patch submission is
              locked until this repo passes — submitting a patch before it&apos;s verified can get your
              AfterQuery account blocked.
            </div>
          )}

          {/* Review feedback — "Rejected — …" or "Too easy — …" (AfterQuery style). */}
          <FindingFeedback f={f} />

          {/* Contributor description (the terse task description you submit). */}
          {f.description && (
            <p className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300">
              <span className="text-neutral-500">Your description: </span>
              {f.description}
            </p>
          )}

          {/* Crash details — the generated summary (AfterQuery's "Crash details"). */}
          {f.crash?.generatedDescription && (
            <details className="rounded border border-neutral-800 bg-neutral-950">
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-neutral-300">
                Crash details
              </summary>
              <div className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-neutral-300">
                {f.crash.generatedDescription}
              </div>
            </details>
          )}

          {/* Sanitizer output, labelled by detected sanitizer (e.g. AddressSanitizer). */}
          {f.crash?.sanitizerOutput && (
            <details className="rounded border border-red-900/60 bg-neutral-950">
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-red-300">
                {sanitizerLabel(f.crash.sanitizerOutput)}
              </summary>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-red-900/60 px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
                {f.crash.sanitizerOutput}
              </pre>
            </details>
          )}

          <div className="flex flex-wrap gap-4">
            <TaskDescriptionEditor finding={f} busy={busy} postTo={postTo} />
            <FindingPatchForm
              finding={f}
              busy={busy}
              postTo={postTo}
              locked={locked}
              lockReason={
                buildPending
                  ? "Waiting for the build harness to pass (repo still Validating PoC / building) — submitting a patch now can get your AfterQuery account blocked"
                  : "Revise this task first — it was bounced back (too easy / needs revision)"
              }
            />
          </div>

          {/* Raw finding fields — use this to find the exact stage field name
              (e.g. what carries "Quick Screen" / "Difficulty" for the bar). */}
          <details className="rounded border border-neutral-800 bg-neutral-950">
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-neutral-500">
              Raw finding JSON
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-neutral-800 px-3 py-2 text-[10px] leading-relaxed text-neutral-500">
              {JSON.stringify(f, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/** Inline task-description editor with Fenrir's quality gate baked in
 *  (≤600 chars / ≤80 words / 1–3 sentences + fix-word linter). */
function TaskDescriptionEditor({
  finding: f,
  busy,
  postTo,
}: {
  finding: FenrirFinding;
  busy: string;
  postTo: (
    url: string,
    payload: Record<string, unknown>,
    refreshId?: string,
    busyKey?: string
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(f.description || "");
  const a = analyzeDescription(text);
  const busyKey = `desc:${f.id}`;

  const save = async () => {
    if (!a.ok) return;
    const ok = await postTo(
      "/api/fenrir/action",
      { action: "revise-finding", findingId: f.id, description: text.trim() },
      f.submissionId,
      busyKey
    );
    if (ok) setOpen(false);
  };

  const counter = (label: string, n: number, max: number, over: boolean) => (
    <span className={over ? "text-red-400" : n > max * 0.85 ? "text-amber-400" : "text-neutral-500"}>
      {label} {n}/{max}
    </span>
  );

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-sky-400 hover:text-sky-300"
      >
        {open ? "Cancel description" : "Edit description"}
      </button>
      {open && (
        <div className="mt-2 w-[min(28rem,90vw)] space-y-2">
          {f.crash?.generatedDescription && (
            <details className="text-xs">
              <summary className="cursor-pointer text-neutral-500">
                Generated summary (reference — distill, don&apos;t paste)
              </summary>
              <p className="mt-1 rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
                {f.crash.generatedDescription}
              </p>
            </details>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck
            placeholder="Bug class + function/file + triggering input/condition. Describe the bug, never the fix."
            className={`w-full resize-y rounded border bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-sky-600 ${
              a.empty || a.ok ? "border-neutral-700" : "border-red-700"
            }`}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {counter("chars", a.chars, MAX_CHARS, a.overChars)}
            {counter("words", a.words, MAX_WORDS, a.overWords)}
            <span className={a.tooManySentences ? "text-red-400" : "text-neutral-500"}>
              sentences {a.sentences}/{MAX_SENTENCES}
            </span>
          </div>
          {a.fixHits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-amber-400">
              <span>⚠ may reveal the fix:</span>
              {a.fixHits.map((h) => (
                <span key={h} className="rounded bg-amber-950/60 px-1.5 py-0.5">
                  {h}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={save}
            disabled={!a.ok || busy === busyKey}
            className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            title={!a.ok ? "Fix the limits before saving" : "Save description"}
          >
            {busy === busyKey ? "Saving…" : "Save description"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Per-task patch submission: a unified diff + filename. Local state so each
 *  task card edits independently. */
function FindingPatchForm({
  finding,
  busy,
  postTo,
  locked = false,
  lockReason = "Revise this task first — it was bounced back (too easy / needs revision)",
}: {
  finding: FenrirFinding;
  busy: string;
  postTo: (
    url: string,
    payload: Record<string, unknown>,
    refreshId?: string,
    busyKey?: string
  ) => Promise<boolean>;
  locked?: boolean;
  lockReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [patchText, setPatchText] = useState("");
  const [patchFileName, setPatchFileName] = useState("fix.patch");
  const [desc, setDesc] = useState(finding.description || finding.crash?.generatedDescription || "");
  const busyKey = `patch:${finding.id}`;
  const submissionId = finding.submissionId || finding.id.split(":")[0];
  const da = analyzeDescription(desc);

  const onPatchFile = async (file: File | undefined) => {
    if (!file) return;
    setPatchText(await file.text());
    setPatchFileName(file.name);
  };

  const submit = async () => {
    if (!patchText.trim() || !desc.trim()) return;
    const ok = await postTo(
      "/api/fenrir/submit-patch",
      {
        submissionId,
        findingId: finding.id,
        patchText,
        patchFileName: patchFileName.trim() || "fix.patch",
        description: desc.trim(),
      },
      submissionId,
      busyKey
    );
    if (ok) {
      setPatchText("");
      setOpen(false);
    }
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-sky-400 hover:text-sky-300"
      >
        {open ? "Cancel patch" : "Submit patch"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-neutral-400">Task description (required, submitted with the patch):</div>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Bug class + function/file + trigger. Describe the bug, never the fix."
            rows={3}
            className={`w-full resize-y rounded border bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-sky-600 ${
              desc.trim() && da.ok ? "border-neutral-700" : "border-amber-700"
            }`}
          />
          <div className="flex flex-wrap gap-x-3 text-[10px] text-neutral-500">
            <span className={da.overChars ? "text-red-400" : ""}>chars {da.chars}/{MAX_CHARS}</span>
            <span className={da.overWords ? "text-red-400" : ""}>words {da.words}/{MAX_WORDS}</span>
            <span className={da.tooManySentences ? "text-red-400" : ""}>sentences {da.sentences}/{MAX_SENTENCES}</span>
            {da.fixHits.length > 0 && <span className="text-amber-400">⚠ may reveal fix: {da.fixHits.join(", ")}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
            <span>Patch file:</span>
            <input
              type="file"
              accept=".patch,.diff,text/plain"
              onChange={(e) => onPatchFile(e.target.files?.[0])}
              className="text-xs text-neutral-400 file:mr-2 file:rounded file:border file:border-neutral-700 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-200"
            />
            <span className="text-neutral-600">or paste below</span>
          </div>
          <textarea
            value={patchText}
            onChange={(e) => setPatchText(e.target.value)}
            placeholder="Paste the unified diff (git diff / fix.patch contents)…"
            rows={6}
            spellCheck={false}
            className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-200 outline-none focus:border-sky-600"
          />
          <div className="flex items-center gap-2">
            <input
              value={patchFileName}
              onChange={(e) => setPatchFileName(e.target.value)}
              className="w-40 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-sky-600"
            />
            <button
              onClick={submit}
              disabled={!patchText.trim() || !desc.trim() || busy === busyKey || locked}
              title={
                locked
                  ? lockReason
                  : !desc.trim()
                  ? "A task description is required"
                  : "Submit patch + description"
              }
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === busyKey ? "Submitting…" : "Submit patch"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
