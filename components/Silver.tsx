"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildSilverPipelineView,
  type SilverPipelineView,
  type SilverStageStatus,
} from "@/lib/silverPipeline";

const POLL_MS = 10_000;
const AUTO_KEY = "pluto.silver.autoEnabled";
/** Persisted set of draftIds the auto-handler itself created. Only these are
 *  eligible for auto-delete after feedback is written — pre-existing drafts
 *  are NEVER touched. */
const AUTO_DRAFT_IDS_KEY = "pluto.silver.autoSubmittedDraftIds";
/** Persisted set of draftIds whose post-feedback delete failed (e.g. HTTP
 *  412 because the submission is still running). The auto-handler retries
 *  these at the start of every tick until they succeed or the draft
 *  vanishes from the user's draft list. */
const PENDING_DELETE_KEY = "pluto.silver.pendingDeleteDraftIds";
const MAX_LOG = 80;

interface Draft {
  id: string;
  taskName?: string;
  repoId?: string;
  status?: string;
  updatedAt?: { _seconds: number };
  createdAt?: { _seconds: number };
  baseCommit?: string;
  pipeline?: Record<string, unknown>;
}

interface SilverSubmission {
  id: string;
  draftId?: string;
  taskName?: string;
  status?: string;
  pipeline?: Record<string, unknown>;
  updatedAt?: { _seconds: number };
  createdAt?: { _seconds: number };
  costBreakdown?: { totalUsd?: number };
  pipelineCostUsd?: number;
}

interface ZipRow {
  fileName: string; // folder name (kept as `fileName` for back-compat)
  taskName: string;
  sizeBytes: number;
  fileCount?: number;
  createdMs: number;
  /** `<silverDir>/<taskName>/task.toml` parsed OK — the task-metadata file
   *  and "ready" marker. False only for broken/unreadable tomls. */
  hasMeta?: boolean;
  /** hasMeta && optional status is submittable ("Ready"/"Pending"/absent). */
  ready?: boolean;
  /** True when `<silverDir>/<taskName>.feedback.json` exists. Marker that
   *  the auto-handler has already processed this task — folder stays, no
   *  resubmit until the user removes the feedback file. */
  hasFeedback?: boolean;
  estimatedSolveTime?: string | null;
  taskType?: string | null;
  repoType?: string | null;
  requiresInternet?: boolean | null;
  /** Optional repo-name hint from task.toml (e.g. "verba"). */
  repo?: string | null;
  doNotSubmit?: boolean;
  note?: string | null;
  /** Raw optional status from task.toml (e.g. "Ready", "Failed"). */
  status?: string | null;
  /** task.toml status === "Failed" — manual marker from the human
   *  reviewer. Auto-handler must not retry; Submit button is disabled. */
  failed?: boolean;
  /** Lifetime successful submits (from the local task-stats.json). */
  submitCount?: number;
  /** Pipeline failures at step 7 — easinessProbe. */
  failedStep7?: number;
  /** Pipeline failures at step 8 — difficultyProbe. */
  failedStep8?: number;
  /** Failures at every other step, keyed by stage name. */
  failedOtherSteps?: Record<string, number>;
}

function fmtWhen(s?: { _seconds: number }): string {
  if (!s?._seconds) return "—";
  return new Date(s._seconds * 1000).toLocaleString();
}

/** A submission whose status matches any of these is PROTECTED — the
 *  auto-handler must never delete its draft. Includes:
 *    - approved / approval-pending          (earned bonus)
 *    - passed / pass                         (validation cleared)
 *    - ready for review / pending review     (queued for the human reviewer,
 *                                             may convert to approved)
 *  Used in three places: proactive prune (step 2), defensive recheck right
 *  before the delete call, and the post-feedback retry loop (step 1b). */
function hasProtectedSubmission(subs: SilverSubmission[]): boolean {
  return subs.some((s) => {
    const st = (s.status || "").toLowerCase();
    return (
      st.includes("approv") ||
      st === "passed" ||
      st === "pass" ||
      st.includes("ready for review") ||
      st.includes("pending review")
    );
  });
}

function statusClass(status: string): string {
  const x = (status || "").toLowerCase();
  if (x.includes("approv")) return "bg-emerald-900 text-emerald-200";
  if (x.includes("reject") || x.includes("fail")) return "bg-red-900 text-red-200";
  if (x.includes("review")) return "bg-sky-900 text-sky-200";
  if (x.includes("draft")) return "bg-neutral-800 text-neutral-400";
  if (x.includes("pass")) return "bg-emerald-900 text-emerald-200";
  return "bg-amber-900 text-amber-200";
}

export default function Silver({ manualToken }: { manualToken: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [submissionsByDraft, setSubmissionsByDraft] = useState<
    Record<string, SilverSubmission[]>
  >({});
  const [loadingSubsFor, setLoadingSubsFor] = useState<string | null>(null);
  /** Per-submission pipeline-card stage expand/collapse state, keyed by
   *  `${submission.id}:${stageIdx}`. */
  const [openStages, setOpenStages] = useState<Record<string, boolean>>({});

  const [zips, setZips] = useState<ZipRow[]>([]);
  const [zipDir, setZipDir] = useState("");
  /** Per-row in-flight markers for the manual Submit / Delete buttons.
   *  Keyed by taskName / draftId — used to disable the button and show a
   *  busy indicator while the action is running. */
  const [busySubmitTask, setBusySubmitTask] = useState<string | null>(null);
  const [busyDeleteDraft, setBusyDeleteDraft] = useState<string | null>(null);
  const [busyDeleteFolder, setBusyDeleteFolder] = useState<string | null>(null);
  /** taskNames whose folder has a parseable task.toml — the auto-handler
   *  only writes feedback for these. Used as the source of truth for
   *  "what I manage". */
  const managedNamesRef = useRef<Set<string>>(new Set());
  const [managedCount, setManagedCount] = useState(0);

  /** User's submitted repos (from silver.submission.listMine). Drives the
   *  auto repoId resolution in /api/silver/submit. */
  const [repos, setRepos] = useState<
    Array<{
      id: string;
      repoName?: string;
      displayName?: string | null;
      status?: string;
      language?: string;
      taskIds?: string[];
    }>
  >([]);
  const [reposErr, setReposErr] = useState("");

  // Auto-handler
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [autoBusy, setAutoBusy] = useState(false);
  const autoRunningRef = useRef(false);
  const processedSubmissionIdsRef = useRef<Set<string>>(new Set());
  /** draftIds the auto-handler itself created. Step "delete draft after
   *  feedback" only fires for these — pre-existing drafts are read-only. */
  const autoSubmittedDraftIdsRef = useRef<Set<string>>(new Set());
  const persistAutoDraftIds = useCallback(() => {
    try {
      localStorage.setItem(
        AUTO_DRAFT_IDS_KEY,
        JSON.stringify(Array.from(autoSubmittedDraftIdsRef.current))
      );
    } catch {
      /* ignore */
    }
  }, []);

  /** draftIds whose post-feedback delete failed and need a retry. The set
   *  is persisted so the retry survives page refresh; entries clear once
   *  the delete succeeds OR the draft is no longer in the user's list. */
  const pendingDeleteDraftIdsRef = useRef<Set<string>>(new Set());
  const persistPendingDeleteIds = useCallback(() => {
    try {
      localStorage.setItem(
        PENDING_DELETE_KEY,
        JSON.stringify(Array.from(pendingDeleteDraftIdsRef.current))
      );
    } catch {
      /* ignore */
    }
  }, []);

  const tokenArg = manualToken || undefined;

  const logAuto = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setAutoLog((l) => [`[${stamp}] ${msg}`, ...l].slice(0, MAX_LOG));
  }, []);

  // ---- Loaders ------------------------------------------------------------

  /** Fetch submissions for every passed draft, in parallel, and merge into
   *  `submissionsByDraft`. Lets the inline StageBar render real pipeline data
   *  even when the user hasn't expanded the row. Failures per draft are
   *  swallowed silently (the next poll will retry).
   *  Declared before `loadDrafts` because `loadDrafts` calls it. */
  const loadAllSubmissions = useCallback(
    async (forDrafts: Draft[]) => {
      if (!forDrafts.length) return;
      const results = await Promise.all(
        forDrafts.map(async (d) => {
          try {
            const r = await fetch("/api/silver/submissions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: tokenArg, draftId: d.id }),
            });
            const j = await r.json();
            return j.ok
              ? ([d.id, j.submissions as SilverSubmission[]] as const)
              : null;
          } catch {
            return null;
          }
        })
      );
      setSubmissionsByDraft((m) => {
        const next = { ...m };
        for (const r of results) if (r) next[r[0]] = r[1];
        return next;
      });
    },
    [tokenArg]
  );

  const loadDrafts = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      setErr("");
      try {
        const r = await fetch("/api/silver/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "Failed to load drafts");
        setDrafts(d.drafts);
        setLoaded(true);
        // Eagerly pull submissions so the inline StageBar in each row has
        // real pipeline data without waiting for the user to expand.
        loadAllSubmissions(d.drafts as Draft[]);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        if (initial) setLoading(false);
      }
    },
    [tokenArg, loadAllSubmissions]
  );

  const loadSubmissions = useCallback(
    async (draftId: string) => {
      setLoadingSubsFor(draftId);
      try {
        const r = await fetch("/api/silver/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg, draftId }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "Failed to load submissions");
        setSubmissionsByDraft((m) => ({ ...m, [draftId]: d.submissions }));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoadingSubsFor(null);
      }
    },
    [tokenArg]
  );

  const loadZips = useCallback(async () => {
    try {
      const r = await fetch("/api/silver/zips", { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setZips(d.zips);
      setZipDir(d.dir);
      managedNamesRef.current = new Set(
        Array.isArray(d.managedNames)
          ? (d.managedNames as string[]).filter((s) => typeof s === "string")
          : []
      );
      setManagedCount(managedNamesRef.current.size);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRepos = useCallback(async () => {
    try {
      const r = await fetch("/api/silver/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenArg }),
        cache: "no-store",
      });
      const d = await r.json();
      if (!d.ok) {
        setReposErr(d.error || "Failed to load repos.");
        return;
      }
      setReposErr("");
      setRepos(Array.isArray(d.repos) ? d.repos : []);
    } catch (e) {
      setReposErr((e as Error).message);
    }
  }, [tokenArg]);

  /** Manual submit for a single task folder. Same /api/silver/submit route
   *  the auto-handler hits, so the server-side feedback-JSON / duplicate-
   *  draft guards and the 5 s wait still apply. Refreshes drafts + folders
   *  on success so the UI updates without a poll-tick delay. */
  const submitOneTask = useCallback(
    async (taskName: string) => {
      if (busySubmitTask) return;
      setBusySubmitTask(taskName);
      try {
        const r = await fetch("/api/silver/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg, taskName }),
        });
        const d = await r.json();
        if (!d.ok) {
          logAuto(
            `✗ manual submit ${taskName}${d.step ? ` [${d.step}]` : ""}: ${
              d.error || "failed"
            }`
          );
          window.alert(
            `❌ Submission FAILED: ${taskName}\n\n` +
              `${d.step ? `Step: ${d.step}\n` : ""}${d.error || "Unknown error."}`
          );
          return;
        }
        if (d.skipped) {
          logAuto(
            `⊘ manual submit ${taskName} — skipped (${
              d.reason || "guard"
            })`
          );
          window.alert(
            `⚠ NOT submitted: ${taskName}\n\n` +
              `${d.message || `Skipped (${d.reason || "guard"}).`}`
          );
          return;
        }
        logAuto(
          `✓ manual submit ${taskName} → draft ${d.draftId} → submission ${d.submissionId}`
        );
        if (d.draftId) {
          autoSubmittedDraftIdsRef.current.add(d.draftId);
          persistAutoDraftIds();
        }
        // Count the submit in the local task-stats.json (deduped by
        // submissionId server-side; fire-and-forget).
        if (d.submissionId) {
          fetch("/api/silver/stats/record-submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskName, submissionId: d.submissionId }),
          }).catch(() => {});
        }
        window.alert(
          `✅ Submission SUCCESS: ${taskName}\n\n` +
            `Draft: ${d.draftId}\nSubmission: ${d.submissionId}\n` +
            `${d.fileCount ?? "?"} files uploaded.`
        );
      } catch (e) {
        logAuto(`✗ manual submit ${taskName}: ${(e as Error).message}`);
        window.alert(
          `❌ Submission FAILED: ${taskName}\n\n${(e as Error).message}`
        );
      } finally {
        setBusySubmitTask(null);
        loadDrafts(false);
        loadZips();
      }
    },
    [busySubmitTask, tokenArg, logAuto, persistAutoDraftIds, loadDrafts, loadZips]
  );

  /** Delete a LOCAL task folder (`<silverDir>/<taskName>/` + its
   *  `.feedback.json`). Nothing on AfterQuery is touched — drafts and
   *  submissions stay; use the draft row's Delete for those. */
  const deleteOneFolder = useCallback(
    async (taskName: string) => {
      if (busyDeleteFolder) return;
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Delete the LOCAL folder "${taskName}" (and its feedback file) from the tasks dir?\n\n` +
            `Nothing is deleted on AfterQuery. This cannot be undone.`
        )
      ) {
        return;
      }
      setBusyDeleteFolder(taskName);
      try {
        const r = await fetch("/api/silver/folder-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskName }),
        });
        const d = await r.json();
        if (!d.ok) {
          logAuto(`✗ delete folder ${taskName}: ${d.error || "failed"}`);
          window.alert(
            `❌ Remove folder FAILED: ${taskName}\n\n${d.error || "Unknown error."}`
          );
          return;
        }
        logAuto(
          d.alreadyMissing
            ? `⊘ delete folder ${taskName} — already gone`
            : `✓ deleted local folder ${taskName}${
                d.removedFeedback ? " (+ feedback file)" : ""
              }`
        );
        window.alert(
          d.alreadyMissing
            ? `⚠ Folder was already gone: ${taskName}`
            : `✅ Local folder removed: ${taskName}${
                d.removedFeedback ? "\n(+ feedback file)" : ""
              }`
        );
      } catch (e) {
        logAuto(`✗ delete folder ${taskName}: ${(e as Error).message}`);
        window.alert(
          `❌ Remove folder FAILED: ${taskName}\n\n${(e as Error).message}`
        );
      } finally {
        setBusyDeleteFolder(null);
        loadZips();
      }
    },
    [busyDeleteFolder, logAuto, loadZips]
  );

  /** Manual delete for a single draft. The server route applies its own
   *  AfterQuery-side checks; we don't do the auto-handler's safety prune
   *  here because the user is explicitly asking. Refreshes drafts on
   *  success and removes the draftId from the tracking sets. */
  const deleteOneDraft = useCallback(
    async (draftId: string, label?: string) => {
      if (busyDeleteDraft) return;
      const name = label || draftId;
      if (
        typeof window !== "undefined" &&
        !window.confirm(`Delete draft "${name}"? This cannot be undone.`)
      ) {
        return;
      }
      setBusyDeleteDraft(draftId);
      try {
        const r = await fetch("/api/silver/draft-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg, draftId }),
        });
        const d = await r.json();
        if (d.ok) {
          autoSubmittedDraftIdsRef.current.delete(draftId);
          persistAutoDraftIds();
          if (pendingDeleteDraftIdsRef.current.delete(draftId)) {
            persistPendingDeleteIds();
          }
          logAuto(`✓ manual delete draft ${name}`);
          window.alert(`✅ Draft deleted: ${name}`);
        } else {
          logAuto(
            `✗ manual delete draft ${name}: ${d.error || "failed"}${
              d.status ? ` (HTTP ${d.status})` : ""
            }`
          );
          window.alert(
            `❌ Delete FAILED: ${name}\n\n${d.error || "Unknown error."}${
              d.status ? `\n(HTTP ${d.status})` : ""
            }`
          );
        }
      } catch (e) {
        logAuto(`✗ manual delete draft ${name}: ${(e as Error).message}`);
        window.alert(
          `❌ Delete FAILED: ${name}\n\n${(e as Error).message}`
        );
      } finally {
        setBusyDeleteDraft(null);
        loadDrafts(false);
      }
    },
    [
      busyDeleteDraft,
      tokenArg,
      logAuto,
      persistAutoDraftIds,
      persistPendingDeleteIds,
      loadDrafts,
    ]
  );

  useEffect(() => {
    loadDrafts(true);
    loadZips();
    loadRepos();
    const id = setInterval(() => {
      loadDrafts(false);
      loadZips();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loadDrafts, loadZips, loadRepos]);

  const toggleDraft = useCallback(
    (draftId: string) => {
      if (openDraftId === draftId) {
        setOpenDraftId(null);
        return;
      }
      setOpenDraftId(draftId);
      if (!submissionsByDraft[draftId]) loadSubmissions(draftId);
    },
    [openDraftId, submissionsByDraft, loadSubmissions]
  );

  // ---- Auto-handler --------------------------------------------------------
  // Loop:
  //   1. For every draft, fetch latest submissions.
  //   2. For each submission with a failure we haven't processed:
  //        - extract { failedStage, failureKind, failureReason, stage } from
  //          lib/silver.ts (via /api/silver/submissions raw),
  //        - POST /api/silver/feedback/save
  //            → <silverDir>/<taskName>.feedback.json
  //   3. For each ready task folder in <silverDir>/ (a folder with a
  //      parseable task.toml whose optional status doesn't block):
  //        - POST /api/silver/submit — collects the scaffold files, sends
  //          them to importFromZip, then submitDraft.
  //        - the folder stays on disk; the duplicate-draft guard prevents
  //          a resubmit.

  useEffect(() => {
    try {
      setAutoEnabled(localStorage.getItem(AUTO_KEY) === "1");
      const raw = localStorage.getItem(AUTO_DRAFT_IDS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          autoSubmittedDraftIdsRef.current = new Set(
            arr.filter((x) => typeof x === "string")
          );
        }
      }
      const pendRaw = localStorage.getItem(PENDING_DELETE_KEY);
      if (pendRaw) {
        const arr = JSON.parse(pendRaw);
        if (Array.isArray(arr)) {
          pendingDeleteDraftIdsRef.current = new Set(
            arr.filter((x) => typeof x === "string")
          );
        }
      }
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
  };

  const autoTick = useCallback(async () => {
    if (autoRunningRef.current) return;
    autoRunningRef.current = true;
    setAutoBusy(true);
    try {
      // 0. Refresh the managed-task scope so this tick uses the latest set
      //    of task names. The auto-handler only writes feedback for task
      //    folders that have a parseable task.toml.
      await loadZips();

      // 1. Refresh drafts so we see the latest pipeline state.
      let freshDrafts: Draft[] = [];
      try {
        const r = await fetch("/api/silver/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenArg }),
        });
        const d = await r.json();
        if (d.ok) {
          freshDrafts = d.drafts as Draft[];
          setDrafts(freshDrafts);
        } else {
          logAuto(`✗ load drafts: ${d.error || "failed"}`);
        }
      } catch (e) {
        logAuto(`✗ load drafts: ${(e as Error).message}`);
      }

      // 1b. Retry any drafts whose post-feedback delete failed on a prior
      //     tick (commonly HTTP 412 because the pipeline hadn't quiesced
      //     yet). For each pending draft:
      //       - if it's no longer in `freshDrafts`, AfterQuery cleared it
      //         on its own — drop the marker.
      //       - re-fetch its submissions and run hasProtectedSubmission().
      //         A draft that was queued for delete BEFORE a submission
      //         landed in "Ready for Review" / "Approved" must NOT be
      //         deleted now — drop the marker and walk away.
      //       - otherwise call draft-delete; on success, clear both
      //         tracking sets. On still-failing, leave in pending.
      if (pendingDeleteDraftIdsRef.current.size > 0) {
        const liveIds = new Set(freshDrafts.map((d) => d.id));
        for (const draftId of Array.from(pendingDeleteDraftIdsRef.current)) {
          if (!liveIds.has(draftId)) {
            pendingDeleteDraftIdsRef.current.delete(draftId);
            persistPendingDeleteIds();
            logAuto(`✓ pending delete ${draftId} — already gone, cleared`);
            continue;
          }
          // SAFETY: fresh submissions fetch, then check protection.
          // If the check itself fails (network), DEFER the retry to the
          // next tick rather than risk a delete without verification.
          let retrySubs: SilverSubmission[] = [];
          try {
            const sr = await fetch("/api/silver/submissions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: tokenArg, draftId }),
            });
            const sd = await sr.json();
            if (!sd.ok) {
              logAuto(
                `⚠ retry delete ${draftId} — safety check failed (${
                  sd.error || "submissions load"
                }), deferring`
              );
              continue;
            }
            retrySubs = sd.submissions as SilverSubmission[];
          } catch (e) {
            logAuto(
              `⚠ retry delete ${draftId} — safety check threw (${
                (e as Error).message
              }), deferring`
            );
            continue;
          }
          if (hasProtectedSubmission(retrySubs)) {
            pendingDeleteDraftIdsRef.current.delete(draftId);
            persistPendingDeleteIds();
            if (autoSubmittedDraftIdsRef.current.delete(draftId)) {
              persistAutoDraftIds();
            }
            logAuto(
              `🛡 retry delete ${draftId} — has approved / ready-for-review submission, cleared`
            );
            continue;
          }
          try {
            const r = await fetch("/api/silver/draft-delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: tokenArg, draftId }),
            });
            const d = await r.json();
            if (d.ok) {
              pendingDeleteDraftIdsRef.current.delete(draftId);
              persistPendingDeleteIds();
              autoSubmittedDraftIdsRef.current.delete(draftId);
              persistAutoDraftIds();
              logAuto(`✓ retry delete draft ${draftId} (succeeded)`);
            } else {
              logAuto(
                `… retry delete draft ${draftId}: ${d.error || "still failing"}`
              );
            }
          } catch (e) {
            logAuto(`… retry delete draft ${draftId}: ${(e as Error).message}`);
          }
        }
      }

      // 2. For each draft, fetch its submissions and process failed ones.
      for (const draft of freshDrafts) {
        let subs: SilverSubmission[] = [];
        try {
          const r = await fetch("/api/silver/submissions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenArg, draftId: draft.id }),
          });
          const d = await r.json();
          if (!d.ok) {
            logAuto(`✗ submissions ${draft.taskName ?? draft.id}: ${d.error || "failed"}`);
            continue;
          }
          subs = d.submissions as SilverSubmission[];
          setSubmissionsByDraft((m) => ({ ...m, [draft.id]: subs }));
        } catch (e) {
          logAuto(`✗ submissions: ${(e as Error).message}`);
          continue;
        }

        // SAFETY pass 1 (proactive): if this draft has ANY protected
        // submission (approved / passed / ready-for-review), prune it from
        // the auto-submitted tracking set so the delete path below can
        // never reach it on a later failure. Protected tasks are off-
        // limits — they earn money / count toward the bonus or are
        // pending human review.
        const draftHasApproved = hasProtectedSubmission(subs);
        if (
          draftHasApproved &&
          autoSubmittedDraftIdsRef.current.has(draft.id)
        ) {
          autoSubmittedDraftIdsRef.current.delete(draft.id);
          persistAutoDraftIds();
          // Also clear any pending-delete marker — once protected, no
          // future tick should ever retry.
          if (pendingDeleteDraftIdsRef.current.delete(draft.id)) {
            persistPendingDeleteIds();
          }
          logAuto(
            `🛡 draft ${draft.id} has an approved submission — dropped from auto-delete tracking`
          );
        }

        for (const sub of subs) {
          if (processedSubmissionIdsRef.current.has(sub.id)) continue;
          const status = (sub.status || "").toLowerCase();
          // A submission is a failure if EITHER:
          //   (a) the raw status string carries a failure marker, OR
          //   (b) our pipeline view computes failed=true from probe
          //       pass/attempts numbers (TOO_EASY / TOO_HARD verdicts that
          //       AfterQuery reports as status="passed"/"Needs Review").
          const view = buildSilverPipelineView(sub);
          const rawFailure =
            status.includes("fail") ||
            status.includes("reject") ||
            status.includes("error");
          if (!rawFailure && !view.failed) continue;
          // Extract failure summary; falls through to verdict-driven detail
          // when the raw failedStage field is empty.
          const summary = extractFailureSummary(sub);
          if (!summary) continue;
          const taskName = summary.taskName || sub.taskName || sub.id;
          // Count this failure in submission-stats.json (per-stage tally —
          // e.g. how often stage 7 easinessProbe vs stage 8 difficultyProbe
          // killed the task). Fire-and-forget: the server dedupes by
          // submissionId, so repeat calls across ticks/reloads are safe.
          if (summary.failedStage) {
            fetch("/api/silver/stats/record-failure", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                taskName,
                submissionId: sub.id,
                failedStage: summary.failedStage,
              }),
            }).catch(() => {});
          }
          // Scope guard: only write feedback for task folders that have a
          // parseable task.toml in the silver dir. Anything else
          // (manually-submitted drafts, AfterQuery's other repos) is left
          // untouched.
          if (!managedNamesRef.current.has(taskName)) {
            if (!processedSubmissionIdsRef.current.has(sub.id)) {
              processedSubmissionIdsRef.current.add(sub.id);
              logAuto(
                `⊘ skip feedback for ${taskName} — no ${taskName}/task.toml in silver dir`
              );
            }
            continue;
          }
          // Optional enrichment: pull the full stage-response blob for
          // stages where AfterQuery only stores a short summary in the
          // pipeline field. Embed it under `stageLog` so the saved feedback
          // JSON carries the actual content Claude needs to read.
          //   rubricReview      → JSON {response, storedAt} at /<stage>/response.json
          //   gptZeroCheck      → JSON at /<stage>/response.json
          //   taskImageBuild    → raw kaniko build log at /runs/image-build/log.txt
          //   easiness/difficulty probe → ONE solver log PER run (5 / 10 runs each)
          //                       at /runs/<probe-kebab>/<runId>/log.txt
          // For text logs (build / probe runs), the parsed field stays null
          // and the raw `content` survives in the JSON.
          let stageLog: unknown = null;
          const singleLogStages = new Set([
            "rubricReview",
            "gptZeroCheck",
            "taskImageBuild",
            "fairnessReview",
          ]);
          const probeLogStages = new Set([
            "easinessProbe",
            "difficultyProbe",
          ]);
          if (
            summary.failedStage &&
            probeLogStages.has(summary.failedStage)
          ) {
            // Per-run log fetch. Each run has its own UUID `runId`; the
            // probe blob's `runs[]` carries them (preserved by compactStage).
            const stageData = summary.stage as
              | { runs?: Array<Record<string, unknown>> }
              | null;
            const runs = Array.isArray(stageData?.runs) ? stageData!.runs : [];
            const probeKebab =
              summary.failedStage === "easinessProbe"
                ? "easiness-probe"
                : "difficulty-probe";
            const runFetches = runs
              .map((r) => {
                const runId =
                  (typeof r.runId === "string" && r.runId) ||
                  (typeof r.id === "string" && r.id) ||
                  null;
                if (!runId) return null;
                const gcsRef =
                  `gs://afterqueryai.firebasestorage.app/projects/silver/tasks/` +
                  `${sub.id}/runs/${probeKebab}/${runId}/log.txt`;
                return { runId, runIndex: r.runIndex, reward: r.reward, gcsRef };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null);
            if (runFetches.length === 0) {
              logAuto(
                `⚠ stageLog ${summary.failedStage} for ${taskName}: no runIds in stage.runs[]`
              );
            } else {
              // Fetch all run logs in parallel — 10 logs × ~500 ms each
              // collapses to ~500 ms total, vs ~5 s sequential.
              const results = await Promise.all(
                runFetches.map(async (rf) => {
                  try {
                    const lr = await fetch("/api/silver/submission-log", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        token: tokenArg,
                        submissionId: sub.id,
                        stage: summary.failedStage,
                        gcsRef: rf.gcsRef,
                      }),
                    });
                    const ld = await lr.json();
                    if (!ld.ok) return { ...rf, error: ld.error || "failed" };
                    return {
                      ...rf,
                      storedAt: ld.storedAt,
                      content: ld.content,
                    };
                  } catch (e) {
                    return { ...rf, error: (e as Error).message };
                  }
                })
              );
              const ok = results.filter((r) => !("error" in r) || !r.error).length;
              stageLog = {
                stage: summary.failedStage,
                runs: results,
              };
              logAuto(
                `✓ stageLog ${summary.failedStage} for ${taskName}: ${ok}/${runFetches.length} run logs fetched`
              );
            }
          } else if (
            summary.failedStage &&
            singleLogStages.has(summary.failedStage)
          ) {
            // Single-blob stage. Default gcsRef built server-side from stage.
            try {
              const lr = await fetch("/api/silver/submission-log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token: tokenArg,
                  submissionId: sub.id,
                  stage: summary.failedStage,
                }),
              });
              const ld = await lr.json();
              if (ld.ok) {
                stageLog = {
                  stage: summary.failedStage,
                  gcsRef: ld.gcsRef,
                  storedAt: ld.storedAt,
                  parsed: ld.parsed,
                  // keep `content` as a fallback for cases where parsed=null
                  content: ld.parsed ? undefined : ld.content,
                };
              } else {
                logAuto(
                  `⚠ stageLog ${summary.failedStage} for ${taskName}: ${
                    ld.error || "failed"
                  }`
                );
              }
            } catch (e) {
              logAuto(
                `⚠ stageLog ${summary.failedStage} for ${taskName}: ${
                  (e as Error).message
                }`
              );
            }
          }
          const enrichedSummary = stageLog
            ? { ...summary, stageLog }
            : summary;
          try {
            const w = await fetch("/api/silver/feedback/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                taskName,
                content: JSON.stringify(enrichedSummary, null, 2),
              }),
            });
            const wd = await w.json();
            if (!wd.ok) {
              logAuto(`✗ feedback save ${taskName}: ${wd.error || "failed"}`);
              continue;
            }
            processedSubmissionIdsRef.current.add(sub.id);
            logAuto(
              `✓ wrote ${taskName}.feedback.json (failed: ${summary.failedStage || "?"}${
                summary.failureKind ? ` · ${summary.failureKind}` : ""
              }${stageLog ? " · with stageLog" : ""})`
            );
            // Only auto-delete drafts the auto-handler itself created.
            if (!autoSubmittedDraftIdsRef.current.has(draft.id)) continue;
            // SAFETY pass 2 (defensive): even if the proactive prune above
            // missed it, double-check the live `subs` list one more time. If
            // ANY submission on this draft is approved/passed, refuse to
            // delete and drop the draftId from the tracking set.
            if (draftHasApproved) {
              autoSubmittedDraftIdsRef.current.delete(draft.id);
              persistAutoDraftIds();
              logAuto(
                `🛡 refusing to delete draft ${draft.id} — has approved submission`
              );
              continue;
            }
            try {
              const delRes = await fetch("/api/silver/draft-delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: tokenArg, draftId: draft.id }),
              });
              const delData = await delRes.json();
              if (delData.ok) {
                autoSubmittedDraftIdsRef.current.delete(draft.id);
                persistAutoDraftIds();
                // Clear any pending-retry marker for this draft.
                if (pendingDeleteDraftIdsRef.current.delete(draft.id)) {
                  persistPendingDeleteIds();
                }
                logAuto(`✓ deleted draft ${draft.id} (auto-submitted)`);
              } else {
                // Delete failed (commonly HTTP 412 — draft state isn't
                // ready). Queue for retry on subsequent ticks instead of
                // dropping the work.
                pendingDeleteDraftIdsRef.current.add(draft.id);
                persistPendingDeleteIds();
                logAuto(
                  `⚠ delete draft ${draft.id}: ${delData.error || "failed"} — will retry`
                );
              }
            } catch (e) {
              pendingDeleteDraftIdsRef.current.add(draft.id);
              persistPendingDeleteIds();
              logAuto(
                `⚠ delete draft ${draft.id}: ${(e as Error).message} — will retry`
              );
            }
          } catch (e) {
            logAuto(`✗ feedback save ${taskName}: ${(e as Error).message}`);
          }
        }
      }

      // 3. Submit any ready task folders waiting in the silver dir.
      try {
        const zr = await fetch("/api/silver/zips", { cache: "no-store" });
        const zd = await zr.json();
        if (zd.ok) {
          setZips(zd.zips);
          setZipDir(zd.dir);
          for (const z of zd.zips as ZipRow[]) {
            // task.toml is broken/unreadable — the task isn't usable. Skip
            // silently; the row's chip points the user at the file.
            if (!z.hasMeta) continue;
            // task.toml's optional status blocks submission (e.g. "Hold",
            // "Do not submit") — don't import.
            if (z.doNotSubmit) {
              logAuto(
                `⊘ skip ${z.fileName} — task.toml status: ${z.note || z.status || "blocked"}`
              );
              continue;
            }
            // task.toml status === "Failed" — human reviewer marked this
            // task as failed and doesn't want auto-retries. The user must
            // flip the status (e.g. back to Ready) to allow another
            // attempt. Skip silently so the per-tick feed isn't spammed
            // for every failed task on every tick.
            if (z.failed) {
              continue;
            }
            // Client-side short-circuit: if the sibling feedback JSON exists,
            // skip without bothering the submit route. (The route also guards
            // against this on its own, but skipping here avoids a wasted
            // network call every tick for already-handled tasks.)
            if (z.hasFeedback) continue;
            try {
              const sRes = await fetch("/api/silver/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  token: tokenArg,
                  fileName: z.fileName,
                  taskName: z.taskName,
                }),
              });
              const sData = await sRes.json();
              if (!sData.ok) {
                logAuto(
                  `✗ submit ${z.fileName}${sData.step ? ` [${sData.step}]` : ""}: ${
                    sData.error || "failed"
                  }`
                );
                window.alert(
                  `❌ Submission FAILED: ${z.taskName}\n\n` +
                    `${sData.step ? `Step: ${sData.step}\n` : ""}${
                      sData.error || "Unknown error."
                    }`
                );
                // Submit-side failure: bad/missing tests/config.json (no
                // base_commit), no resolvable repoId, unmappable task.toml
                // metadata, network errors, etc. The folder physically
                // exists in our silver dir, so we always write feedback —
                // no managed-scope guard here (unlike the pipeline-failure
                // path, where drafts may be other-people's work).
                //
                // Writing the feedback JSON also flips hasFeedback=true on
                // the next tick, so the auto-handler stops retrying and
                // waits for the user to revise the folder + delete the file.
                try {
                  const submitFailure = {
                    taskName: z.taskName,
                    status: "Submit Failed",
                    failedStage: sData.step || "submit",
                    failureKind: "submit-error",
                    failureReason: sData.error || "failed",
                    stage: sData.detail ? { detail: sData.detail } : null,
                  };
                  const fr = await fetch("/api/silver/feedback/save", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      taskName: z.taskName,
                      content: JSON.stringify(submitFailure, null, 2),
                    }),
                  });
                  const fd = await fr.json();
                  if (fd.ok) {
                    logAuto(
                      `✓ wrote ${z.taskName}.feedback.json (submit error: ${
                        sData.step || "submit"
                      })`
                    );
                  } else {
                    logAuto(
                      `⚠ feedback save ${z.taskName}: ${fd.error || "failed"}`
                    );
                  }
                } catch (e) {
                  logAuto(
                    `⚠ feedback save ${z.taskName}: ${(e as Error).message}`
                  );
                }
                continue;
              }
              // Skipped (server-side guard). Reasons:
              //   feedback-json-exists → <taskName>.feedback.json sits next
              //     to the folder; the auto-handler already left feedback.
              //   duplicate-draft      → a draft for this taskName is already
              //     live on AfterQuery.
              //   status-failed / status-blocked → task.toml's optional
              //     status forbids submitting.
              // In all cases the local folder STAYS — the user manages it
              // manually (revise → delete the feedback / draft to retry).
              if (sData.skipped) {
                if (sData.reason === "feedback-json-exists") {
                  logAuto(
                    `⊘ skip ${z.taskName} — feedback exists (delete ${z.taskName}.feedback.json to retry)`
                  );
                } else if (sData.reason === "duplicate-draft") {
                  logAuto(
                    `⊘ skip ${z.taskName} — already submitted as draft ${
                      sData.draftId
                    }${sData.status ? ` (${sData.status})` : ""}`
                  );
                } else if (
                  sData.reason === "status-failed" ||
                  sData.reason === "status-blocked"
                ) {
                  logAuto(
                    `⊘ skip ${z.taskName} — task.toml status = ${sData.status || "blocked"}`
                  );
                } else {
                  logAuto(`⊘ skip ${z.taskName} — ${sData.message || "skipped"}`);
                }
                continue;
              }
              // Track the new draft so we can clean it up later if needed.
              if (sData.draftId) {
                autoSubmittedDraftIdsRef.current.add(sData.draftId);
                persistAutoDraftIds();
              }
              // Count the submit in the local task-stats.json (deduped by
              // submissionId server-side; fire-and-forget).
              if (sData.submissionId) {
                fetch("/api/silver/stats/record-submit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    taskName: z.taskName,
                    submissionId: sData.submissionId,
                  }),
                }).catch(() => {});
              }
              logAuto(
                `✓ imported ${z.taskName} → draft ${sData.draftId} → submission ${
                  sData.submissionId
                } (${sData.fileCount ?? "?"} files) — local folder kept`
              );
              window.alert(
                `✅ Submission SUCCESS: ${z.taskName}\n\n` +
                  `Draft: ${sData.draftId}\nSubmission: ${sData.submissionId}\n` +
                  `${sData.fileCount ?? "?"} files uploaded.`
              );
              // The task folder is intentionally kept on disk. The next
              // tick's duplicate-draft guard prevents a resubmit; the user
              // can revise it freely once the existing draft is cleared.
            } catch (e) {
              const msg = (e as Error).message;
              logAuto(`✗ submit ${z.fileName}: ${msg}`);
              window.alert(`❌ Submission FAILED: ${z.taskName}\n\n${msg}`);
              // Network / route-crash failure — still leave feedback so
              // Claude can see what blew up. Same shape as the !sData.ok
              // path above.
              try {
                const submitFailure = {
                  taskName: z.taskName,
                  status: "Submit Failed",
                  failedStage: "submit",
                  failureKind: "submit-exception",
                  failureReason: msg,
                  stage: null,
                };
                const fr = await fetch("/api/silver/feedback/save", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    taskName: z.taskName,
                    content: JSON.stringify(submitFailure, null, 2),
                  }),
                });
                const fd = await fr.json();
                if (fd.ok) {
                  logAuto(`✓ wrote ${z.taskName}.feedback.json (submit exception)`);
                } else {
                  logAuto(
                    `⚠ feedback save ${z.taskName}: ${fd.error || "failed"}`
                  );
                }
              } catch (e2) {
                logAuto(
                  `⚠ feedback save ${z.taskName}: ${(e2 as Error).message}`
                );
              }
            }
          }
        }
      } catch (e) {
        logAuto(`✗ scan task folders: ${(e as Error).message}`);
      }
    } finally {
      autoRunningRef.current = false;
      setAutoBusy(false);
    }
  }, [tokenArg, logAuto, persistAutoDraftIds, loadZips]);

  useEffect(() => {
    if (!autoEnabled) return;
    autoTick();
    const id = setInterval(autoTick, POLL_MS);
    return () => clearInterval(id);
  }, [autoEnabled, autoTick]);

  // ---- Render -------------------------------------------------------------

  return (
    <div>
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
            <span className="font-medium text-neutral-100">Auto handle (Silver)</span>
          </label>
          <span className="text-xs text-neutral-500">
            monitor drafts · for failed runs save{" "}
            <code className="text-neutral-400">&lt;silverDir&gt;/&lt;taskName&gt;.json</code> as
            the &quot;already handled&quot; marker · scan{" "}
            <code className="text-neutral-400">&lt;silverDir&gt;/&lt;taskName&gt;/</code> folders
            and submit only when no sibling JSON exists · folders are never
            auto-deleted
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
        {zipDir && (
          <div className="mt-1 text-[10px] text-neutral-500">
            silver dir: <code>{zipDir}</code> · {zips.length} task folder(s) ·{" "}
            {managedCount > 0 ? (
              <span className="text-emerald-400">
                {managedCount} with task.toml — submits + feedback writes are
                scoped to these
              </span>
            ) : (
              <span className="text-amber-400">
                ⚠ no folders with a task.toml found — nothing is ready to
                submit, feedback writes are disabled
              </span>
            )}
          </div>
        )}
        {(() => {
          const approvedRepos = repos.filter((r) =>
            /approv/i.test(r.status || "")
          );
          return (
            <details className="mt-2" open>
              <summary className="cursor-pointer text-xs text-neutral-500">
                Approved repos ({approvedRepos.length}
                {repos.length !== approvedRepos.length && (
                  <span className="text-neutral-600">
                    {" "}/ {repos.length} total
                  </span>
                )}
                )
                {reposErr && (
                  <span className="ml-2 text-amber-400">⚠ {reposErr}</span>
                )}
              </summary>
              {approvedRepos.length === 0 && !reposErr ? (
                <div className="mt-1 text-[10px] text-neutral-500">
                  no approved repos — submit will fall back to repos.json
                </div>
              ) : (
                <div className="mt-1 overflow-hidden rounded border border-neutral-800">
                  <table className="w-full text-xs">
                    <thead className="bg-neutral-900 text-[10px] uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">
                          Name
                        </th>
                        <th className="px-2 py-1 text-left font-medium">
                          Repo ID
                        </th>
                        <th className="px-2 py-1 text-left font-medium">
                          Language
                        </th>
                        <th className="px-2 py-1 text-right font-medium">
                          Tasks
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {approvedRepos.map((r) => {
                        const name =
                          r.repoName || r.displayName || "(unnamed)";
                        return (
                          <tr
                            key={r.id}
                            className="border-t border-neutral-800 hover:bg-neutral-900/50"
                          >
                            <td className="px-2 py-1 font-medium text-emerald-200">
                              {name}
                            </td>
                            <td className="px-2 py-1 font-mono text-[10px] text-neutral-400">
                              {r.id}
                            </td>
                            <td className="px-2 py-1 text-[10px] text-neutral-500">
                              {r.language || "—"}
                            </td>
                            <td className="px-2 py-1 text-right text-[10px] text-neutral-500">
                              {Array.isArray(r.taskIds)
                                ? r.taskIds.length
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          );
        })()}
        {zips.length > 0 && (() => {
          // Compute the set of taskNames that already have a draft on
          // AfterQuery so each folder row can disable its Submit button
          // (server's duplicate-draft guard would skip them anyway).
          const draftedTaskNames = new Set<string>(
            drafts
              .map((d) => d.taskName)
              .filter((n): n is string => typeof n === "string" && n.length > 0)
          );
          // Server-side status per submitted task — prefer the latest
          // submission's status (filled by the auto-tick / opening a draft
          // row), fall back to the draft's own status. Drives the colored
          // badge on each folder row (Approved / Needs Review / …).
          const statusByTask = new Map<string, string>();
          for (const d of drafts) {
            if (!d.taskName) continue;
            const subs = submissionsByDraft[d.id];
            const st =
              (subs && subs.length > 0 && subs[0].status) || d.status || "";
            if (st) statusByTask.set(d.taskName, st);
          }
          return (
          <details className="mt-2" open={autoEnabled}>
            <summary className="cursor-pointer text-xs text-neutral-500">
              Local task folders ({zips.length})
            </summary>
            <div className="mt-1 space-y-1">
              {zips.map((z) => (
                <div
                  key={z.fileName}
                  className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs ${
                    z.doNotSubmit
                      ? "border-neutral-800 bg-neutral-900/50 opacity-60"
                      : "border-neutral-800 bg-neutral-950"
                  }`}
                >
                  <span
                    className={`font-medium ${
                      z.doNotSubmit
                        ? "text-neutral-500 line-through"
                        : "text-neutral-200"
                    }`}
                  >
                    {z.taskName}
                  </span>
                  {z.taskType && (
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                      {z.taskType}
                    </span>
                  )}
                  {z.repoType && (
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {z.repoType}
                    </span>
                  )}
                  {z.estimatedSolveTime && !z.doNotSubmit && (
                    <span className="text-[10px] text-neutral-500">
                      {z.estimatedSolveTime}
                    </span>
                  )}
                  {z.requiresInternet === true && (
                    <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                      internet
                    </span>
                  )}
                  {!z.hasMeta && (
                    <span
                      className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300"
                      title={`${z.taskName}/task.toml is broken or unreadable — fix it to enable submitting`}
                    >
                      bad task.toml
                    </span>
                  )}
                  {z.hasFeedback && !z.doNotSubmit && (
                    <span
                      className="rounded bg-sky-900/40 px-1.5 py-0.5 text-[10px] text-sky-300"
                      title={`feedback exists: ${z.taskName}.feedback.json — delete it to allow a retry`}
                    >
                      feedback ✓
                    </span>
                  )}
                  {draftedTaskNames.has(z.taskName) && !z.doNotSubmit && (() => {
                    const st = statusByTask.get(z.taskName) || "";
                    return (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${statusClass(st)}`}
                        title={
                          st
                            ? `Submitted — latest status on AfterQuery: ${st}`
                            : "A draft for this task already exists on AfterQuery — delete it (or wait for the auto-handler) before resubmitting"
                        }
                      >
                        {st || "submitted"}
                      </span>
                    );
                  })()}
                  {(() => {
                    // Stats chips — every task in this list is tracked in
                    // task-stats.json, so all three counters are always
                    // shown (zeros muted, non-zeros colored).
                    const submits = z.submitCount ?? 0;
                    const s7 = z.failedStep7 ?? 0;
                    const s8 = z.failedStep8 ?? 0;
                    const zero =
                      "rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-600";
                    return (
                      <>
                        <span
                          className={
                            submits > 0
                              ? "rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300"
                              : zero
                          }
                          title={`Submitted ${submits} time(s) total${
                            z.failedOtherSteps &&
                            Object.keys(z.failedOtherSteps).length
                              ? `\nOther-step failures: ${Object.entries(
                                  z.failedOtherSteps
                                )
                                  .map(([stage, n]) => `${stage} ×${n}`)
                                  .join(", ")}`
                              : ""
                          }`}
                        >
                          ↥{submits}
                        </span>
                        <span
                          className={
                            s7 > 0
                              ? "rounded bg-orange-900/40 px-1.5 py-0.5 text-[10px] text-orange-300"
                              : zero
                          }
                          title={`Failed ${s7} time(s) at step 7 — Easiness Prefilter (task solved too easily)`}
                        >
                          7✗{s7}
                        </span>
                        <span
                          className={
                            s8 > 0
                              ? "rounded bg-rose-900/40 px-1.5 py-0.5 text-[10px] text-rose-300"
                              : zero
                          }
                          title={`Failed ${s8} time(s) at step 8 — Difficulty Probe`}
                        >
                          8✗{s8}
                        </span>
                      </>
                    );
                  })()}
                  {z.failed && !z.doNotSubmit && (
                    <span
                      className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300"
                      title={`task.toml status = Failed — remove it (or set "Ready") to allow another attempt`}
                    >
                      failed
                    </span>
                  )}
                  {z.doNotSubmit && (
                    <span
                      className="ml-auto rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-300"
                      title={`task.toml status blocks submission — remove it (or set "Ready") to enable`}
                    >
                      blocked{z.note ? ` · ${z.note}` : ""}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-neutral-600">
                    {z.fileCount ? `${z.fileCount} files · ` : ""}
                    {(z.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                  {!z.doNotSubmit && (() => {
                    const alreadyDrafted = draftedTaskNames.has(z.taskName);
                    const disabled =
                      busySubmitTask !== null ||
                      !z.ready ||
                      Boolean(z.hasFeedback) ||
                      alreadyDrafted ||
                      Boolean(z.failed);
                    const title = z.failed
                      ? `task.toml status = Failed — remove it (or set "Ready") to allow submitting again`
                      : !z.hasMeta
                      ? `Fix ${z.taskName}/task.toml to enable submitting`
                      : alreadyDrafted
                      ? "A draft already exists on AfterQuery — delete it before resubmitting"
                      : z.hasFeedback
                      ? `Delete ${z.taskName}.feedback.json first — server-side guard will skip otherwise`
                      : `Submit ${z.taskName} to AfterQuery now`;
                    return (
                      <button
                        type="button"
                        onClick={() => submitOneTask(z.taskName)}
                        disabled={disabled}
                        title={title}
                        className="rounded border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-[10px] font-medium text-emerald-300 hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busySubmitTask === z.taskName ? "Submitting…" : "Submit"}
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => deleteOneFolder(z.taskName)}
                    disabled={busyDeleteFolder !== null}
                    title={`Delete the LOCAL folder ${z.taskName}/ (and its feedback file) from the tasks dir — nothing on AfterQuery is touched`}
                    className="rounded border border-red-900 bg-red-950/60 px-2 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyDeleteFolder === z.taskName
                      ? "Removing…"
                      : "Remove folder"}
                  </button>
                </div>
              ))}
            </div>
          </details>
          );
        })()}
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

      {drafts.length > 0 && (() => {
        // ---- Analysis card -------------------------------------------------
        // Aggregated from the live drafts list (same status source as the
        // per-row badges): total approved, total needs/ready-for-review, and
        // a per-repo task count (repoId resolved to its name via the repos
        // list; unknown ids fall back to the task-name prefix).
        const repoNameById = new Map<string, string>(
          repos.map((r) => [r.id, r.repoName || r.displayName || r.id])
        );
        let approved = 0;
        let needsReview = 0;
        // Per-repo counts include ONLY approved + needs-review tasks —
        // validating / failed / draft-state ones don't count. Each repo
        // keeps the two tallies separate: "<approved> + <needsReview>".
        const byRepo = new Map<string, { approved: number; review: number }>();
        for (const d of drafts) {
          const subs = submissionsByDraft[d.id];
          const st = (
            (subs && subs.length > 0 && subs[0].status) ||
            d.status ||
            ""
          ).toLowerCase();
          const isApproved = st.includes("approv");
          const isReview = !isApproved && st.includes("review");
          if (isApproved) approved += 1;
          else if (isReview) needsReview += 1;
          if (!isApproved && !isReview) continue;
          const repoName =
            (d.repoId && repoNameById.get(d.repoId)) ||
            (typeof d.taskName === "string" && d.taskName.includes("-")
              ? d.taskName.split("-")[0]
              : null) ||
            "(unknown)";
          let counts = byRepo.get(repoName);
          if (!counts) {
            counts = { approved: 0, review: 0 };
            byRepo.set(repoName, counts);
          }
          if (isApproved) counts.approved += 1;
          else counts.review += 1;
        }
        const repoRows = Array.from(byRepo.entries()).sort(
          (a, b) =>
            b[1].approved + b[1].review - (a[1].approved + a[1].review) ||
            a[0].localeCompare(b[0])
        );
        return (
          <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
            <div className="mb-2 text-sm font-medium text-neutral-200">
              Analysis
            </div>
            <div className="flex flex-wrap items-start gap-6">
              <div>
                <div className="text-2xl font-semibold text-emerald-400">
                  {approved}
                </div>
                <div className="text-[11px] text-neutral-500">approved</div>
              </div>
              <div>
                <div className="text-2xl font-semibold text-sky-400">
                  {needsReview}
                </div>
                <div className="text-[11px] text-neutral-500">
                  needs review
                </div>
              </div>
              <div className="min-w-[200px] flex-1">
                <div className="mb-1 text-[11px] text-neutral-500">
                  tasks per repo — approved + needs review (
                  {approved + needsReview} total)
                </div>
                <div className="flex flex-wrap gap-1">
                  {repoRows.map(([name, counts]) => (
                    <span
                      key={name}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300"
                      title={`${name}: ${counts.approved} approved + ${counts.review} needs review`}
                    >
                      {name}{" "}
                      <span className="text-xl font-semibold text-emerald-400">
                        {counts.approved}
                      </span>{" "}
                      <span className="text-neutral-500">+</span>{" "}
                      <span className="text-xl font-semibold text-sky-400">
                        {counts.review}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => loadDrafts(true)}
          disabled={loading}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Reload drafts"}
        </button>
        <span className="text-xs text-neutral-500">
          {loaded ? `${drafts.length} drafts · auto-refresh 10s` : "auto-refresh 10s"}
        </span>
      </div>

      {err && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="space-y-2">
        {drafts.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 px-3 py-6 text-center text-sm text-neutral-500">
            {loading ? "Loading…" : loaded ? "No drafts." : "—"}
          </div>
        ) : (
          drafts.map((d) => {
            const open = openDraftId === d.id;
            const subs = submissionsByDraft[d.id];
            // Prefer the latest submission's pipeline (richest data — runs,
            // verdicts) over the draft's denormalised blob. When no submission
            // is loaded yet, fall back to the draft itself; the StageBar will
            // then render as 8 pending segments until polling fills it in.
            const sourceForRow = subs && subs.length > 0 ? subs[0] : d;
            const draftPipeline = buildSilverPipelineView(sourceForRow);
            const effectiveStatus =
              (subs && subs.length > 0 ? subs[0].status : null) ||
              draftPipeline.overallStatus ||
              d.status ||
              "";
            return (
              <div key={d.id} className="rounded-lg border border-neutral-800 bg-neutral-900">
                <div
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
                    toggleDraft(d.id);
                  }}
                  className="cursor-pointer px-3 py-2 hover:bg-neutral-900/40"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-neutral-500" aria-hidden>
                      {open ? "▾" : "▸"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-neutral-100">
                        {d.taskName || d.id}
                      </div>
                      <div className="truncate text-xs text-neutral-500">
                        {d.repoId ? `${d.repoId} · ` : ""}
                        {d.baseCommit ? `${d.baseCommit.slice(0, 7)} · ` : ""}
                        updated {fmtWhen(d.updatedAt || d.createdAt)}
                      </div>
                    </div>
                    <StepBadge pipeline={draftPipeline} />
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${statusClass(
                        effectiveStatus
                      )}`}
                    >
                      {effectiveStatus || "—"}
                    </span>
                    {(() => {
                      // Manual delete — HIDDEN entirely when the draft is:
                      //   - approved            (earned bonus — off-limits)
                      //   - needs / ready for review (queued for the human
                      //     reviewer, may convert to approved)
                      //   - validating          (pipeline still processing)
                      // "Validation Failed" does NOT match — only the
                      // in-progress "Validating" status hides the button.
                      const st = effectiveStatus.toLowerCase();
                      const hideDelete =
                        st.includes("approv") ||
                        st.includes("review") ||
                        st.includes("validating") ||
                        st.includes("processing") ||
                        st.includes("running");
                      if (hideDelete) return null;
                      // Defense-in-depth: even when the status string looks
                      // deletable, a protected submission on the draft still
                      // hard-disables the button (same hasProtectedSubmission
                      // guard the auto-handler uses).
                      const protectedDraft = subs
                        ? hasProtectedSubmission(subs)
                        : false;
                      const busy = busyDeleteDraft === d.id;
                      return (
                        <button
                          type="button"
                          onClick={() =>
                            deleteOneDraft(d.id, d.taskName || d.id)
                          }
                          disabled={
                            busy ||
                            busyDeleteDraft !== null ||
                            protectedDraft
                          }
                          title={
                            protectedDraft
                              ? "Cannot delete — draft has approved or ready-for-review submission"
                              : `Delete draft ${d.taskName || d.id}`
                          }
                          className="rounded border border-red-900 bg-red-950 px-2 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busy ? "Deleting…" : "Delete"}
                        </button>
                      );
                    })()}
                  </div>
                  {/* Always-visible per-stage progress so the user can see
                      where the pipeline is (or where it failed) without
                      clicking to expand. */}
                  <StageBar pipeline={draftPipeline} />
                  {draftPipeline.failureMessage && (
                    <div className="mt-1 truncate text-[11px] text-red-400">
                      {draftPipeline.failureMessage}
                      {draftPipeline.failureKind ? (
                        <span className="text-neutral-500">
                          {" "}· {draftPipeline.failureKind}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>

                {open && (
                  <div className="border-t border-neutral-800 px-3 py-3">
                    {loadingSubsFor === d.id ? (
                      <span className="text-xs text-sky-400">Loading submissions…</span>
                    ) : !subs ? (
                      <span className="text-xs text-neutral-500">No data yet.</span>
                    ) : subs.length === 0 ? (
                      <span className="text-xs text-neutral-500">No submissions.</span>
                    ) : (
                      <div className="space-y-2">
                        {subs.map((sub) => {
                          const pipeline = buildSilverPipelineView(sub);
                          const cost =
                            sub.costBreakdown?.totalUsd ?? sub.pipelineCostUsd ?? null;
                          return (
                            <div
                              key={sub.id}
                              className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-medium text-neutral-200">
                                  {sub.taskName || sub.id}
                                </span>
                                <StepBadge pipeline={pipeline} />
                                <span
                                  className={`rounded px-2 py-0.5 text-xs ${statusClass(
                                    sub.status || ""
                                  )}`}
                                >
                                  {sub.status || "—"}
                                </span>
                                {cost != null && (
                                  <span className="text-xs text-neutral-500">
                                    ${cost.toFixed(2)}
                                  </span>
                                )}
                                <span className="ml-auto text-xs text-neutral-500">
                                  {fmtWhen(sub.updatedAt || sub.createdAt)}
                                </span>
                              </div>
                              <PipelineCard
                                pipeline={pipeline}
                                rowId={sub.id}
                                openStages={openStages}
                                setOpenStages={setOpenStages}
                              />
                            </div>
                          );
                        })}
                      </div>
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

// ---- Client-side mirror of lib/silver.ts's extractFailureSummary ---------
// (kept in this file so the component doesn't need a network round-trip to
//  decide which submissions to surface as failures in the list)

interface FailureSummary {
  taskName: string;
  status: string;
  failedStage: string | null;
  failureKind: string | null;
  failureReason: string | null;
  stage: Record<string, unknown> | null;
}

/** Convert a snake_case stage name to its camelCase form. AfterQuery's
 *  `pipeline.failedStage` field returns snake_case (e.g. `"rubric_review"`),
 *  but the pipeline-data keys, our `SILVER_STAGE_DEFS`, and the GCS URL
 *  pattern (`/rubricReview/response.json`) all use camelCase. Normalising
 *  at the boundary keeps `summary.failedStage` consistent and makes the
 *  log-fetch + stage-data lookups work. Identity for already-camelCase. */
function toCamelStage(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Read a stage's blob from the pipeline regardless of whether the key is in
 *  snake_case or camelCase. Tries the given name first, then the alternate
 *  casing. */
function readStageData(
  p: Record<string, unknown>,
  stage: string
): unknown {
  if (stage in p) return p[stage];
  const camel = toCamelStage(stage);
  if (camel !== stage && camel in p) return p[camel];
  // snake fallback (camelCase → snake_case)
  const snake = stage.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  if (snake !== stage && snake in p) return p[snake];
  return undefined;
}

function extractFailureSummary(submission: unknown): FailureSummary | null {
  if (!submission || typeof submission !== "object") return null;
  const s = submission as {
    taskName?: string;
    status?: string;
    pipeline?: Record<string, unknown>;
  };
  const p = s.pipeline;
  if (!p) return null;
  // Use the same pipeline view the UI uses so verdict-driven failures
  // (TOO_EASY / TOO_HARD detected from probe pass/attempts numbers) also
  // produce a summary even when AfterQuery's raw `failedStage` is empty
  // and `status` is "passed" / "Needs Review".
  const view = buildSilverPipelineView(submission);
  const rawFailedStage = (p.failedStage as string | null | undefined) ?? null;
  const status = s.status ?? "";
  const hasRawFailure = Boolean(rawFailedStage) || /fail|reject|error/i.test(status);
  if (!hasRawFailure && !view.failed) return null;
  // Canonicalise failedStage to camelCase so downstream lookups + the
  // stagesWithLog check + the GCS path all agree.
  const rawOrView = rawFailedStage ?? view.failedStage;
  const failedStage = rawOrView ? toCamelStage(rawOrView) : null;
  return {
    taskName: s.taskName ?? "",
    status: view.overallStatus ?? status,
    failedStage,
    failureKind:
      (p.failureKind as string | null | undefined) ?? view.failureKind ?? null,
    failureReason:
      (p.failureReason as string | null | undefined) ??
      view.failureMessage ??
      null,
    stage: failedStage
      ? compactStage(failedStage, readStageData(p, failedStage))
      : null,
  };
}

function compactStage(name: string, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pick = (keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in o) out[k] = o[k];
    return out;
  };
  const base = pick(["status", "error", "ranAt"]);
  switch (name) {
    case "similarity":
      return {
        ...base,
        ...pick(["nearestDistance", "nearestTaskName", "nearestTaskId", "blocked"]),
        details: Array.isArray(o.details)
          ? (o.details as Array<Record<string, unknown>>).map((d) => {
              const dp: Record<string, unknown> = {};
              for (const k of ["layer", "severity", "score", "message"])
                if (k in d) dp[k] = d[k];
              return dp;
            })
          : null,
      };
    case "gptZeroCheck":
      return {
        ...base,
        ...pick(["threshold", "failOpen", "failOpenReason"]),
      };
    case "rubricReview":
      return { ...base, ...pick(["decision", "blocked", "costUsd"]) };
    case "taskImageBuild":
      return { ...base, ...pick(["imageRef", "jobName"]) };
    case "oracleCheck":
    case "nullCheck":
      return { ...base, ...pick(["reward", "jobId"]) };
    case "easinessProbe":
    case "difficultyProbe":
      return {
        ...base,
        ...pick(["passed", "attempts", "solveRate", "model"]),
        runs: Array.isArray(o.runs)
          ? (o.runs as Array<Record<string, unknown>>).map((r) => {
              const rp: Record<string, unknown> = {};
              // Preserve runId so the auto-handler can fetch the per-run
              // GCS log blob (one log file per probe run).
              for (const k of [
                "runIndex",
                "reward",
                "runId",
                "id",
                "jobName",
                "status",
              ])
                if (k in r) rp[k] = r[k];
              return rp;
            })
          : null,
      };
    case "trajectoryReview":
    case "fairnessReview":
      return { ...base, ...pick(["decision", "blocked", "costUsd"]) };
    default:
      return base;
  }
}

// ---- Pluto-style progress display ---------------------------------------

type RingVariant = "running" | "done" | "review" | "failed";

const RING_COLORS: Record<RingVariant, { ring: string; text: string }> = {
  running: { ring: "#38bdf8", text: "text-sky-400" },
  done: { ring: "#34d399", text: "text-emerald-400" },
  review: { ring: "#38bdf8", text: "text-sky-400" },
  failed: { ring: "#f87171", text: "text-red-400" },
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

function StepBadge({ pipeline }: { pipeline: SilverPipelineView }) {
  let variant: RingVariant;
  if (pipeline.failed) variant = "failed";
  else if (pipeline.completed) variant = "done";
  else variant = "running";
  return (
    <ProgressRing
      current={pipeline.currentStep}
      total={pipeline.totalSteps}
      variant={variant}
    />
  );
}

/** Horizontal segmented progress bar — one segment per stage, colored by
 *  status. Sits inline in the draft row so the user can see how far the
 *  pipeline got (and where it failed) without expanding. */
function StageBar({ pipeline }: { pipeline: SilverPipelineView }) {
  const stageColor = (s: SilverStageStatus): string => {
    switch (s) {
      case "done":
        return "bg-emerald-500";
      case "failed":
        return "bg-red-500";
      case "running":
        return "bg-amber-400 animate-pulse";
      case "skipped":
        return "bg-neutral-700/70";
      default:
        return "bg-neutral-800";
    }
  };
  return (
    <div
      className="mt-1 flex h-1.5 gap-px overflow-hidden rounded"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={pipeline.totalSteps}
      aria-valuenow={pipeline.currentStep}
      aria-label={`Pipeline ${pipeline.currentStep} of ${pipeline.totalSteps}`}
    >
      {pipeline.stages.map((s, i) => (
        <div
          key={s.key}
          className={`flex-1 ${stageColor(s.status)}`}
          title={`${i + 1}. ${s.label} — ${s.status}${
            s.summary ? ` · ${s.summary}` : ""
          }${s.error ? ` · ${s.error}` : ""}`}
        />
      ))}
    </div>
  );
}

function StageIcon({ status }: { status: SilverStageStatus }) {
  if (status === "done") return <span className="text-emerald-400">✓</span>;
  if (status === "failed") return <span className="text-red-400">✗</span>;
  if (status === "running")
    return (
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400 align-middle" />
    );
  return (
    <span className="inline-block h-3.5 w-3.5 rounded-full border border-neutral-700 align-middle" />
  );
}

function PipelineCard({
  pipeline,
  rowId,
  openStages,
  setOpenStages,
}: {
  pipeline: SilverPipelineView;
  rowId: string;
  openStages: Record<string, boolean>;
  setOpenStages: (f: (s: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  return (
    <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-950">
      <div className="flex items-start justify-between gap-4 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">
            Silver pipeline
          </div>
          <div className="text-base font-semibold text-neutral-100">
            {pipeline.completed
              ? `Completed all ${pipeline.totalSteps} steps`
              : `Step ${pipeline.currentStep} of ${pipeline.totalSteps}`}
            {pipeline.failed && (
              <span className="ml-2 text-red-400">· failed</span>
            )}
          </div>
          {pipeline.failureMessage && (
            <div className="mt-1 text-xs text-red-400">
              {pipeline.failureMessage}
              {pipeline.failureKind ? (
                <span className="text-neutral-500"> · {pipeline.failureKind}</span>
              ) : null}
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
                  <StageIcon status={s.status} />
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
    </div>
  );
}

export { ProgressRing, StepBadge, PipelineCard };
