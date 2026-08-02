/**
 * Maps a Fenrir submission / finding onto an ordered list of lifecycle steps so
 * the UI can render a progress bar. Mirrors the Silver pipeline-view approach
 * (lib/silverPipeline.ts) but for Fenrir's REST lifecycle.
 *
 * Submission lifecycle:  Submitted → Fuzzing → Findings → Review → Done
 * Finding lifecycle:     Crash → Patch → Difficulty → Result
 *
 * Field sources (all live-confirmed):
 *   submission.pipelineStage  initial_fuzzing_pending | findings_ready | rejected | failed
 *   submission.phase          running | blocked | terminal
 *   submission.status         Verifying | Action Required | Failed | Rejected
 *   submission.fuzzResult      present once a crash is found
 *   finding.pipelineStage     awaiting_patch | patch_submitted | approved | rejected | failed
 *   finding.status            Action Required | Verifying | Approved | …
 */

import type { FenrirSubmission, FenrirFinding } from "@/lib/fenrir";

export type StepState = "done" | "active" | "blocked" | "pending" | "failed";

export interface ProgressStep {
  key: string;
  label: string;
  state: StepState;
}

export interface FenrirProgress {
  steps: ProgressStep[];
  /** 0–1 fraction of the bar to fill (active steps count as half). */
  percent: number;
  /** True if a step hard-failed / was rejected (renders the bar red). */
  failed: boolean;
  /** True if bounced back to revise ("too easy" / needs revision) — amber, not
   *  a hard failure. */
  warn?: boolean;
  /** True if a step is actively processing (pulse the bar). */
  active: boolean;
  /** Short human label for the current position (shown next to the bar). */
  currentLabel: string;
  /** Optional pill/badge text override (e.g. "Validating PoC", "Needs
   *  Revision"). Falls back to the finding's own status when absent. */
  pill?: string;
}

function looksFailed(s = ""): boolean {
  return /reject|fail/i.test(s);
}

function summarize(steps: ProgressStep[]): FenrirProgress {
  const score = steps.reduce(
    (n, s) => n + (s.state === "done" ? 1 : s.state === "active" || s.state === "blocked" ? 0.5 : 0),
    0
  );
  const current =
    steps.find((s) => s.state === "active" || s.state === "blocked" || s.state === "failed") ??
    [...steps].reverse().find((s) => s.state === "done");
  return {
    steps,
    percent: steps.length ? score / steps.length : 0,
    failed: steps.some((s) => s.state === "failed"),
    active: steps.some((s) => s.state === "active"),
    currentLabel: current?.label ?? "—",
  };
}

/** Progress for a submission (findings optional — the list view has none yet). */
export function submissionProgress(
  s: FenrirSubmission,
  findings: FenrirFinding[] = []
): FenrirProgress {
  const stage = s.pipelineStage ?? "";
  const phase = s.phase ?? "";

  // A submission whose FUZZING pipeline failed (build failed a static-safety
  // check, infra died, …) but which still has LIVE findings is NOT a rejected
  // submission — those findings came from submitted PoCs and are still being
  // verified or already completed. The findings drive the bar; never show red.
  const pipelineFailed = looksFailed(stage) || looksFailed(s.status) || looksFailed(s.step);
  const liveFindings = findings.filter((f) => !isHardRejected(f));
  if (pipelineFailed && liveFindings.length > 0) {
    const working = liveFindings.some((f) => {
      const b = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${f.step ?? ""}`.toLowerCase();
      return !/approv|accept|complet|review.?ready|very.?hard|in.?band|bundle|flag/.test(b);
    });
    return summarize([
      { key: "submitted", label: "Submitted", state: "done" },
      { key: "fuzzing", label: "Fuzzing", state: "done" },
      { key: "findings", label: "Findings", state: "done" },
      { key: "review", label: working ? "Verifying" : "Review", state: working ? "active" : "done" },
      { key: "done", label: "Done", state: working ? "pending" : "done" },
    ]);
  }

  const fail = pipelineFailed;
  const terminal = phase === "terminal";
  const fuzzing = stage === "initial_fuzzing_pending" || s.step === "fuzz";
  const hasFindings = findings.length > 0 || stage === "findings_ready" || !!s.fuzzResult;
  const blocked = phase === "blocked" || s.status === "Action Required";

  const submitted: StepState = "done";

  const fuzz: StepState = fuzzing ? (blocked ? "blocked" : "active") : "done";

  const find: StepState = hasFindings
    ? "done"
    : fuzzing
    ? "pending"
    : "active";

  let review: StepState;
  if (terminal && !fail) review = "done";
  else if (hasFindings && !terminal) review = blocked ? "blocked" : "active";
  else review = "pending";

  let done: StepState;
  if (fail) done = "failed";
  else if (terminal) done = "done";
  else done = "pending";

  const steps: ProgressStep[] = [
    { key: "submitted", label: "Submitted", state: submitted },
    { key: "fuzzing", label: "Fuzzing", state: fuzz },
    { key: "findings", label: "Findings", state: find },
    { key: "review", label: "Review", state: review },
    { key: "done", label: fail ? "Rejected" : "Done", state: done },
  ];
  // If the whole thing failed, anything still pending/active before the end is moot.
  if (fail) {
    for (const st of steps) if (st.state === "active" || st.state === "blocked") st.state = "failed";
  }
  return summarize(steps);
}

// ── Fenrir verification sub-stages (from the finding's real pipeline fields) ──
// After a patch is submitted a finding runs, in order:
//   Verifying       — re-running the crashing input against the fix
//                     (step "verify" / patchVerification)
//   Quick Screen    — difficulty probe pending (step "probe",
//                     pipelineStage "difficulty_probe_pending", no probeProgress)
//   Difficulty Check— probe running (probeProgress.done of .total)
//   Submission Check— probe complete (done === total), finalizing
// Field names confirmed from live finding JSON.

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

interface ProbeProgress {
  phase?: string; // "prefilter" (Sonnet, 3 tries) | "probe" (GPT-5.5, ~10 tries)
  done?: number;
  total?: number;
}

/** The fine verification sub-stage (step 1..10 + label) for a patch-submitted
 *  finding, derived from `step` / `pipelineStage` / `probeProgress`. */
function verifySubStage(f: FenrirFinding): { step: number; label: string } {
  const o = f as unknown as Record<string, unknown>;
  const stage = (f.pipelineStage ?? "").toLowerCase();
  const step = (f.step ?? "").toLowerCase();
  const probe = (o.probeProgress ?? null) as ProbeProgress | null;

  // Not yet in the review phase → still verifying the patch itself.
  const inProbe = step === "probe" || /probe/.test(stage);
  if (!inProbe) return { step: 5, label: "Verifying" };

  // `probeProgress.phase` is the real distinguisher:
  //   "prefilter" → Sonnet pre-filter (3 tries) = QUICK SCREEN
  //   "probe"     → GPT-5.5 difficulty probe (~10 tries) = DIFFICULTY CHECK
  // No progress yet = probe pending = still the quick screen.
  const phase = probe && typeof probe.phase === "string" ? probe.phase.toLowerCase() : "";
  const total = probe && typeof probe.total === "number" && probe.total > 0 ? probe.total : 0;
  const done = probe && typeof probe.done === "number" ? probe.done : 0;

  const inDifficulty = phase === "probe" || (!phase && total > 5);
  if (inDifficulty) {
    // All probe runs done → finalizing / submission check.
    if (total && done >= total) return { step: 10, label: "Submission Check" };
    return { step: 9, label: "Difficulty Check" };
  }
  // Pre-filter running, or probe pending → Quick Screen.
  return { step: 7, label: "Quick Screen" };
}

/** A finding bounced back to revise — "too easy" or an explicit needs-revision —
 *  is NOT a hard rejection: show it amber, keep it revisable, and don't count it
 *  among the rejected. Reads status/stage/step plus the review-reason fields. */
export function findingNeedsRevision(f: FenrirFinding): boolean {
  const o = f as unknown as Record<string, unknown>;
  const reason = readStr(o, [
    "rejectionReason", "rejectReason", "reason", "feedback", "reviewFeedback",
    "whatToDo", "statusMessage", "displayStatus", "verdict", "result", "note", "notes",
  ]);
  const blob = `${f.status ?? ""} ${f.pipelineStage ?? ""} ${f.step ?? ""} ${reason}`.toLowerCase();
  return /too.?easy|too.?simple|needs.?revision|revision|make it harder|easiness/.test(blob);
}

/** A hard rejection / failure (red, terminal) — the single source of truth for
 *  BOTH the red bar and the "rejected" counts, so they can never disagree.
 *  Excludes "too easy"/needs-revision (amber) and accepted. Checks status,
 *  pipelineStage AND step so a reject signal in any of them counts. */
export function isHardRejected(f: FenrirFinding): boolean {
  if (findingNeedsRevision(f)) return false;
  // Awaiting a patch / action-required is NOT a failure — it's waiting on you to
  // upload a patch. Never red, never counted as rejected.
  if (/await/i.test(f.pipelineStage ?? "") || f.status === "Action Required") return false;
  const approved =
    /approv|accept/i.test(f.pipelineStage ?? "") || /approv|accept/i.test(f.status ?? "");
  if (approved) return false;
  // Only the authoritative status / pipelineStage decide a hard rejection — NOT
  // `step`, which carries transient values (e.g. during a patch re-run) that
  // would otherwise flash a false "Failed" right after you submit.
  const blob = `${f.status ?? ""} ${f.pipelineStage ?? ""}`.toLowerCase();
  return /reject|fail/.test(blob);
}

/** Progress for one finding on the 10-step Crash → Patch → Verify (Quick Screen
 *  → Difficulty Check → Submission Check) → Result track. `currentLabel` is the
 *  fine sub-stage shown next to the bar; `percent` positions the frontier cell.
 *  "Too easy" / needs-revision is amber (warn), never a red hard failure. */
export function findingProgress(f: FenrirFinding): FenrirProgress {
  const stage = f.pipelineStage ?? "";
  const status = f.status ?? "";
  const step = (f.step ?? "").toLowerCase();
  const needsRevision = findingNeedsRevision(f);
  const approved = /approv|accept/i.test(stage) || /approv|accept/i.test(status);
  const fail = isHardRejected(f); // same predicate as the "rejected" counts
  // PoC submitted and being validated — this is BEFORE any patch. Not a failure:
  // shown amber (a patch is still owed) at 5 of 10 filled.
  const validatingPoc =
    /poc_validat|validating_poc|poc_intake/i.test(stage) || step === "poc_intake";
  // Difficulty probe passed — any passing band (in band / very hard / needs
  // bundle / quality flagged / review ready) → the task is complete. Full green
  // bar; the pill keeps the specific band text.
  const reviewReady = /review|in.?band|very.?hard|bundle|flag/i.test(`${status} ${stage}`);

  let stepNum: number;
  let label: string;
  let pill: string | undefined;
  let verify: StepState;
  let result: StepState;
  let active = false;

  if (approved) {
    stepNum = 10;
    label = "Accepted";
    verify = "done";
    result = "done";
  } else if (needsRevision) {
    stepNum = 10;
    label = "Needs Revision";
    pill = "Needs Revision";
    verify = "blocked";
    result = "blocked";
  } else if (reviewReady) {
    // In band → done. Full green bar, "Complete", still under "in progress".
    stepNum = 10;
    label = "Complete";
    verify = "done";
    result = "done";
  } else if (validatingPoc) {
    stepNum = 6; // → 5 filled cells
    label = "Validating PoC";
    pill = "Validating PoC";
    verify = "active";
    result = "pending";
  } else if (/await/i.test(stage) || status === "Action Required") {
    // Patch not uploaded yet — earliest step, a single green dot (not a failure).
    stepNum = 2;
    label = "Awaiting patch";
    verify = "blocked";
    result = "pending";
  } else if (fail) {
    stepNum = 10;
    label = /reject/i.test(`${stage} ${status}`) ? "Rejected" : "Failed";
    verify = "failed";
    result = "failed";
  } else {
    const sub = verifySubStage(f);
    stepNum = sub.step;
    label = sub.label;
    verify = "active";
    result = "pending";
    active = true;
  }

  const warn = needsRevision || validatingPoc;
  const patch: StepState = stepNum <= 2 && !approved && !fail ? "active" : "done";
  const steps: ProgressStep[] = [
    { key: "crash", label: "Crash", state: "done" },
    { key: "patch", label: "Patch", state: patch },
    { key: "verify", label, state: verify },
    {
      key: "result",
      label: approved ? "Accepted" : needsRevision ? "Needs Revision" : fail ? "Rejected" : "Result",
      state: result,
    },
  ];

  return {
    steps,
    // Terminal-ish states (accepted / rejected / needs-revision / complete) fill
    // fully; everything else positions by step.
    percent: approved || fail || needsRevision || reviewReady ? 1 : Math.max(0.1, (stepNum - 1) / 10),
    failed: fail,
    warn,
    active,
    currentLabel: label,
    pill,
  };
}
