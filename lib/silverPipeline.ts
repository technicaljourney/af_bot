/**
 * Build a Pluto-style pipeline view for a Silver submission.
 *
 * Silver's pipeline (in order) is:
 *   1. similarity            — Similarity & Diversity
 *   2. gptZeroCheck          — AI text check
 *   3. rubricReview          — Quality review
 *   4. taskImageBuild        — Task image build
 *   5. oracleCheck           — Oracle check
 *   6. nullCheck             — Nop check
 *   7. easinessProbe         — Easiness Prefilter (Sonnet 4.6)
 *   8. difficultyProbe       — Difficulty Probe (Opus 4.8)
 *
 * Each stage in `submission.pipeline.<stageKey>` is an object with at least
 * `status` ("passed" | "failed" | "error" | "running" | ...) plus stage-specific
 * fields (nearestDistance, decision, reward, passed/attempts, etc.).
 *
 * Top-level pipeline fields used:
 *   - failedStage     — name of the stage that failed
 *   - failureKind     — "infra" | other
 *   - failureReason   — human-readable error
 *   - completedAt     — set when the whole pipeline is done
 *   - stage           — coarse pipeline state ("failed", "running", ...)
 */

export type SilverStageStatus =
  | "done"
  | "running"
  | "pending"
  | "failed"
  | "skipped";

export interface SilverStageView {
  key: string;
  label: string;
  status: SilverStageStatus;
  costUsd: number | null;
  summary: string | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}

export interface SilverPipelineView {
  overallStatus: string | null;
  pipelineStage: string | null;
  completed: boolean;
  failed: boolean;
  currentStep: number;
  totalSteps: number;
  spentUsd: number | null;
  failureMessage: string | null;
  failedStage: string | null;
  failureKind: string | null;
  stages: SilverStageView[];
}

const SILVER_STAGE_DEFS: Array<{
  key: string;
  label: string;
  costKey?: string;
}> = [
  { key: "similarity", label: "Similarity & Diversity" },
  { key: "gptZeroCheck", label: "AI text check" },
  { key: "rubricReview", label: "Quality review", costKey: "rubricReviewUsd" },
  { key: "taskImageBuild", label: "Task image build" },
  { key: "oracleCheck", label: "Oracle check" },
  { key: "nullCheck", label: "Nop check" },
  { key: "easinessProbe", label: "Easiness Prefilter (Sonnet 4.6)", costKey: "easinessProbeUsd" },
  { key: "difficultyProbe", label: "Difficulty Probe (Opus 4.8)", costKey: "difficultyProbeUsd" },
  { key: "fairnessReview", label: "Fairness review", costKey: "fairnessReviewUsd" },
];

export function buildSilverPipelineView(submission: unknown): SilverPipelineView {
  if (!submission || typeof submission !== "object") {
    return emptyView();
  }
  const s = submission as Record<string, unknown>;
  const p = (s.pipeline as Record<string, unknown>) ?? {};
  const overallStatus = (s.status as string | null | undefined) ?? null;
  const pipelineStage = (p.stage as string | null | undefined) ?? null;
  const rawFailedStage = (p.failedStage as string | null | undefined) ?? null;
  const failureKind = (p.failureKind as string | null | undefined) ?? null;
  const rawFailureReason = (p.failureReason as string | null | undefined) ?? null;
  const completed = Boolean(p.completedAt);
  // `failedStage` / `failed` / `failureMessage` are finalised AFTER the stage
  // loop so verdict-driven failures (TOO_EASY, TOO_HARD detected from the
  // pass/attempts numbers) propagate up to the header even when the raw
  // server data only carries `status: "passed"`.
  let failedStage: string | null = rawFailedStage;

  const costBreakdown =
    ((s.costBreakdown as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const totalCost =
    typeof costBreakdown.totalUsd === "number"
      ? costBreakdown.totalUsd
      : typeof s.pipelineCostUsd === "number"
      ? (s.pipelineCostUsd as number)
      : null;

  let foundFailed = false;
  const stages: SilverStageView[] = SILVER_STAGE_DEFS.map((def) => {
    const stageData = p[def.key];
    const isThisFailed = failedStage === def.key;
    let st: SilverStageStatus;
    let summary: string | null = null;
    let error: string | null = null;
    let stageStatus: string | null = null;

    if (stageData && typeof stageData === "object") {
      const sd = stageData as Record<string, unknown>;
      stageStatus = (sd.status as string) ?? null;
      error = (sd.error as string) ?? null;
      summary = summarizeStage(def.key, sd);

      // Probe verdict overrides the raw `status` field. AfterQuery reports
      // `status: "passed"` to mean "the probe ran" — the real verdict is in
      // the (passed/attempts) numbers:
      //   - Easiness Prefilter (Sonnet, 5 runs): Sonnet should fail ≥2.
      //     If Sonnet passes 4 or 5 → task is TOO_EASY (failure).
      //   - Difficulty Probe (Opus, 10 runs): Opus should fail ≥6, but not
      //     all 10. So passed === 0 → TOO_HARD (Unverifiable), passed > 4 →
      //     TOO_EASY, else GOOD.
      const verdict = probeVerdict(def.key, sd);

      if (
        isThisFailed ||
        stageStatus === "failed" ||
        stageStatus === "error" ||
        verdict?.fail === true
      ) {
        st = "failed";
        foundFailed = true;
      } else if (stageStatus === "passed" || stageStatus === "pass") {
        st = "done";
      } else if (foundFailed) {
        st = "skipped";
      } else if (completed) {
        st = "done";
      } else if (stageStatus === "running") {
        st = "running";
      } else {
        // Has data but no clear status — assume running while pipeline is open.
        st = completed ? "done" : "running";
      }
    } else {
      // No data for this stage.
      if (foundFailed) st = "skipped";
      else if (completed) st = "skipped";
      else st = "pending";
    }

    const costUsd =
      def.costKey && typeof costBreakdown[def.costKey] === "number"
        ? (costBreakdown[def.costKey] as number)
        : null;

    return {
      key: def.key,
      label: def.label,
      status: st,
      costUsd,
      summary,
      error,
      detail: (stageData as Record<string, unknown>) ?? null,
    };
  });

  const totalSteps = SILVER_STAGE_DEFS.length;
  const doneCount = stages.filter((x) => x.status === "done").length;
  const runningIdx = stages.findIndex((x) => x.status === "running");
  const failedIdx = stages.findIndex((x) => x.status === "failed");

  // Propagate verdict-driven failures up to the header.
  const failed = failedIdx >= 0 || Boolean(rawFailedStage);
  if (failed && !failedStage && failedIdx >= 0) {
    failedStage = stages[failedIdx].key;
  }
  let failureMessage: string | null = rawFailureReason;
  if (failed && !failureMessage && failedIdx >= 0) {
    const fs = stages[failedIdx];
    if (fs.summary) failureMessage = `${fs.label}: ${fs.summary}`;
    else if (fs.error) failureMessage = fs.error;
  }

  let currentStep: number;
  if (failedIdx >= 0) currentStep = failedIdx + 1;
  else if (completed) currentStep = totalSteps;
  else if (runningIdx >= 0) currentStep = runningIdx + 1;
  else currentStep = doneCount;

  // If a verdict failed but `pipeline.stage` claims otherwise, surface the
  // correct overall status string.
  const overallEffective =
    failed && (!overallStatus || /pass/i.test(overallStatus))
      ? "Validation Failed"
      : overallStatus;

  return {
    overallStatus: overallEffective,
    pipelineStage,
    completed,
    failed,
    currentStep,
    totalSteps,
    spentUsd: totalCost,
    failureMessage,
    failedStage,
    failureKind,
    stages,
  };
}

/** Returns the verdict for the Easiness/Difficulty probes based on the
 *  pass/attempts numbers. Used both to set the stage status and to enrich the
 *  inline summary string. Returns null for non-probe stages. */
function probeVerdict(
  key: string,
  sd: Record<string, unknown>
): { fail: boolean; label: "TOO_EASY" | "TOO_HARD" | "OK" | "GOOD" } | null {
  const passed = sd.passed;
  const attempts = sd.attempts;
  if (typeof passed !== "number" || typeof attempts !== "number") return null;
  if (key === "easinessProbe") {
    // Sonnet should fail at least 2 of 5 → pass ≤ 3 is OK. Pass ≥ 4 = TOO_EASY.
    if (passed >= 4) return { fail: true, label: "TOO_EASY" };
    return { fail: false, label: "OK" };
  }
  if (key === "difficultyProbe") {
    // Opus should fail at least 6 of 10 (pass ≤ 4), but must not fail all
    // (pass ≥ 1). So pass === 0 = TOO_HARD, pass > 4 = TOO_EASY, else GOOD.
    if (passed === 0) return { fail: true, label: "TOO_HARD" };
    if (passed > 4) return { fail: true, label: "TOO_EASY" };
    return { fail: false, label: "GOOD" };
  }
  return null;
}

function summarizeStage(
  key: string,
  sd: Record<string, unknown>
): string | null {
  switch (key) {
    case "similarity": {
      const parts: string[] = [];
      if (typeof sd.nearestDistance === "number") {
        parts.push(`${(sd.nearestDistance * 100).toFixed(1)}% nearest`);
      }
      if (typeof sd.nearestTaskName === "string" && sd.nearestTaskName) {
        parts.push(sd.nearestTaskName as string);
      }
      if (sd.blocked === true) parts.push("blocked");
      return parts.length ? parts.join(" · ") : null;
    }
    case "gptZeroCheck": {
      const inst = sd.instruction as Record<string, unknown> | undefined;
      if (inst && typeof inst.score === "number") {
        return `instr ${(inst.score * 100).toFixed(0)}%`;
      }
      return null;
    }
    case "rubricReview":
      return typeof sd.decision === "string" ? (sd.decision as string) : null;
    case "taskImageBuild":
      return typeof sd.imageRef === "string"
        ? (sd.imageRef as string).split("/").pop() ?? null
        : null;
    case "oracleCheck":
    case "nullCheck":
      return typeof sd.reward === "number" ? `reward ${sd.reward}` : null;
    case "easinessProbe":
    case "difficultyProbe": {
      const parts: string[] = [];
      if (typeof sd.passed === "number" && typeof sd.attempts === "number") {
        parts.push(`pass ${sd.passed}/${sd.attempts}`);
      } else if (typeof sd.attempts === "number") {
        parts.push(`${sd.attempts} attempts`);
      }
      const verdict = probeVerdict(key, sd);
      if (verdict) parts.push(verdict.label);
      else if (typeof sd.solveRate === "number") {
        parts.push(`${(sd.solveRate * 100).toFixed(0)}% solve`);
      }
      return parts.length ? parts.join(" · ") : null;
    }
    default:
      return null;
  }
}

function emptyView(): SilverPipelineView {
  return {
    overallStatus: null,
    pipelineStage: null,
    completed: false,
    failed: false,
    currentStep: 0,
    totalSteps: SILVER_STAGE_DEFS.length,
    spentUsd: null,
    failureMessage: null,
    failedStage: null,
    failureKind: null,
    stages: SILVER_STAGE_DEFS.map((def) => ({
      key: def.key,
      label: def.label,
      status: "pending" as const,
      costUsd: null,
      summary: null,
      error: null,
      detail: null,
    })),
  };
}
