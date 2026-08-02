"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UserStats {
  totalSubmissions: number;
  approvedSubmissions: number;
  rejectedSubmissions: number;
  pendingSubmissions: number;
  inProgress: number;
  totalClaims: number;
  isBlocked: boolean;
  blockReason: string | null;
  firstTaskStatus: string;
  bootcampComplete: boolean;
}

interface CollectionState {
  isPaused: boolean;
  pausedMessage: string | null;
  announcement: string | null;
}

interface AvailableResponse {
  availableCount: number;
  collectionState: CollectionState;
  claimedTask: ClaimedTask | null;
  userStats: UserStats;
}

interface ClaimedTask {
  taskId: string;
  // Plus arbitrary task content — we render whichever common fields exist
  // and provide a raw JSON view so nothing is hidden.
  [k: string]: unknown;
}

interface SubmitChecks {
  gptZero?: {
    passed?: boolean;
    humanProbability?: number;
    aiProbability?: number;
    reason?: string;
  };
  meaning?: { passed?: boolean; preserved?: boolean; reason?: string };
  passed?: boolean;
}

interface SubmitResult {
  success?: boolean;
  taskId?: string;
  status?: string;
  outcome?: string | null;
  displayStatus?: string;
  attemptsUsed?: number;
  attemptsRemaining?: number;
  checks?: SubmitChecks;
}

const POLL_MS = 10_000;
/** Per-task earnings used to compute the "Earned" stat. AfterQuery's UI shows
 *  $300 for 20 approved tasks → $15/task. Override via NEXT_PUBLIC_REWRITE_RATE. */
const PER_TASK_USD = Number(
  process.env.NEXT_PUBLIC_REWRITE_RATE_USD ?? 15
);
/** Auto-handler tick interval (1 s — scan result.txt every second per spec). */
const AUTO_TICK_MS = 1_000;
/** Cooling window after a claim returns null — don't hammer the API. */
const CLAIM_RETRY_MS = 5 * 60 * 1000;
const AUTO_KEY = "pluto.rewrite.autoEnabled";
const MAX_LOG = 80;

export default function Rewrite({ manualToken }: { manualToken: string }) {
  const [data, setData] = useState<AvailableResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rewriteText, setRewriteText] = useState("");
  const [lastResult, setLastResult] = useState<SubmitResult | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // Auto-handler state
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoPhase, setAutoPhase] = useState<
    "idle" | "claiming" | "waiting-result" | "submitting" | "cooldown"
  >("idle");
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const autoRunningRef = useRef(false);
  const lastClaimAttemptRef = useRef<number>(0);
  const lastCooldownLogRef = useRef<number>(0);

  const tokenArg = manualToken || undefined;

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      setErr("");
      try {
        const res = await fetch("/api/rewrite/available", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "Failed to load");
        setData(j.data as AvailableResponse);
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

  const claim = useCallback(async () => {
    setClaiming(true);
    setErr("");
    try {
      const res = await fetch("/api/rewrite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenArg }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Failed to claim");
      if (!j.task) {
        setErr("No tasks available right now.");
      }
      await load(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setClaiming(false);
    }
  }, [tokenArg, load]);

  const submit = useCallback(async () => {
    const task = data?.claimedTask;
    if (!task?.taskId) return;
    if (!rewriteText.trim()) {
      setErr("Rewrite text is required.");
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch("/api/rewrite/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokenArg,
          taskId: task.taskId,
          rewriteText,
        }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Failed to submit");
      setLastResult(j.data as SubmitResult);
      setRewriteText("");
      await load(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [data, rewriteText, tokenArg, load]);

  // ---- Auto-handler ------------------------------------------------------
  // Loop (every AUTO_TICK_MS while autoEnabled):
  //   1. If RewriteTask/result.txt exists → submit using taskId from task.txt,
  //      then cleanup (delete both files).
  //   2. Else if task.txt exists → waiting for Claude to produce result.txt.
  //   3. Else if cooling-window from a prior null-claim hasn't elapsed → wait.
  //   4. Else call /api/rewrite/claim. If task returned, write it to task.txt.
  //      If null, start a 5-min cooldown.

  const logAuto = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setAutoLog((l) => [`[${stamp}] ${msg}`, ...l].slice(0, MAX_LOG));
  }, []);

  // Persist autoEnabled across reloads.
  useEffect(() => {
    try {
      setAutoEnabled(localStorage.getItem(AUTO_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleAuto = (v: boolean) => {
    setAutoEnabled(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    logAuto(v ? "▶ auto handling ENABLED" : "■ auto handling disabled");
    if (!v) {
      setAutoPhase("idle");
      setCooldownUntil(null);
    }
  };

  const autoTick = useCallback(async () => {
    if (autoRunningRef.current) return;
    autoRunningRef.current = true;
    setAutoBusy(true);
    try {
      // 1. Check file state.
      let fileState: {
        task: { exists: boolean; content: string | null };
        result: { exists: boolean; content: string | null };
      };
      try {
        const r = await fetch("/api/rewrite/check-result", { cache: "no-store" });
        const j = await r.json();
        if (!j.ok) {
          logAuto(`✗ check-result: ${j.error || "failed"}`);
          return;
        }
        fileState = { task: j.task, result: j.result };
      } catch (e) {
        logAuto(`✗ check-result: ${(e as Error).message}`);
        return;
      }

      // 2. If we have a result, submit it.
      if (fileState.result.exists) {
        setAutoPhase("submitting");
        let taskId: string | null = null;
        try {
          const parsed = JSON.parse(fileState.task.content || "{}");
          taskId =
            parsed?.task?.taskId ||
            parsed?.taskId ||
            parsed?.raw?.task?.taskId ||
            null;
        } catch {
          /* will fall through */
        }
        if (!taskId) {
          logAuto(
            `✗ result.txt present but no taskId in task.txt — skipping (manual cleanup needed)`
          );
          return;
        }
        const rewriteText = (fileState.result.content || "").trim();
        if (!rewriteText) {
          logAuto(`⚠ result.txt is empty — waiting for content`);
          return;
        }
        try {
          const sRes = await fetch("/api/rewrite/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: tokenArg,
              taskId,
              rewriteText,
            }),
          });
          const sData = await sRes.json();
          if (!sData.ok) {
            logAuto(`✗ submit ${taskId}: ${sData.error || "failed"}`);
            return;
          }
          const displayStatus = sData.data?.displayStatus || sData.data?.status || "ok";
          logAuto(`✓ submitted ${taskId} → ${displayStatus}`);
          setLastResult(sData.data as SubmitResult);
        } catch (e) {
          logAuto(`✗ submit ${taskId}: ${(e as Error).message}`);
          return;
        }
        // Cleanup task.txt + result.txt.
        try {
          const cRes = await fetch("/api/rewrite/cleanup", { method: "POST" });
          const cData = await cRes.json();
          if (cData.ok) {
            logAuto(`✓ cleaned up RewriteTask/ (task=${cData.task}, result=${cData.result})`);
          } else {
            logAuto(`⚠ cleanup: ${cData.error || "failed"}`);
          }
        } catch (e) {
          logAuto(`⚠ cleanup: ${(e as Error).message}`);
        }
        // Reset cooldown so we can immediately claim the next one.
        lastClaimAttemptRef.current = 0;
        setCooldownUntil(null);
        setAutoPhase("idle");
        await load(false);
        return;
      }

      // 3. Have a task but no result — Claude is working on it.
      if (fileState.task.exists) {
        setAutoPhase("waiting-result");
        return;
      }

      // 4. No task, no result. Respect the 5-min cooldown after a null claim.
      const now = Date.now();
      if (
        lastClaimAttemptRef.current &&
        now - lastClaimAttemptRef.current < CLAIM_RETRY_MS
      ) {
        const remainingMs =
          CLAIM_RETRY_MS - (now - lastClaimAttemptRef.current);
        setCooldownUntil(now + remainingMs);
        setAutoPhase("cooldown");
        // Log at most once every 30 s while cooling, to keep the log readable.
        if (now - lastCooldownLogRef.current >= 30_000) {
          lastCooldownLogRef.current = now;
          const mins = Math.ceil(remainingMs / 60_000);
          logAuto(`… cooldown · ~${mins}min before next claim`);
        }
        return;
      }

      // 5. Claim.
      setAutoPhase("claiming");
      lastClaimAttemptRef.current = now;
      let claimData: { ok: boolean; task: ClaimedTask | null; error?: string };
      try {
        const r = await fetch("/api/rewrite/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg }),
        });
        claimData = await r.json();
      } catch (e) {
        logAuto(`✗ claim: ${(e as Error).message}`);
        return;
      }
      if (!claimData.ok) {
        logAuto(`✗ claim: ${claimData.error || "failed"} — cooldown 5min`);
        setCooldownUntil(now + CLAIM_RETRY_MS);
        setAutoPhase("cooldown");
        return;
      }
      if (!claimData.task) {
        logAuto(`⏳ no task available — cooldown 5min`);
        setCooldownUntil(now + CLAIM_RETRY_MS);
        setAutoPhase("cooldown");
        return;
      }
      // Got a task — write the full claim response to task.txt for Claude.
      const claimedTaskId = claimData.task.taskId;
      const content = JSON.stringify(claimData, null, 2);
      try {
        const wRes = await fetch("/api/rewrite/save-task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const wData = await wRes.json();
        if (!wData.ok) {
          logAuto(`✗ save task.txt: ${wData.error || "failed"}`);
          return;
        }
      } catch (e) {
        logAuto(`✗ save task.txt: ${(e as Error).message}`);
        return;
      }
      logAuto(
        `✓ claimed ${claimedTaskId} → wrote task.txt (waiting for result.txt)`
      );
      lastClaimAttemptRef.current = 0; // reset; we got a task
      setCooldownUntil(null);
      setAutoPhase("waiting-result");
      await load(false);
    } finally {
      autoRunningRef.current = false;
      setAutoBusy(false);
    }
  }, [tokenArg, load, logAuto]);

  useEffect(() => {
    if (!autoEnabled) return;
    autoTick();
    const id = setInterval(autoTick, AUTO_TICK_MS);
    return () => clearInterval(id);
  }, [autoEnabled, autoTick]);

  // For UI: live remaining seconds in the cooldown banner.
  const [, force] = useState(0);
  useEffect(() => {
    if (!cooldownUntil) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const stats = data?.userStats;
  const approved = stats?.approvedSubmissions ?? 0;
  const pending = stats?.pendingSubmissions ?? 0;
  const inProgress = stats?.inProgress ?? 0;
  const available = data?.availableCount ?? 0;
  const earned = approved * PER_TASK_USD;
  const completed = approved + pending;

  const announcement = data?.collectionState?.announcement;
  const paused = data?.collectionState?.isPaused;

  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
        Project Rewrite
      </div>
      <h1 className="mb-3 text-2xl font-semibold text-neutral-100">Dashboard</h1>

      {announcement && (
        <div className="mb-4 flex items-center gap-2 rounded border border-sky-800 bg-sky-950/50 px-3 py-2 text-sm text-sky-200">
          <span aria-hidden>📢</span>
          <span>{announcement}</span>
        </div>
      )}
      {paused && (
        <div className="mb-4 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          ⏸ Collection paused
          {data?.collectionState?.pausedMessage
            ? `: ${data.collectionState.pausedMessage}`
            : ""}
        </div>
      )}

      {/* Auto-handle panel */}
      <div
        className={`mb-4 rounded-lg border px-3 py-2 ${
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
            <span className="font-medium text-neutral-100">Auto handle</span>
          </label>
          <span className="text-xs text-neutral-500">
            claim → write{" "}
            <code className="text-neutral-400">RewriteTask/task.txt</code> · scan{" "}
            <code className="text-neutral-400">result.txt</code> every 1s · submit ·
            cleanup · loop (5min cooldown when no task available)
          </span>
          {autoEnabled && (
            <span className="ml-auto flex items-center gap-2 text-xs text-amber-300">
              {autoBusy ? (
                <>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  working
                </>
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-400/50" />
                  phase: {autoPhase}
                </>
              )}
            </span>
          )}
        </div>
        {autoEnabled && cooldownUntil && cooldownUntil > Date.now() && (
          <div className="mt-2 text-xs text-amber-300">
            ⏳ cooldown · next claim in{" "}
            {Math.floor((cooldownUntil - Date.now()) / 60_000)}m{" "}
            {Math.max(0, Math.floor((cooldownUntil - Date.now()) / 1000) % 60)}s
          </div>
        )}
        {autoLog.length > 0 && (
          <details className="mt-2" open={autoEnabled}>
            <summary className="cursor-pointer text-xs text-neutral-500">
              Activity log ({autoLog.length})
            </summary>
            <div className="mt-1 max-h-56 overflow-auto rounded border border-neutral-800 bg-black/40 p-2 font-mono text-[11px] leading-snug text-neutral-400">
              {autoLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Earned"
          icon="$"
          iconClass="text-emerald-400"
          value={`$${earned.toFixed(0)}`}
          sub={`${approved} tasks approved`}
        />
        <StatCard
          label="Completed"
          icon="✓"
          iconClass="text-sky-400"
          value={String(completed)}
          sub={`${pending} awaiting review`}
        />
        <StatCard
          label="Approved"
          icon="≡"
          iconClass="text-emerald-400"
          value={String(approved)}
        />
        <StatCard
          label="In Progress"
          icon="⏱"
          iconClass="text-amber-400"
          value={String(inProgress)}
        />
        <StatCard
          label="Available"
          icon="✎"
          iconClass="text-neutral-400"
          value={String(available)}
        />
      </div>

      {err && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 text-base font-semibold text-neutral-100">Task Queue</h2>

        {!loaded ? (
          <div className="text-sm text-neutral-500">
            {loading ? "Loading…" : "—"}
          </div>
        ) : data?.claimedTask ? (
          <ClaimedTaskView
            task={data.claimedTask}
            rewriteText={rewriteText}
            setRewriteText={setRewriteText}
            onSubmit={submit}
            submitting={submitting}
            showRaw={showRaw}
            setShowRaw={setShowRaw}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium text-neutral-100">
                {available} task{available === 1 ? "" : "s"} available
              </div>
              <div className="text-sm text-neutral-500">
                Click claim and we&apos;ll line you up for the next free task.
              </div>
            </div>
            <button
              onClick={claim}
              disabled={claiming || stats?.isBlocked}
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              title={stats?.blockReason ?? undefined}
            >
              {claiming ? "Claiming…" : "Claim Next Task"}
            </button>
          </div>
        )}
        {stats?.isBlocked && (
          <div className="mt-2 text-xs text-red-300">
            Account blocked{stats.blockReason ? `: ${stats.blockReason}` : ""}
          </div>
        )}
      </section>

      {lastResult && (
        <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h2 className="mb-3 text-base font-semibold text-neutral-100">
            Last submission
          </h2>
          <SubmitResultView result={lastResult} />
        </section>
      )}

      <div className="mt-3 text-[10px] text-neutral-600">
        auto-refresh 10s
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  iconClass,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: string;
  iconClass?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-400">{label}</div>
        {icon && (
          <div className={`text-sm ${iconClass ?? "text-neutral-500"}`}>{icon}</div>
        )}
      </div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function ClaimedTaskView({
  task,
  rewriteText,
  setRewriteText,
  onSubmit,
  submitting,
  showRaw,
  setShowRaw,
}: {
  task: ClaimedTask;
  rewriteText: string;
  setRewriteText: (s: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  showRaw: boolean;
  setShowRaw: (b: boolean) => void;
}) {
  // Best-effort field extraction — the precise schema isn't documented, so
  // try several likely keys and fall back to the raw JSON view.
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = (task as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length) return v;
    }
    return null;
  };
  const originalText = pick(
    "originalText",
    "original",
    "text",
    "content",
    "prompt",
    "input"
  );
  const instructions = pick("instructions", "instruction", "description");
  const styleTarget = pick("targetStyle", "style", "tone");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
          {task.taskId}
        </span>
        {styleTarget && (
          <span className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
            style: {styleTarget}
          </span>
        )}
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
        >
          {showRaw ? "Hide raw" : "Show raw"}
        </button>
      </div>

      {instructions && (
        <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-300">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
            Instructions
          </div>
          <div className="whitespace-pre-wrap">{instructions}</div>
        </div>
      )}

      {originalText && (
        <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
            Original
          </div>
          <div className="whitespace-pre-wrap">{originalText}</div>
        </div>
      )}

      {showRaw && (
        <pre className="max-h-72 overflow-auto rounded border border-neutral-800 bg-black/40 px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
          {JSON.stringify(task, null, 2)}
        </pre>
      )}

      <div>
        <label className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
          Your rewrite
        </label>
        <textarea
          value={rewriteText}
          onChange={(e) => setRewriteText(e.target.value)}
          placeholder="Rewrite the message here…"
          rows={6}
          className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-600"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-neutral-500">
          <span>{rewriteText.length} chars</span>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onSubmit}
          disabled={submitting || !rewriteText.trim()}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Submitting…" : "Submit rewrite"}
        </button>
      </div>
    </div>
  );
}

function SubmitResultView({ result }: { result: SubmitResult }) {
  const checks = result.checks ?? {};
  const overall = checks.passed;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            overall
              ? "bg-emerald-900 text-emerald-200"
              : "bg-red-900 text-red-200"
          }`}
        >
          {overall ? "PASSED" : "FAILED"}
        </span>
        {result.displayStatus && (
          <span className="text-xs text-neutral-400">
            {result.displayStatus}
          </span>
        )}
        {typeof result.attemptsRemaining === "number" && (
          <span className="text-xs text-neutral-500">
            attempts: {result.attemptsUsed}/{(result.attemptsUsed ?? 0) +
              (result.attemptsRemaining ?? 0)}
          </span>
        )}
      </div>

      {checks.gptZero && (
        <CheckRow
          label="GPTZero"
          passed={!!checks.gptZero.passed}
          extra={
            typeof checks.gptZero.humanProbability === "number"
              ? `human ${(checks.gptZero.humanProbability * 100).toFixed(0)}%`
              : undefined
          }
          reason={checks.gptZero.reason}
        />
      )}
      {checks.meaning && (
        <CheckRow
          label="Meaning preserved"
          passed={!!checks.meaning.passed}
          reason={checks.meaning.reason}
        />
      )}
    </div>
  );
}

function CheckRow({
  label,
  passed,
  extra,
  reason,
}: {
  label: string;
  passed: boolean;
  extra?: string;
  reason?: string;
}) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className={passed ? "text-emerald-400" : "text-red-400"}>
          {passed ? "✓" : "✗"}
        </span>
        <span className="text-neutral-200">{label}</span>
        {extra && <span className="text-xs text-neutral-500">· {extra}</span>}
      </div>
      {reason && (
        <div className="mt-1 text-xs text-neutral-400">{reason}</div>
      )}
    </div>
  );
}
