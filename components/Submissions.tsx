"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SubmissionRow {
  id: string;
  fileName: string;
  domain: string;
  status: string;
  rejectionCount: number;
  language: string;
  version: string;
  submittedAt: string | null;
  lastUpdated: string | null;
  harborSubmissionId: string | null;
  stage: string | null;
}

type StageStatus = "done" | "running" | "pending" | "failed" | "skipped";

interface StageView {
  key: string;
  label: string;
  status: StageStatus;
  costUsd: number | null;
  summary: string | null;
  detail: unknown | null;
  error: string | null;
  retryNote: string | null;
}

interface PipelineView {
  overallStatus: string | null;
  pipelineStage: string | null;
  completed: boolean;
  failed: boolean;
  currentStep: number;
  totalSteps: number;
  spentUsd: number | null;
  failure: string | null;
  failureMessage: string | null;
  retrying: boolean;
  retryAttempt: number | null;
  retryMax: number | null;
  stages: StageView[];
  feedbackMarkdown: string;
  pipelineKeys: string[];
}

type DetailState = PipelineView | { error: string } | "loading" | undefined;

const POLL_MS = 10000;
const AUTO_KEY = "pluto.autoHandleFeedback";
/** Submission IDs the auto-handler itself created. Only these get cleaned up;
 *  pre-existing submissions are NEVER touched. Persisted across reloads. */
const AUTO_IDS_KEY = "pluto.autoSubmittedIds";
/** How long after a successful submit we still treat a fileName as "just submitted",
 *  to bridge the gap until the next /api/submissions poll reflects it. */
const JUST_SUBMITTED_MS = 30_000;
const MAX_LOG = 60;
/** Max times we'll delete-and-resubmit a fileName that hits the similarity
 *  hard block. After that we give up and just write the feedback JSON. */
const MAX_SIM_RETRIES = 5;
const SIM_RETRIES_KEY = "pluto.simRetries";
/** Cooling-off window after the auto-handler first sees a similarity /
 *  easiness rate-limit failure, before it deletes + resubmits. Gives the user
 *  time to review or intervene manually. */
const RETRY_DELAY_MS = 3 * 60 * 1000;

function isPipeline(d: DetailState): d is PipelineView {
  return !!d && typeof d === "object" && "stages" in d;
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("approv")) return "bg-emerald-900 text-emerald-200";
  if (s.includes("reject") || s.includes("fail")) return "bg-red-900 text-red-200";
  // "needs review" / "needs revision" → red (action required)
  if (s.includes("revision") || s.includes("needs")) return "bg-red-900 text-red-200";
  // "Review Ready" / "Ready for Review" → blue (passed pipeline, awaiting human)
  if (s.includes("ready") || s.includes("review")) return "bg-sky-900 text-sky-200";
  if (s.includes("run") || s.includes("progress") || s.includes("pending"))
    return "bg-amber-900 text-amber-200";
  return "bg-neutral-800 text-neutral-400";
}

function isActive(status: string): boolean {
  const s = (status || "").toLowerCase();
  return s.includes("running") || s.includes("progress") || s.includes("queued");
}

type RingVariant = "running" | "done" | "review" | "failed";

const RING_COLORS: Record<RingVariant, { ring: string; text: string }> = {
  running: { ring: "#38bdf8", text: "text-sky-400" }, // sky-400
  done: { ring: "#34d399", text: "text-emerald-400" }, // emerald-400
  review: { ring: "#38bdf8", text: "text-sky-400" },
  failed: { ring: "#f87171", text: "text-red-400" }, // red-400
};

function ProgressRing({
  current,
  total,
  variant,
}: {
  current: number;
  total: number;
  variant: RingVariant;
}) {
  const size = 26;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const pct = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
  const offset = circ * (1 - pct);
  const c = RING_COLORS[variant];
  return (
    <span className="inline-flex items-center gap-2">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#262626"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={c.ring}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.6s ease-out" }}
        />
      </svg>
      <span className={`text-sm font-semibold tabular-nums leading-none ${c.text}`}>
        {current}
        <span className="text-neutral-500">/{total}</span>
      </span>
    </span>
  );
}

function StepBadge({
  row,
  detail,
}: {
  row: { status: string };
  detail: DetailState;
}) {
  const pv = isPipeline(detail) ? detail : null;
  const total = pv?.totalSteps ?? 8;
  const cur = pv?.currentStep ?? total;
  const s = (row.status || "").toLowerCase();
  // Action required → red (check before "review" because "needs review" contains "review").
  if (
    s.includes("reject") ||
    s.includes("revision") ||
    s.includes("needs") ||
    s.includes("fail")
  ) {
    return <ProgressRing current={cur} total={total} variant="failed" />;
  }
  if (isActive(row.status)) {
    return (
      <ProgressRing current={pv?.currentStep ?? 0} total={total} variant="running" />
    );
  }
  // Terminal success states (Approved / Review Ready) — the status badge alone is enough.
  return null;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "done") return <span className="text-emerald-400">✓</span>;
  if (status === "failed") return <span className="text-red-400">✗</span>;
  if (status === "running")
    return (
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400 align-middle" />
    );
  // pending / skipped
  return <span className="inline-block h-3.5 w-3.5 rounded-full border border-neutral-700 align-middle" />;
}

export default function Submissions({ manualToken }: { manualToken: string }) {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [openStages, setOpenStages] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resubmittingId, setResubmittingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchResubmitting, setBatchResubmitting] = useState(false);

  const detailsRef = useRef(details);
  detailsRef.current = details;
  const tokenArg = manualToken || undefined;

  // ---- Auto-handle feedback (loop) -----------------------------------------
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [autoBusy, setAutoBusy] = useState(false);

  const rowsRef = useRef<SubmissionRow[]>(rows);
  rowsRef.current = rows;
  const autoRunningRef = useRef(false);
  const processedSubsRef = useRef<Set<string>>(new Set());
  const inFlightSubmitsRef = useRef<Set<string>>(new Set());
  /** fileName → expiry epoch ms; lets us ignore zips we just submitted while
   *  the AfterQuery submissions list hasn't reflected the new row yet. */
  const recentlySubmittedRef = useRef<Map<string, number>>(new Map());
  /** Dedup the "no domain in submission.md" warning so we log it once per
   *  fileName, not every 10s. */
  const warnedNoDomainRef = useRef<Set<string>>(new Set());
  /** Submission IDs the auto-handler itself submitted. Step 2 cleanup is
   *  restricted to this set so pre-existing submissions are never touched.
   *  Persisted to localStorage so the set survives reloads. */
  const autoSubmittedIdsRef = useRef<Set<string>>(new Set());
  const persistAutoIds = useCallback(() => {
    try {
      localStorage.setItem(
        AUTO_IDS_KEY,
        JSON.stringify(Array.from(autoSubmittedIdsRef.current))
      );
    } catch {
      /* ignore quota errors */
    }
  }, []);
  /** fileName → number of similarity-block delete+resubmit attempts. */
  const similarityRetryCountRef = useRef<Map<string, number>>(new Map());
  /** row.id → first-detected epoch ms for similarity / easiness rate-limit
   *  failures. Used to enforce a 3-min cooling window before retry. */
  const retryQueueRef = useRef<Map<string, number>>(new Map());
  const persistSimRetries = useCallback(() => {
    try {
      const obj: Record<string, number> = {};
      for (const [k, v] of similarityRetryCountRef.current) obj[k] = v;
      localStorage.setItem(SIM_RETRIES_KEY, JSON.stringify(obj));
    } catch {
      /* ignore quota errors */
    }
  }, []);

  useEffect(() => {
    try {
      setAutoEnabled(localStorage.getItem(AUTO_KEY) === "1");
      const raw = localStorage.getItem(AUTO_IDS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          autoSubmittedIdsRef.current = new Set(arr.filter((x) => typeof x === "string"));
        }
      }
      const sr = localStorage.getItem(SIM_RETRIES_KEY);
      if (sr) {
        const obj = JSON.parse(sr);
        if (obj && typeof obj === "object") {
          similarityRetryCountRef.current = new Map(
            Object.entries(obj).map(([k, v]) => [k, Number(v) || 0])
          );
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  const logAuto = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setAutoLog((l) => [`[${stamp}] ${msg}`, ...l].slice(0, MAX_LOG));
  }, []);

  const toggleAuto = (v: boolean) => {
    setAutoEnabled(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    logAuto(v ? "▶ auto handling ENABLED" : "■ auto handling disabled");
  };

  const autoTick = useCallback(async () => {
    if (autoRunningRef.current) return;
    autoRunningRef.current = true;
    setAutoBusy(true);
    try {
      // Step 1: scan task_zip and check submit-eligibility for EVERY zip in
      // the folder. Refreshes the AfterQuery submissions list first so the
      // same-name check uses current data, then walks the whole task list and
      // reports a summary so you can see all files were considered.
      try {
        // Evict expired "just submitted" entries.
        const now = Date.now();
        for (const [k, exp] of recentlySubmittedRef.current) {
          if (exp <= now) recentlySubmittedRef.current.delete(k);
        }

        // Refresh submissions before scanning zips so knownFileNames reflects
        // the latest AfterQuery state. Falls back to the cached rowsRef on err.
        let currentRows = rowsRef.current;
        try {
          const refRes = await fetch("/api/submissions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenArg }),
          });
          const refData = await refRes.json();
          if (refData.ok && Array.isArray(refData.submissions)) {
            currentRows = refData.submissions;
            setRows(refData.submissions);
          }
        } catch {
          /* fall back to cached rowsRef */
        }

        const tRes = await fetch("/api/tasks", { cache: "no-store" });
        const tData = await tRes.json();
        if (tData.ok) {
          // Block submission whenever ANY same-name submission already exists
          // on AfterQuery — regardless of status. To re-submit, callers must
          // delete the existing one first (auto-retry does this via
          // deleteAndResubmit below; manual re-submits require a click on
          // Delete).
          const knownFileNames = new Set(currentRows.map((r) => r.fileName));
          const tasks = tData.tasks as Array<{
            fileName: string;
            domain: string;
            createdMs: number;
          }>;
          logAuto(`🔍 scanning task_zip · ${tasks.length} zips`);
          let submitted = 0;
          const skipCounts = { noDomain: 0, inFlight: 0, exists: 0, recent: 0, error: 0 };
          for (const t of tasks) {
            if (!t.domain || !t.domain.trim()) {
              skipCounts.noDomain++;
              if (!warnedNoDomainRef.current.has(t.fileName)) {
                warnedNoDomainRef.current.add(t.fileName);
                logAuto(`⚠ ${t.fileName} skipped — no domain in submission.md`);
              }
              continue;
            }
            if (inFlightSubmitsRef.current.has(t.fileName)) {
              skipCounts.inFlight++;
              continue;
            }
            if (knownFileNames.has(t.fileName)) {
              skipCounts.exists++;
              continue;
            }
            if (recentlySubmittedRef.current.has(t.fileName)) {
              skipCounts.recent++;
              continue;
            }
            inFlightSubmitsRef.current.add(t.fileName);
            try {
              const sRes = await fetch("/api/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fileName: t.fileName,
                  domain: t.domain,
                  token: tokenArg,
                }),
              });
              const sData = await sRes.json();
              if (sData.ok) {
                submitted++;
                recentlySubmittedRef.current.set(
                  t.fileName,
                  Date.now() + JUST_SUBMITTED_MS
                );
                if (sData.submissionId) {
                  autoSubmittedIdsRef.current.add(sData.submissionId);
                  persistAutoIds();
                }
                logAuto(`✓ submitted ${t.fileName} → ${sData.submissionId}`);
              } else if (sData.skipped) {
                skipCounts.exists++;
                recentlySubmittedRef.current.set(
                  t.fileName,
                  Date.now() + JUST_SUBMITTED_MS
                );
                logAuto(`⊘ skip ${t.fileName}: ${sData.error || "already-exists"}`);
              } else {
                skipCounts.error++;
                logAuto(`✗ submit ${t.fileName}: ${sData.error || "failed"}`);
              }
            } catch (e) {
              skipCounts.error++;
              logAuto(`✗ submit ${t.fileName}: ${(e as Error).message}`);
            } finally {
              inFlightSubmitsRef.current.delete(t.fileName);
            }
          }
          const totalSkipped =
            skipCounts.noDomain +
            skipCounts.inFlight +
            skipCounts.exists +
            skipCounts.recent +
            skipCounts.error;
          logAuto(
            `▪ scan done · checked=${tasks.length}, submitted=${submitted}, skipped=${totalSkipped} ` +
              `(exists=${skipCounts.exists}, recent=${skipCounts.recent}, ` +
              `no-domain=${skipCounts.noDomain}, in-flight=${skipCounts.inFlight}, error=${skipCounts.error})`
          );
        }
      } catch (e) {
        logAuto(`✗ scan zips: ${(e as Error).message}`);
      }

      // Step 2: process terminal submissions.
      // SAFETY:
      //   - Approved / Review-Ready rows: NEVER touched. The auto-handler
      //     does not write JSON, does not delete, does not log anything for them.
      //   - Pre-existing Needs-Review/failed rows: write the feedback JSON
      //     (read-only on AfterQuery — nothing deleted).
      //   - Auto-submitted needs-review/failed rows: stage-specific branching
      //     (delete + re-submit for similarity / easiness-rate-limit; JSON only
      //     for other failures).
      for (const row of rowsRef.current) {
        if (processedSubsRef.current.has(row.id)) continue;
        const s = (row.status || "").toLowerCase();
        const isReady = s.includes("ready") || s.includes("approv");
        const isNeeds =
          s.includes("revision") ||
          s.includes("needs") ||
          s.includes("reject") ||
          s.includes("fail");
        // Hard skip — approved/review-ready are off-limits to the auto-handler.
        if (isReady) continue;
        if (!isNeeds) continue;
        const isAutoSubmitted = autoSubmittedIdsRef.current.has(row.id);

        processedSubsRef.current.add(row.id);
        try {
          const jsonName = row.fileName.replace(/\.zip$/i, ".json");
          const saveJson = async (content: string) => {
            const fRes = await fetch("/api/feedback/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileName: row.fileName, content }),
            });
            const fData = await fRes.json();
            if (!fData.ok) throw new Error(`feedback save: ${fData.error || "failed"}`);
          };

          // After saving the feedback JSON for a non-retry failure, delete the
          // submission on AfterQuery and remove the local zip. The user can
          // then drop a fresh (revised) zip into task_zip/ to re-submit.
          const deleteSubmissionAndZip = async () => {
            const delRes = await fetch("/api/delete-submission", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                submissionId: row.id,
                harborSubmissionId: row.harborSubmissionId ?? undefined,
                token: tokenArg,
              }),
            });
            const delData = await delRes.json();
            if (!delData.ok) {
              logAuto(`⚠ delete ${row.id}: ${delData.error || "failed"}`);
              return;
            }
            logAuto(`✓ deleted submission ${row.id}`);
            const zRes = await fetch("/api/zip/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileName: row.fileName }),
            });
            const zData = await zRes.json();
            if (!zData.ok) {
              logAuto(`⚠ remove zip ${row.fileName}: ${zData.error || "failed"}`);
            } else {
              logAuto(`✓ removed zip ${row.fileName}`);
            }
            autoSubmittedIdsRef.current.delete(row.id);
            persistAutoIds();
            setRows((rs) => rs.filter((r) => r.id !== row.id));
          };

          // Delete the failed submission, AWAIT the API response, then
          // immediately re-submit the same zip with the same domain. The two
          // calls run sequentially within this tick — the re-submit only fires
          // after delete-submission has returned ok.
          const deleteAndResubmit = async (label: string) => {
            const delRes = await fetch("/api/delete-submission", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                submissionId: row.id,
                harborSubmissionId: row.harborSubmissionId ?? undefined,
                token: tokenArg,
              }),
            });
            const delData = await delRes.json();
            if (!delData.ok)
              throw new Error(`delete submission: ${delData.error || "failed"}`);
            logAuto(`✓ ${label}: deleted ${row.id}`);
            autoSubmittedIdsRef.current.delete(row.id);
            persistAutoIds();
            setRows((rs) => rs.filter((r) => r.id !== row.id));

            // Now re-submit — runs only after the await above resolved.
            recentlySubmittedRef.current.delete(row.fileName);
            inFlightSubmitsRef.current.add(row.fileName);
            try {
              const sRes = await fetch("/api/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fileName: row.fileName,
                  domain: row.domain,
                  token: tokenArg,
                }),
              });
              const sData = await sRes.json();
              if (sData.ok) {
                recentlySubmittedRef.current.set(
                  row.fileName,
                  Date.now() + JUST_SUBMITTED_MS
                );
                if (sData.submissionId) {
                  autoSubmittedIdsRef.current.add(sData.submissionId);
                  persistAutoIds();
                }
                logAuto(`✓ re-submitted ${row.fileName} → ${sData.submissionId}`);
              } else if (sData.skipped) {
                logAuto(
                  `⊘ re-submit skip ${row.fileName}: ${sData.error || "already-alive"}`
                );
              } else {
                logAuto(`✗ re-submit ${row.fileName}: ${sData.error || "failed"}`);
              }
            } catch (e) {
              logAuto(`✗ re-submit ${row.fileName}: ${(e as Error).message}`);
            } finally {
              inFlightSubmitsRef.current.delete(row.fileName);
            }
          };

          // Gate for similarity / easiness-rate-limit delete+resubmit: only
          // proceed once at least RETRY_DELAY_MS has passed since we first
          // detected this row. The first call logs a "waiting" message, sets
          // the timer, removes the row from `processedSubsRef` so the next
          // tick re-evaluates, and returns false. Subsequent calls within the
          // window silently re-defer. Once the window has elapsed, the entry
          // is cleared and the call returns true so the retry proceeds.
          const isRetryReady = (label: string): boolean => {
            const firstSeen = retryQueueRef.current.get(row.id);
            if (!firstSeen) {
              retryQueueRef.current.set(row.id, Date.now());
              logAuto(
                `⏳ ${row.fileName}: ${label} detected · waiting ${
                  RETRY_DELAY_MS / 60000
                }min before delete+resubmit so you can check manually`
              );
              processedSubsRef.current.delete(row.id);
              return false;
            }
            const elapsed = Date.now() - firstSeen;
            if (elapsed < RETRY_DELAY_MS) {
              processedSubsRef.current.delete(row.id);
              return false;
            }
            retryQueueRef.current.delete(row.id);
            return true;
          };

          // Needs Review / failed only — approved/ready is hard-skipped above.
          {
            const dRes = await fetch("/api/pipeline-detail", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ submissionId: row.id, token: tokenArg }),
            });
            const dData = await dRes.json();
            const pipeline = dData.ok ? dData.pipeline : null;
            const failedStage = pipeline?.stages?.find(
              (st: { status: string }) => st.status === "failed"
            ) as
              | {
                  label?: string;
                  error?: string;
                  retryNote?: string;
                  detail?: unknown;
                }
              | undefined;
            const stageLabel = (failedStage?.label || "").toLowerCase();
            const feedbackContent =
              (pipeline?.feedbackMarkdown as string) ||
              `# ${row.fileName}\nstatus: ${row.status}\n(no detail available)`;

            // Pre-compute condition flags so we can pick the right branch
            // without nesting the checks inside an else-if for easiness.
            const errSources = [
              failedStage?.error,
              pipeline?.failureMessage,
              pipeline?.failure,
            ]
              .filter(Boolean)
              .map((s) => String(s).toLowerCase());
            const isRateLimit = errSources.some(
              (m) =>
                m.includes("temporarily over capacity") ||
                m.includes("rate-limited") ||
                m.includes("took too long to respond") ||
                m.includes("retrying automatically")
            );
            // Infrastructure error: AfterQuery's executor failed (Docker /
            // auth / etc.), NOT a real task issue. Indicators:
            //   - probe band like "INFRA_ERROR"
            //   - error mentioning "infrastructure error", "Docker environment",
            //     "AuthenticationError", "could not start", etc.
            const stageDetail = failedStage?.detail as unknown;
            const sd = Array.isArray(stageDetail) ? stageDetail[0] : stageDetail;
            const bandIsInfra =
              !!sd &&
              typeof (sd as { band?: unknown }).band === "string" &&
              ((sd as { band: string }).band).toUpperCase().includes("INFRA");
            const isInfraError =
              bandIsInfra ||
              errSources.some(
                (m) =>
                  m.includes("infrastructure error") ||
                  m.includes("authenticationerror") ||
                  m.includes("authentication error") ||
                  m.includes("docker environment") ||
                  m.includes("could not start the docker") ||
                  m.includes("executor could not")
              );

            if (stageLabel.startsWith("similarity") && isAutoSubmitted) {
              // (1) Similarity hard block on an auto-submitted row: delete the
              // submission so Step 1 re-submits the same zip on the next tick.
              // Bounded by MAX_SIM_RETRIES per fileName to prevent loops, and
              // gated by a 3-min cooling window so you can review manually.
              const cur = similarityRetryCountRef.current.get(row.fileName) || 0;
              if (cur >= MAX_SIM_RETRIES) {
                // No JSON written for similarity — user explicitly does not want one.
                logAuto(
                  `⚠ ${row.fileName} hit similarity block ${cur}x — gave up (no JSON written)`
                );
              } else if (isRetryReady("similarity-blocked")) {
                similarityRetryCountRef.current.set(row.fileName, cur + 1);
                persistSimRetries();
                await deleteAndResubmit(
                  `similarity-blocked (try ${cur + 1}/${MAX_SIM_RETRIES})`
                );
              }
              // else: still inside the 3-min wait window; defer to next tick.
            } else if (
              stageLabel.startsWith("easiness") &&
              isRateLimit &&
              isAutoSubmitted
            ) {
              // (5) Easiness Prefilter rate-limit transient — retry like
              // similarity, same 3-min wait window before the action.
              const cur = similarityRetryCountRef.current.get(row.fileName) || 0;
              if (cur >= MAX_SIM_RETRIES) {
                logAuto(
                  `⚠ ${row.fileName} hit easiness rate-limit ${cur}x — gave up (no JSON)`
                );
              } else if (isRetryReady("easiness rate-limit")) {
                similarityRetryCountRef.current.set(row.fileName, cur + 1);
                persistSimRetries();
                await deleteAndResubmit(
                  `easiness rate-limit (try ${cur + 1}/${MAX_SIM_RETRIES})`
                );
              }
              // else: still inside the 3-min wait window; defer to next tick.
            } else if (isInfraError && !stageLabel.startsWith("similarity")) {
              // Infrastructure error (Docker / Auth / executor failed to start).
              // Not a real task failure. Try AfterQuery's retry-stage API to
              // re-run the failed stage, then write "completed" so the task is
              // marked done from our side ("consider as complete task and move
              // to next"). The submission and zip stay; if the retry succeeds
              // the pipeline continues on AfterQuery and may reach Review Ready
              // / Approved on its own. If retry fails (no rerun budget, etc.),
              // we still write "completed" and keep things for manual review.
              const apiStageName = (() => {
                const l = (failedStage?.label || "").toLowerCase();
                if (l.startsWith("similarity")) return "similarity";
                if (l.startsWith("ci")) return "ci_checks";
                if (l.startsWith("quality check")) return "quality_check";
                if (l.startsWith("validation")) return "validation_preflight";
                if (l.startsWith("oracle")) return "harbor_validation";
                if (l.startsWith("easiness")) return "sonnet_prefilter";
                if (l.startsWith("opus")) return "difficulty_probe";
                if (l.startsWith("agent")) return "agent_quality";
                return null;
              })();
              let retryOk = false;
              if (apiStageName) {
                try {
                  const rRes = await fetch("/api/retry-stage", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      submissionId: row.id,
                      stage: apiStageName,
                      token: tokenArg,
                    }),
                  });
                  const rData = await rRes.json();
                  if (rData.ok) {
                    retryOk = true;
                    logAuto(
                      `↻ retried stage ${apiStageName} for ${row.fileName}${
                        typeof rData.usedRerunBudget === "boolean"
                          ? ` (rerun-budget used: ${rData.usedRerunBudget})`
                          : ""
                      }`
                    );
                  } else {
                    logAuto(
                      `✗ retry stage ${apiStageName} for ${row.fileName}: ${rData.error || "failed"}`
                    );
                  }
                } catch (e) {
                  logAuto(`✗ retry stage: ${(e as Error).message}`);
                }
              } else {
                logAuto(
                  `⚠ no API stage mapping for "${failedStage?.label || "unknown"}" — skipping retry`
                );
              }
              await saveJson("completed");
              const where = failedStage?.label || "unknown stage";
              if (retryOk) {
                logAuto(
                  `✓ wrote ${jsonName} ("completed" — infra error at ${where}, retry-stage initiated)`
                );
                // Allow re-evaluation if the pipeline transitions back to a
                // terminal state (e.g. retry exposed a real failure later).
                processedSubsRef.current.delete(row.id);
              } else {
                logAuto(
                  `✓ wrote ${jsonName} ("completed" — infra error at ${where}, kept on AfterQuery for manual review)`
                );
              }
            } else if (stageLabel.startsWith("easiness")) {
              // (3) Easiness Prefilter genuine failure (e.g. tooEasy / pass 5/5).
              await saveJson("failed");
              logAuto(`✓ wrote ${jsonName} ("failed" — Easiness Prefilter)`);
              // For auto-submitted rows, also delete the submission + zip so
              // the user can drop a revised zip in to re-submit. Pre-existing
              // rows get the JSON only.
              if (isAutoSubmitted) await deleteSubmissionAndZip();
            } else {
              // (2)/(4) CI / Quality / Validation pre-flight / Oracle / NOP /
              // Opus / Agent Quality / similarity-on-pre-existing → write logs.
              await saveJson(feedbackContent);
              const where = failedStage?.label || row.status || "unknown stage";
              logAuto(`✓ wrote ${jsonName} (logs — ${where})`);
              // For auto-submitted rows, also delete the submission + zip so
              // the user can drop a revised zip in to re-submit. Pre-existing
              // rows get the JSON only.
              if (isAutoSubmitted) await deleteSubmissionAndZip();
            }
          }
        } catch (e) {
          logAuto(`✗ processing ${row.fileName}: ${(e as Error).message}`);
          // Allow another attempt on the next tick.
          processedSubsRef.current.delete(row.id);
        }
      }
    } finally {
      autoRunningRef.current = false;
      setAutoBusy(false);
    }
  }, [logAuto, tokenArg, persistAutoIds, persistSimRetries]);

  useEffect(() => {
    if (!autoEnabled) return;
    autoTick();
    const id = setInterval(autoTick, POLL_MS);
    return () => clearInterval(id);
  }, [autoEnabled, autoTick]);

  // ---- list polling (every 5s) ----
  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      setErr("");
      try {
        const res = await fetch("/api/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to load submissions");
        // Render rows in the order the API returns them — no client-side resort.
        setRows(data.submissions as SubmissionRow[]);
        setLoaded(true);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        if (initial) setLoading(false);
      }
    },
    [tokenArg]
  );

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // ---- detail fetch + polling for the open row ----
  const fetchDetail = useCallback(
    async (id: string) => {
      try {
        const res = await fetch("/api/pipeline-detail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submissionId: id, token: tokenArg }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to load detail");
        setDetails((d) => ({ ...d, [id]: data.pipeline as PipelineView }));
        return data.pipeline as PipelineView;
      } catch (e) {
        setDetails((d) => ({ ...d, [id]: { error: (e as Error).message } }));
        return null;
      }
    },
    [tokenArg]
  );

  useEffect(() => {
    if (!openId) return;
    const id = openId;
    if (!detailsRef.current[id] || detailsRef.current[id] === "loading") {
      setDetails((d) => ({ ...d, [id]: "loading" }));
    }
    fetchDetail(id);
    const timer = setInterval(() => {
      const cur = detailsRef.current[id];
      if (isPipeline(cur) && cur.completed) return; // terminal — stop hitting the API
      fetchDetail(id);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [openId, fetchDetail]);

  // Inline "step N/8" badge: auto-fetch pipeline detail for rows whose status
  // indicates an active pipeline, so the row header shows live progress without
  // needing to expand. Runs on every list refresh (every POLL_MS).
  useEffect(() => {
    for (const row of rows) {
      if (!isActive(row.status)) continue;
      if (detailsRef.current[row.id] === "loading") continue;
      fetchDetail(row.id);
    }
  }, [rows, fetchDetail]);

  const toggleOpen = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  const doDelete = useCallback(
    async (row: SubmissionRow) => {
      setDeletingId(row.id);
      setErr("");
      try {
        const res = await fetch("/api/delete-submission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId: row.id,
            harborSubmissionId: row.harborSubmissionId ?? undefined,
            token: tokenArg,
          }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Delete failed");
        setRows((rs) => rs.filter((r) => r.id !== row.id));
        if (openId === row.id) setOpenId(null);
      } catch (e) {
        setErr(`Delete failed: ${(e as Error).message}`);
      } finally {
        setDeletingId(null);
      }
    },
    [tokenArg, openId]
  );

  // Approved / Review-Ready (and any "terminal success" variant) are hidden
  // from this view so neither the user nor the auto-handler can act on them.
  // They're still kept in `rows` so Step 1's alive-check sees them and skips
  // re-submission.
  // NOTE: `.includes()` is case-sensitive — keep the comparison strings
  // lowercase since we lowercase the input first.
  const isTerminalSuccess = (status: string): boolean => {
    const x = (status || "").toLowerCase();
    return (
      x.includes("approv") ||
      x.includes("ready") ||
      x.includes("complete") ||
      x.includes("done") ||
      x.includes("accept") ||
      x.includes("success")
    );
  };
  const visibleRows = rows.filter((r) => !isTerminalSuccess(r.status));
  const hiddenCount = rows.length - visibleRows.length;
  // Surface which exact status strings got hidden, so any unexpected variant
  // (e.g. "Final", "Closed") shows up here and we can extend the filter.
  const hiddenStatusSummary = (() => {
    if (hiddenCount === 0) return "";
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!isTerminalSuccess(r.status)) continue;
      const k = r.status || "(empty)";
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
  })();

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelectedIds(new Set(visibleRows.map((r) => r.id)));
  const clearSelected = () => setSelectedIds(new Set());

  const deleteSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBatchDeleting(true);
    setErr("");
    const idToRow = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = idToRow.get(id);
      if (!row) continue;
      try {
        const res = await fetch("/api/delete-submission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId: row.id,
            harborSubmissionId: row.harborSubmissionId ?? undefined,
            token: tokenArg,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          setRows((rs) => rs.filter((r) => r.id !== row.id));
          if (openId === row.id) setOpenId(null);
        } else {
          setErr(`Delete ${row.fileName}: ${data.error || "failed"}`);
        }
      } catch (e) {
        setErr(`Delete ${row.fileName}: ${(e as Error).message}`);
      }
    }
    setSelectedIds(new Set());
    setBatchDeleting(false);
  }, [selectedIds, rows, tokenArg, openId]);

  /** Delete the row's existing submission and submit the same zip again
   *  (same fileName + same domain). Strictly sequential — the second call
   *  only fires after the delete API has returned ok. */
  const resubmitOne = useCallback(
    async (row: SubmissionRow): Promise<{ ok: boolean; reason?: string }> => {
      // Delete
      try {
        const delRes = await fetch("/api/delete-submission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId: row.id,
            harborSubmissionId: row.harborSubmissionId ?? undefined,
            token: tokenArg,
          }),
        });
        const delData = await delRes.json();
        if (!delData.ok) {
          return { ok: false, reason: `delete: ${delData.error || "failed"}` };
        }
      } catch (e) {
        return { ok: false, reason: `delete: ${(e as Error).message}` };
      }
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      if (openId === row.id) setOpenId(null);
      autoSubmittedIdsRef.current.delete(row.id);
      persistAutoIds();
      // Submit
      try {
        const sRes = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: row.fileName,
            domain: row.domain,
            token: tokenArg,
          }),
        });
        const sData = await sRes.json();
        if (!sData.ok) {
          return { ok: false, reason: `submit: ${sData.error || "failed"}` };
        }
        // Track the new submissionId so the auto-handler treats it as one
        // of its own (subject to the usual stage-specific routing).
        if (sData.submissionId) {
          autoSubmittedIdsRef.current.add(sData.submissionId);
          persistAutoIds();
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: `submit: ${(e as Error).message}` };
      }
    },
    [tokenArg, openId, persistAutoIds]
  );

  const doResubmit = useCallback(
    async (row: SubmissionRow) => {
      setResubmittingId(row.id);
      setErr("");
      try {
        const result = await resubmitOne(row);
        if (!result.ok) {
          setErr(`Resubmit ${row.fileName}: ${result.reason}`);
        }
      } finally {
        setResubmittingId(null);
      }
    },
    [resubmitOne]
  );

  const resubmitSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBatchResubmitting(true);
    setErr("");
    const idToRow = new Map(rows.map((r) => [r.id, r]));
    let failures = 0;
    for (const id of ids) {
      const row = idToRow.get(id);
      if (!row) continue;
      const result = await resubmitOne(row);
      if (!result.ok) {
        failures++;
        setErr(`Resubmit ${row.fileName}: ${result.reason}`);
      }
    }
    setSelectedIds(new Set());
    setBatchResubmitting(false);
    if (failures > 0) {
      logAuto(`⚠ bulk resubmit: ${ids.length - failures}/${ids.length} ok, ${failures} failed`);
    }
  }, [selectedIds, rows, resubmitOne, logAuto]);

  const copyFeedback = useCallback(
    async (row: SubmissionRow) => {
      const cur = detailsRef.current[row.id];
      const pv: PipelineView | null = isPipeline(cur) ? cur : await fetchDetail(row.id);
      if (!pv) return;
      try {
        await navigator.clipboard.writeText(pv.feedbackMarkdown);
        setCopied(row.id);
        setTimeout(() => setCopied((c) => (c === row.id ? null : c)), 1500);
      } catch {
        setErr("Clipboard blocked by the browser.");
      }
    },
    [fetchDetail]
  );

  return (
    <div>
      {/* Auto-handle feedback panel */}
      <div
        className={`mb-3 rounded-lg border px-3 py-2 ${
          autoEnabled
            ? "border-amber-800 bg-amber-950/30"
            : "border-neutral-800 bg-neutral-900"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoEnabled}
              onChange={(e) => toggleAuto(e.target.checked)}
              className="h-4 w-4 accent-amber-500"
            />
            <span className="font-medium text-neutral-100">Auto handle feedback</span>
          </label>
          <span className="text-xs text-neutral-500">
            submit new zips (skipped if <strong>any</strong> same-name submission already exists —
            you must delete it first to re-submit) · on needs-review/failed for{" "}
            <strong>auto-submitted</strong>, branch by failed stage:{" "}
            <span className="text-red-300">Similarity</span> → delete + re-submit (up to{" "}
            {MAX_SIM_RETRIES}x) ·{" "}
            <span className="text-amber-300">Easiness Prefilter</span> → rate-limit retries
            like similarity, else <code className="text-neutral-400">failed</code> JSON ·{" "}
            <strong>other stages</strong> → feedback-log JSON (no delete).{" "}
            <span className="text-amber-300">Approved/Ready never touched (and hidden).</span>
          </span>
          {autoEnabled && (
            <span className="ml-auto flex items-center gap-1 text-xs text-amber-300">
              {autoBusy ? (
                <>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  working
                </>
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-400/50" />
                  idle · next tick ≤ 10 s
                </>
              )}
            </span>
          )}
        </div>
        {autoLog.length > 0 && (
          <details className="mt-2" open={autoEnabled}>
            <summary className="cursor-pointer text-xs text-neutral-500">
              Activity log ({autoLog.length})
            </summary>
            <div className="mt-1 max-h-48 overflow-auto rounded border border-neutral-800 bg-black/40 p-2 font-mono text-[11px] leading-snug text-neutral-400">
              {autoLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Reload"}
        </button>
        <span className="text-xs text-neutral-500">
          {loaded
            ? `${visibleRows.length} submissions${
                hiddenCount > 0 ? ` · ${hiddenCount} hidden (${hiddenStatusSummary})` : ""
              } · auto-refresh 10s`
            : "auto-refresh 10s"}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <button
            onClick={selectAll}
            disabled={visibleRows.length === 0}
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            Select all ({visibleRows.length})
          </button>
          <button
            onClick={clearSelected}
            disabled={selectedIds.size === 0}
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            Clear
          </button>
          <button
            onClick={resubmitSelected}
            disabled={
              batchResubmitting || batchDeleting || selectedIds.size === 0
            }
            title="For each selected row: delete the existing submission, then submit the same zip again"
            className="rounded bg-sky-700 px-3 py-1 font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {batchResubmitting
              ? "Resubmitting…"
              : `Resubmit selected (${selectedIds.size})`}
          </button>
          <button
            onClick={deleteSelected}
            disabled={batchDeleting || batchResubmitting || selectedIds.size === 0}
            className="rounded bg-red-700 px-3 py-1 font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {batchDeleting ? "Deleting…" : `Delete selected (${selectedIds.size})`}
          </button>
        </span>
      </div>

      {err && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="space-y-2">
        {visibleRows.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 px-3 py-6 text-center text-sm text-neutral-500">
            {loading
              ? "Loading…"
              : loaded
              ? hiddenCount > 0
                ? `No active submissions · ${hiddenCount} hidden (approved/ready)`
                : "No submissions."
              : "—"}
          </div>
        ) : (
          visibleRows.map((row) => {
            const open = openId === row.id;
            const d = details[row.id];
            return (
              <div key={row.id} className="rounded-lg border border-neutral-800 bg-neutral-900">
                {/* Row header */}
                <div
                  onClick={(e) => {
                    // Don't toggle when clicking buttons / inputs / selects inside the header.
                    if ((e.target as HTMLElement).closest("button, select, input, a")) return;
                    toggleOpen(row.id);
                  }}
                  className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-neutral-900/40"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleSelect(row.id)}
                    aria-label="Select submission for bulk delete"
                    className="h-4 w-4 accent-red-500"
                  />
                  <span
                    className="text-neutral-500"
                    title={open ? "Collapse" : "Expand"}
                    aria-hidden="true"
                  >
                    {open ? "▾" : "▸"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-100">
                      {row.fileName}
                    </div>
                    <div className="truncate text-xs text-neutral-500">
                      {row.domain} · {row.language} · {fmtWhen(row.submittedAt)}
                      {row.rejectionCount > 0 && (
                        <span className="text-amber-400"> · {row.rejectionCount} rejections</span>
                      )}
                    </div>
                  </div>
                  <StepBadge row={row} detail={d} />
                  <span className={`rounded px-2 py-0.5 text-xs ${statusClass(row.status)}`}>
                    {row.status || "—"}
                  </span>
                  <button
                    onClick={() => copyFeedback(row)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                    title="Copy the difficulty/easiness + rubric feedback to paste into Claude"
                  >
                    {copied === row.id ? "Copied!" : "Copy feedback"}
                  </button>
                  <button
                    onClick={() => doResubmit(row)}
                    disabled={
                      resubmittingId === row.id ||
                      deletingId === row.id ||
                      batchResubmitting ||
                      batchDeleting
                    }
                    className="rounded border border-sky-900 px-2 py-1 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-50"
                    title="Delete this submission then submit the same zip again"
                  >
                    {resubmittingId === row.id ? "…" : "Resubmit"}
                  </button>
                  <button
                    onClick={() => doDelete(row)}
                    disabled={
                      deletingId === row.id ||
                      resubmittingId === row.id ||
                      batchDeleting ||
                      batchResubmitting
                    }
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50"
                    title="Delete this submission from AfterQuery"
                  >
                    {deletingId === row.id ? "…" : "Delete"}
                  </button>
                </div>

                {/* Expanded pipeline card */}
                {open && (
                  <div className="border-t border-neutral-800 px-3 py-3">
                    {d === "loading" || d === undefined ? (
                      <span className="text-xs text-sky-400">Loading pipeline…</span>
                    ) : "error" in d ? (
                      <span className="text-xs text-red-400">{d.error}</span>
                    ) : (
                      <PipelineCard
                        pipeline={d}
                        rowId={row.id}
                        openStages={openStages}
                        setOpenStages={setOpenStages}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PipelineCard({
  pipeline,
  rowId,
  openStages,
  setOpenStages,
}: {
  pipeline: PipelineView;
  rowId: string;
  openStages: Record<string, boolean>;
  setOpenStages: (f: (s: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950">
      <div className="flex items-start justify-between gap-4 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Harbor pipeline</div>
          <div className="text-base font-semibold text-neutral-100">
            {pipeline.retrying
              ? `Retrying step ${pipeline.currentStep} of ${pipeline.totalSteps} automatically`
              : pipeline.completed
              ? `Completed all ${pipeline.totalSteps} steps`
              : `Step ${pipeline.currentStep} of ${pipeline.totalSteps}`}
            {pipeline.failed && !pipeline.retrying && (
              <span className="ml-2 text-red-400">· failed</span>
            )}
          </div>
          {pipeline.failureMessage && (
            <div
              className={`mt-1 text-xs ${
                pipeline.retrying ? "text-amber-400" : "text-red-400"
              }`}
            >
              {pipeline.failureMessage}
            </div>
          )}
        </div>
        {pipeline.spentUsd != null && (
          <div className="shrink-0 text-xs text-neutral-500">
            ${pipeline.spentUsd.toFixed(2)} spent
          </div>
        )}
      </div>

      <div className="divide-y divide-neutral-800 border-t border-neutral-800">
        {pipeline.stages.map((s, i) => {
          const key = `${rowId}:${i}`;
          const expanded = openStages[key];
          const canExpand = s.detail != null;
          return (
            <div key={key}>
              <div
                onClick={() => canExpand && setOpenStages((o) => ({ ...o, [key]: !o[key] }))}
                className={`flex items-start gap-3 px-3 py-2 ${
                  canExpand ? "cursor-pointer hover:bg-neutral-900" : "cursor-default"
                }`}
              >
                <span className="mt-0.5 w-4 text-center text-xs">
                  {s.retryNote ? (
                    <span className="text-amber-400">↻</span>
                  ) : (
                    <StageIcon status={s.status} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm ${
                      s.status === "pending" || s.status === "skipped"
                        ? "text-neutral-500"
                        : "text-neutral-200"
                    }`}
                  >
                    {s.label}
                    {s.summary && (
                      <span className="ml-2 text-xs text-neutral-500">{s.summary}</span>
                    )}
                  </div>
                  {s.error && (
                    <div className="mt-1 text-xs text-red-400">{s.error}</div>
                  )}
                </div>
                {s.retryNote && (
                  <span className="shrink-0 rounded border border-amber-900 bg-amber-950/40 px-2 py-0.5 text-[10px] text-amber-300">
                    ↻ {s.retryNote}
                  </span>
                )}
                {s.costUsd != null && (
                  <span className="shrink-0 text-xs text-neutral-500">
                    ${s.costUsd.toFixed(2)}
                  </span>
                )}
                <span className="w-4 shrink-0 text-center text-neutral-600">
                  {canExpand ? (expanded ? "—" : "+") : ""}
                </span>
              </div>
              {expanded && canExpand && (
                <pre className="max-h-72 overflow-auto border-t border-neutral-900 bg-black/40 px-3 py-2 text-[10px] leading-relaxed text-neutral-400">
                  {JSON.stringify(s.detail, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
        pipeline keys: {pipeline.pipelineKeys.join(", ") || "—"}
      </div>
    </div>
  );
}
