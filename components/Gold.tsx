"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

/**
 * Gold project tab.
 *
 * Repo → task tree. Repos are the folders under GOLD_DIR/result/; a ▸/▾ triangle
 * before the repo name expands it to show its tasks (result/<repo>/tasks/).
 * A repo's data.txt gives its repo_url; we cross-check gold.repos.list:
 *   - NOT connected → "Connect repo" in the Action column.
 *   - connected     → each task row gets an "Add environment" button.
 *
 * `manualToken` matches the other tabs: the pasted Bearer token from the auth
 * bar (empty string when the extension/refresh-token is used).
 */

interface RepoRow {
  name: string;
  modifiedMs: number;
  hasStatus: boolean;
  taskCount: number;
  repoUrl: string | null;
  repository: string | null;
  cloneUrl: string | null;
  defaultBranch: string | null;
  archived: boolean;
}

interface GoldEnvironment {
  baseSha: string;
  status: string;
  version?: number;
  imageRef?: string;
}

interface ConnectedRepo {
  id?: string;
  repoUrl: string;
  status?: string;
  environmentCount: number;
  environments: GoldEnvironment[];
  language?: string;
}

interface TaskItem {
  name: string;
  modifiedMs: number;
  baseCommit: string | null;
  taskName: string;
  archived: boolean;
}

interface PipelineStep {
  key: string;
  label: string;
  status: string; // passed | running | failed | pending
}

interface GoldMessage {
  scope: string;
  level: string;
  message: string;
  code?: string;
  path?: string;
}

interface MyTask {
  id?: string;
  taskName: string;
  repoId: string;
  baseSha?: string;
  status?: string;
  environmentVersion?: number;
  steps: PipelineStep[];
  pipelineDone: boolean;
  failedStage: string | null;
  messages: GoldMessage[];
}

/** Copy text to clipboard, with a fallback for insecure (http) origins where
 *  navigator.clipboard is unavailable. */
async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to legacy copy */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/** Format ERROR messages for the clipboard (warnings excluded):
 *   Task: <task-name>
 *   Error:
 *   <error message(s)>
 */
function errorsToText(taskName: string, msgs: GoldMessage[]): string {
  const errors = msgs.filter((m) => m.level === "error").map((m) => m.message);
  return `Task: ${taskName}\nError:\n${errors.join("\n")}`;
}

/** A task is mid-validation while its status is "Validating" and not finished. */
function isValidating(t?: MyTask): boolean {
  return Boolean(t && t.status === "Validating" && !t.pipelineDone);
}

/** Horizontal 8-segment pipeline progress bar with a caption. */
function PipelineProgress({ steps }: { steps: PipelineStep[] }) {
  if (!steps || steps.length === 0) return null;
  const passed = steps.filter((s) => s.status === "passed").length;
  const running = steps.find((s) => s.status === "running");
  const failed = steps.find((s) => s.status === "failed");
  const caption = failed
    ? `Failed: ${failed.label}`
    : running
    ? `${running.label}… (${passed}/${steps.length})`
    : `${passed}/${steps.length}`;
  return (
    <div className="mt-1 w-full max-w-[260px]">
      <div className="flex gap-0.5">
        {steps.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${s.status}`}
            className={`h-1.5 flex-1 rounded-full ${
              s.status === "passed"
                ? "bg-emerald-500"
                : s.status === "failed"
                ? "bg-red-500"
                : s.status === "running"
                ? "animate-pulse bg-violet-500"
                : "bg-neutral-700"
            }`}
          />
        ))}
      </div>
      <div
        className={`mt-0.5 text-[10px] ${failed ? "text-red-400" : "text-neutral-500"}`}
      >
        {caption}
      </div>
    </div>
  );
}

type ConnectState = "idle" | "connecting" | "error";
type EnvState = "none" | "building" | "published";

/** Environment state for a task's base_commit within a connected repo. */
function envStateFor(conn: ConnectedRepo | undefined, baseCommit: string | null): EnvState {
  if (!conn || !baseCommit) return "none";
  const bc = baseCommit.toLowerCase();
  const matches = conn.environments.filter((e) => e.baseSha.toLowerCase() === bc);
  if (matches.some((e) => e.status === "published")) return "published";
  if (matches.length > 0) return "building"; // exists but not yet published
  return "none";
}

/** Highest published environment version for a task's base_commit (or null). */
function publishedEnvVersion(
  conn: ConnectedRepo | undefined,
  baseCommit: string | null
): number | null {
  if (!conn || !baseCommit) return null;
  const bc = baseCommit.toLowerCase();
  const versions = conn.environments
    .filter(
      (e) => e.baseSha.toLowerCase() === bc && e.status === "published" && typeof e.version === "number"
    )
    .map((e) => e.version as number);
  return versions.length ? Math.max(...versions) : null;
}

function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Normalize a repo URL for matching (lowercase, drop .git and trailing slash). */
function normUrl(u: string | null): string {
  return (u || "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

/** AfterQuery task page URL for a created task id. */
const taskUrl = (id: string) => `https://experts.afterquery.com/projects/gold/tasks/${id}`;

/** Filter-board categories, mapped to a task's current action state. */
const TASK_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "add-env", label: "Add environment" },
  { key: "building", label: "Building" },
  { key: "new-task", label: "New task" },
  { key: "updating", label: "Updating" },
  { key: "submit", label: "Submit for validation" },
  { key: "validating", label: "Validating" },
  { key: "needs-review", label: "Needs review" },
];

export default function Gold({ manualToken }: { manualToken: string }) {
  const [dir, setDir] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");

  const [connected, setConnected] = useState<Map<string, ConnectedRepo>>(new Map());
  const [connectedErr, setConnectedErr] = useState("");

  const [connectState, setConnectState] = useState<Record<string, ConnectState>>({});
  const [connectMsg, setConnectMsg] = useState<Record<string, string>>({});

  // Which repos are expanded + their loaded task lists, keyed by repo folder name.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<Record<string, TaskItem[]>>({});
  const [tasksLoading, setTasksLoading] = useState<Record<string, boolean>>({});
  const [tasksErr, setTasksErr] = useState<Record<string, string>>({});
  const [envMsg, setEnvMsg] = useState<Record<string, string>>({}); // keyed `repo::task`
  const [submitting, setSubmitting] = useState<Set<string>>(new Set()); // task keys mid-submit
  const [creating, setCreating] = useState<Set<string>>(new Set()); // task keys mid new-task
  const [validating, setValidating] = useState<Set<string>>(new Set()); // task keys mid submit
  const [deleting, setDeleting] = useState<Set<string>>(new Set()); // task keys mid delete
  // Created tasks keyed by `${repoId}::${taskName}` (from gold.tasks.listMine).
  const [myTasks, setMyTasks] = useState<Map<string, MyTask>>(new Map());
  const [refreshedAt, setRefreshedAt] = useState(0); // last Reload click (epoch ms)
  const [showArchived, setShowArchived] = useState(false);
  // Selected filter-board categories (multi-select). Empty = "All".
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Task keys (`${repo}::${task}`) marked "updating" — action buttons disabled.
  // Persisted in localStorage so it survives a page refresh.
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/gold/list", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load Gold repos");
      setDir(data.dir);
      setRepos(data.repos);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConnected = useCallback(async () => {
    setConnectedErr("");
    try {
      const res = await fetch("/api/gold/connected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: manualToken }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load connected repos");
      const map = new Map<string, ConnectedRepo>();
      // Only status === "Connected" counts as connected. Skip Rejected/other
      // states so those repos fall back to "Connect repo" (retry). A Connected
      // entry always wins over a same-URL non-connected one.
      for (const r of data.repos as ConnectedRepo[]) {
        if (r.status === "Connected") map.set(normUrl(r.repoUrl), r);
      }
      setConnected(map);
    } catch (e) {
      setConnectedErr((e as Error).message);
    }
  }, [manualToken]);

  const loadMyTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/gold/my-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: manualToken }),
      });
      const data = await res.json();
      if (!data.ok) return; // silent — connected warning already covers auth issues
      const map = new Map<string, MyTask>();
      for (const t of data.tasks as MyTask[]) map.set(`${t.repoId}::${t.taskName}`, t);
      setMyTasks(map);
    } catch {
      /* ignore */
    }
  }, [manualToken]);

  const loadTasks = useCallback(async (repoName: string) => {
    setTasksLoading((s) => ({ ...s, [repoName]: true }));
    setTasksErr((s) => ({ ...s, [repoName]: "" }));
    try {
      const res = await fetch(`/api/gold/tasks?repo=${encodeURIComponent(repoName)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load tasks");
      setTasks((s) => ({ ...s, [repoName]: data.tasks }));
    } catch (e) {
      setTasksErr((s) => ({ ...s, [repoName]: (e as Error).message }));
    } finally {
      setTasksLoading((s) => ({ ...s, [repoName]: false }));
    }
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    loadConnected();
  }, [loadConnected]);

  useEffect(() => {
    loadMyTasks();
  }, [loadMyTasks]);

  // After the repo list (re)loads — on mount and on Reload — expand every repo
  // and (re)fetch its task tree, so all repos appear expanded with fresh tasks.
  useEffect(() => {
    if (repos.length === 0) return;
    const names = repos.map((r) => r.name);
    setExpanded(new Set(names));
    names.forEach((name) => loadTasks(name));
  }, [repos, loadTasks]);

  const toggleExpand = useCallback(
    (repoName: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(repoName)) {
          next.delete(repoName);
        } else {
          next.add(repoName);
          if (!tasks[repoName]) loadTasks(repoName);
        }
        return next;
      });
    },
    [tasks, loadTasks]
  );

  const connect = useCallback(
    async (repoUrl: string) => {
      setConnectState((s) => ({ ...s, [repoUrl]: "connecting" }));
      setConnectMsg((m) => ({ ...m, [repoUrl]: "" }));
      try {
        const res = await fetch("/api/gold/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, token: manualToken }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Connect failed");
        setConnectState((s) => ({ ...s, [repoUrl]: "idle" }));
        await loadConnected();
      } catch (e) {
        setConnectState((s) => ({ ...s, [repoUrl]: "error" }));
        setConnectMsg((m) => ({ ...m, [repoUrl]: (e as Error).message }));
      }
    },
    [manualToken, loadConnected]
  );

  const addEnvironment = useCallback(
    async (repoName: string, repoId: string | undefined, task: TaskItem) => {
      const key = `${repoName}::${task.name}`;
      if (!repoId) {
        setEnvMsg((m) => ({ ...m, [key]: "Missing repoId (repo not connected?)." }));
        return;
      }
      setSubmitting((s) => new Set(s).add(key));
      setEnvMsg((m) => ({ ...m, [key]: "" }));
      try {
        const res = await fetch("/api/gold/add-environment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoName, task: task.name, repoId, token: manualToken }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Add environment failed");
        setEnvMsg((m) => ({ ...m, [key]: "Building environment…" }));
        await loadConnected(); // pick up the new "building" environment
      } catch (e) {
        setSubmitting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      }
    },
    [manualToken, loadConnected]
  );

  const newTask = useCallback(
    async (repoName: string, conn: ConnectedRepo | undefined, task: TaskItem) => {
      const key = `${repoName}::${task.name}`;
      if (!conn?.id) {
        setEnvMsg((m) => ({ ...m, [key]: "Missing repoId (repo not connected?)." }));
        return;
      }
      const version = publishedEnvVersion(conn, task.baseCommit);
      if (version == null) {
        setEnvMsg((m) => ({ ...m, [key]: "No published environment version found." }));
        return;
      }
      setCreating((s) => new Set(s).add(key));
      setEnvMsg((m) => ({ ...m, [key]: "" }));
      try {
        const res = await fetch("/api/gold/new-task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: repoName,
            task: task.name,
            repoId: conn.id,
            environmentVersion: version,
            token: manualToken,
          }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "New task failed");
        setEnvMsg((m) => ({ ...m, [key]: "Task created ✓" }));
        await loadMyTasks(); // flip to "Submit for validation"
      } catch (e) {
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      } finally {
        setCreating((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [manualToken, loadMyTasks]
  );

  const submitForValidation = useCallback(
    async (repoName: string, conn: ConnectedRepo | undefined, task: TaskItem, myTask: MyTask) => {
      const key = `${repoName}::${task.name}`;
      if (!myTask?.id) {
        setEnvMsg((m) => ({ ...m, [key]: "Missing task id." }));
        return;
      }
      // Docker image comes from the published environment for this base_commit.
      const bc = (task.baseCommit || "").toLowerCase();
      const env =
        conn?.environments.find((e) => e.baseSha.toLowerCase() === bc && e.status === "published") ||
        conn?.environments.find((e) => e.baseSha.toLowerCase() === bc);
      setValidating((s) => new Set(s).add(key));
      setEnvMsg((m) => ({ ...m, [key]: "" }));
      try {
        const res = await fetch("/api/gold/submit-validation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: repoName,
            task: task.name,
            submissionId: myTask.id,
            dockerImage: env?.imageRef || "",
            language: conn?.language || "",
            token: manualToken,
          }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Submit failed");
        if (data.submitted) {
          setEnvMsg((m) => ({ ...m, [key]: "Submitted for validation ✓" }));
        } else {
          const failed = (data.rules || [])
            .filter((r: { pass: boolean }) => !r.pass)
            .map((r: { name: string; actual: number }) => `${r.name}=${r.actual}`);
          setEnvMsg((m) => ({
            ...m,
            [key]: `Saved, but rules not met: ${failed.join(", ")}`,
          }));
        }
        await loadMyTasks();
      } catch (e) {
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      } finally {
        setValidating((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [manualToken, loadMyTasks]
  );

  // Clear the transient "submitting" flag once the server reflects the env
  // (building or published) for that task.
  useEffect(() => {
    setSubmitting((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const key of prev) {
        const [repoName, taskName] = key.split("::");
        const repo = repos.find((r) => r.name === repoName);
        const conn = repo?.repoUrl ? connected.get(normUrl(repo.repoUrl)) : undefined;
        const t = tasks[repoName]?.find((x) => x.name === taskName);
        if (t && envStateFor(conn, t.baseCommit) !== "none") next.delete(key);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [connected, tasks, repos]);

  // Poll the connected list while any environment is building.
  const anyBuilding = useMemo(() => {
    if (submitting.size > 0) return true;
    for (const [repoName, list] of Object.entries(tasks)) {
      const repo = repos.find((r) => r.name === repoName);
      const conn = repo?.repoUrl ? connected.get(normUrl(repo.repoUrl)) : undefined;
      if (!conn) continue;
      for (const t of list) if (envStateFor(conn, t.baseCommit) === "building") return true;
    }
    return false;
  }, [submitting, tasks, repos, connected]);

  useEffect(() => {
    if (!anyBuilding) return;
    const id = setInterval(loadConnected, 10_000);
    return () => clearInterval(id);
  }, [anyBuilding, loadConnected]);

  // Poll my-tasks while any task is validating, so the step progress updates.
  const anyValidating = useMemo(() => {
    if (validating.size > 0) return true;
    for (const t of myTasks.values()) if (isValidating(t)) return true;
    return false;
  }, [validating, myTasks]);

  useEffect(() => {
    if (!anyValidating) return;
    const id = setInterval(loadMyTasks, 10_000);
    return () => clearInterval(id);
  }, [anyValidating, loadMyTasks]);

  const deleteTask = useCallback(
    async (repoName: string, task: TaskItem, myTask: MyTask) => {
      const key = `${repoName}::${task.name}`;
      if (!myTask?.id) {
        setEnvMsg((m) => ({ ...m, [key]: "Missing task id." }));
        return;
      }
      setDeleting((s) => new Set(s).add(key));
      setEnvMsg((m) => ({ ...m, [key]: "" }));
      try {
        const res = await fetch("/api/gold/delete-task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submissionId: myTask.id, token: manualToken }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Delete failed");
        setEnvMsg((m) => ({ ...m, [key]: "Deleted ✓" }));
        await loadMyTasks(); // task gone → row returns to Add environment
      } catch (e) {
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      } finally {
        setDeleting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [manualToken, loadMyTasks]
  );

  const toggleArchive = useCallback(
    async (scope: "repo" | "task", repoName: string, taskFolder: string | undefined, archived: boolean) => {
      try {
        const res = await fetch("/api/gold/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, repo: repoName, task: taskFolder, archived }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Archive failed");
        // loadRepos → repos change → the auto-expand effect re-reads task trees,
        // so archived flags refresh for both repo- and task-scope changes.
        loadRepos();
      } catch (e) {
        const key = taskFolder ? `${repoName}::${taskFolder}` : repoName;
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      }
    },
    [loadRepos]
  );

  // Refresh a single task's data from disk (used when unchecking "updating"),
  // updating only that task's row — not the whole repo.
  const refreshOneTask = useCallback(async (repoName: string, taskFolder: string) => {
    try {
      const res = await fetch(
        `/api/gold/task?repo=${encodeURIComponent(repoName)}&task=${encodeURIComponent(taskFolder)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!data.ok) return;
      setTasks((prev) => {
        const list = prev[repoName];
        if (!list) return prev;
        if (!data.task) {
          // Task no longer exists on disk → drop it from the row list.
          return { ...prev, [repoName]: list.filter((t) => t.name !== taskFolder) };
        }
        const exists = list.some((t) => t.name === taskFolder);
        const next = exists
          ? list.map((t) => (t.name === taskFolder ? (data.task as TaskItem) : t))
          : [...list, data.task as TaskItem];
        return { ...prev, [repoName]: next };
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Load persisted "updating" task keys once on mount.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pluto.gold.updating") || "[]");
      if (Array.isArray(saved)) setUpdating(new Set(saved as string[]));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleUpdating = useCallback(
    (key: string) => {
      const wasChecked = updating.has(key);
      setUpdating((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem("pluto.gold.updating", JSON.stringify([...next]));
        } catch {
          /* ignore quota */
        }
        return next;
      });
      // On uncheck → re-read only THIS task's data from disk (e.g. a changed
      // base_commit in task.toml.lines.txt); other tasks are left untouched.
      if (wasChecked) {
        const [repoName, taskFolder] = key.split("::");
        refreshOneTask(repoName, taskFolder);
      }
    },
    [updating, refreshOneTask]
  );

  const copyValue = useCallback(async (key: string, text: string) => {
    try {
      await copyText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      /* ignore */
    }
  }, []);

  const copyMessages = useCallback(
    (key: string, taskName: string, msgs: GoldMessage[]) =>
      copyValue(key, errorsToText(taskName, msgs)),
    [copyValue]
  );

  // Classify a task into one of the filter-board categories (matching its
  // primary action state). "other" = add-environment/connect/validated/etc.
  const categoryOf = useCallback(
    (r: RepoRow, t: TaskItem): string => {
      const key = `${r.name}::${t.name}`;
      if (updating.has(key)) return "updating";
      const conn = r.repoUrl ? connected.get(normUrl(r.repoUrl)) : undefined;
      const myTask = conn?.id ? myTasks.get(`${conn.id}::${t.taskName}`) : undefined;
      if (myTask) {
        if (myTask.status === "Needs Review") return "needs-review";
        if (isValidating(myTask)) return "validating";
        if (
          myTask.failedStage ||
          /fail/i.test(myTask.status || "") ||
          myTask.status === "Draft"
        )
          return "submit";
        return "other";
      }
      const envState = envStateFor(conn, t.baseCommit);
      if (envState === "building") return "building";
      if (envState === "published") return "new-task";
      if (envState === "none" && conn) return "add-env"; // connected, no env yet
      return "other";
    },
    [updating, connected, myTasks]
  );

  const archiveVisible = useCallback(
    (r: RepoRow, t: TaskItem) => (showArchived ? r.archived || t.archived : !t.archived),
    [showArchived]
  );

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of TASK_FILTERS) counts[f.key] = 0;
    for (const r of repos) {
      for (const t of tasks[r.name] || []) {
        if (!archiveVisible(r, t)) continue;
        const c = categoryOf(r, t);
        // "All" excludes needs-review (it has its own filter).
        if (c !== "needs-review") counts.all++;
        if (c in counts) counts[c]++;
      }
    }
    return counts;
  }, [repos, tasks, archiveVisible, categoryOf]);

  // A task passes the filter board when a category is selected and matches (OR),
  // or when nothing is selected ("All") — in which case "needs-review" tasks are
  // hidden and only appear under the explicit "Needs review" filter.
  const matchesFilter = useCallback(
    (r: RepoRow, t: TaskItem) => {
      const c = categoryOf(r, t);
      if (filters.size === 0) return c !== "needs-review";
      return filters.has(c);
    },
    [filters, categoryOf]
  );

  // Archived-view delete: archive the created task on AfterQuery (if any), then
  // remove the task folder from disk.
  const deleteArchivedTask = useCallback(
    async (repoName: string, task: TaskItem, myTask: MyTask | undefined) => {
      const key = `${repoName}::${task.name}`;
      setDeleting((s) => new Set(s).add(key));
      setEnvMsg((m) => ({ ...m, [key]: "" }));
      try {
        if (myTask?.id) {
          const r1 = await fetch("/api/gold/delete-task", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ submissionId: myTask.id, token: manualToken }),
          });
          const d1 = await r1.json();
          if (!d1.ok) throw new Error(d1.error || "Archive failed");
        }
        const r2 = await fetch("/api/gold/delete-task-dir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoName, task: task.name }),
        });
        const d2 = await r2.json();
        if (!d2.ok) throw new Error(d2.error || "Failed to remove task folder");
        loadRepos(); // folder gone → taskCount + task list refresh
        loadMyTasks();
      } catch (e) {
        setEnvMsg((m) => ({ ...m, [key]: (e as Error).message }));
      } finally {
        setDeleting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [manualToken, loadRepos, loadMyTasks]
  );

  const q = search.trim().toLowerCase();
  const filtered = repos.filter((r) => {
    // Unchecked → unarchived repos. Checked → archived repos OR unarchived repos
    // that contain at least one archived task (so per-task archives are visible).
    const matchesArchive = showArchived
      ? r.archived || (tasks[r.name] || []).some((t) => t.archived)
      : !r.archived;
    if (!matchesArchive) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    // Filter board: keep only repos that have a matching (and archive-visible) task.
    if (filters.size > 0) {
      const hasMatch = (tasks[r.name] || []).some(
        (t) => archiveVisible(r, t) && matchesFilter(r, t)
      );
      if (!hasMatch) return false;
    }
    return true;
  });

  return (
    <div>
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-amber-300">Gold — Repos</h2>
        {dir && (
          <p className="mt-1 text-xs text-neutral-500">
            Reading repos from <code>{dir}</code> · {connected.size} connected on AfterQuery
          </p>
        )}
      </header>

      <section className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repo…"
          className="min-w-[220px] flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
        />
        <button
          onClick={() => {
            loadRepos();
            loadConnected();
            loadMyTasks();
            setRefreshedAt(Date.now());
          }}
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Reload
        </button>
        <label className="flex items-center gap-1.5 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-3.5 w-3.5 accent-amber-600"
          />
          Show archived
        </label>
        {refreshedAt > 0 && (
          <span className="text-xs text-neutral-500">
            refreshed at {new Date(refreshedAt).toLocaleTimeString()}
          </span>
        )}
      </section>

      {/* Filter board (multi-select; "All" = none selected) */}
      <section className="mb-4 flex flex-wrap items-center gap-1.5">
        {TASK_FILTERS.map((f) => {
          const active = f.key === "all" ? filters.size === 0 : filters.has(f.key);
          return (
            <button
              key={f.key}
              onClick={() =>
                f.key === "all"
                  ? setFilters(new Set())
                  : setFilters((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.key)) next.delete(f.key);
                      else next.add(f.key);
                      return next;
                    })
              }
              className={`rounded-full border px-3 py-1 text-xs ${
                active
                  ? "border-amber-600 bg-amber-600/20 text-amber-200"
                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {f.label}
              <span className="ml-1.5 text-neutral-500">{filterCounts[f.key] ?? 0}</span>
            </button>
          );
        })}
      </section>

      {err && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}
      {connectedErr && (
        <div className="mb-4 rounded border border-amber-800 bg-amber-950 px-3 py-2 text-xs text-amber-300">
          Couldn&apos;t load connected repos: {connectedErr} (Connect state may be stale — needs a
          Gold-authorized token.)
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-3 py-2">Repo / Task</th>
              <th className="px-3 py-2">Tasks</th>
              <th className="px-3 py-2">STATUS.md</th>
              <th className="px-3 py-2">Modified</th>
              <th className="px-3 py-2">Updating</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Msgs</th>
              <th className="px-3 py-2">Go</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  {repos.length === 0 ? "No repos in result/." : "No repos match."}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const conn = r.repoUrl ? connected.get(normUrl(r.repoUrl)) : undefined;
                const isConnected = Boolean(conn);
                const isOpen = expanded.has(r.name);
                const canExpand = r.taskCount > 0;
                const state: ConnectState = r.repoUrl
                  ? connectState[r.repoUrl] ?? "idle"
                  : "idle";
                const needsReview = (tasks[r.name] || []).filter(
                  (t) => categoryOf(r, t) === "needs-review"
                ).length;
                return (
                  <Fragment key={r.name}>
                    <tr
                      onClick={() => canExpand && toggleExpand(r.name)}
                      className={`border-b border-neutral-900 align-top hover:bg-neutral-900/50 ${
                        canExpand ? "cursor-pointer" : ""
                      } ${r.archived ? "opacity-50" : ""}`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-1.5">
                          <span
                            className="mt-0.5 w-4 shrink-0 text-neutral-500"
                            aria-hidden="true"
                          >
                            {canExpand ? (isOpen ? "▾" : "▸") : ""}
                          </span>
                          <div>
                            <span className="font-medium text-neutral-200">📁 {r.name}</span>
                            {r.repoUrl && (
                              <a
                                href={r.repoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={`Open GitHub repo: ${r.repoUrl}`}
                                className="ml-2 text-neutral-500 hover:text-neutral-200"
                              >
                                ↗
                              </a>
                            )}
                            {needsReview > 0 && (
                              <span
                                className="ml-2 whitespace-nowrap"
                                title={`${needsReview} task(s) need review`}
                              >
                                {needsReview > 5 ? (
                                  <span className="text-xs font-medium text-emerald-500">5+</span>
                                ) : (
                                  Array.from({ length: needsReview }).map((_, i) => (
                                    <span key={i} className="text-emerald-500">
                                      ●
                                    </span>
                                  ))
                                )}
                              </span>
                            )}
                            {r.repository && (
                              <div className="pl-5 text-xs text-neutral-500">{r.repository}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-400">{r.taskCount || "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.hasStatus ? (
                          <span className="text-emerald-400">✓</span>
                        ) : (
                          <span className="text-neutral-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-400">{fmtDate(r.modifiedMs)}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col items-start gap-1">
                          {!r.repoUrl ? (
                            <span className="text-xs text-neutral-600">no repo_url</span>
                          ) : isConnected ? (
                            <span className="text-xs text-emerald-400">✓ connected</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <button
                                onClick={() => connect(r.repoUrl!)}
                                disabled={state === "connecting"}
                                title={r.repoUrl}
                                className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {state === "connecting" ? "Connecting…" : "Connect repo"}
                              </button>
                              {state === "error" && connectMsg[r.repoUrl] && (
                                <span className="max-w-[220px] break-words text-[10px] text-red-400">
                                  {connectMsg[r.repoUrl]}
                                </span>
                              )}
                            </div>
                          )}
                          {(!showArchived || r.archived) && (
                            <button
                              onClick={() =>
                                r.archived
                                  ? toggleArchive("repo", r.name, undefined, false)
                                  : setConfirmState({
                                      title: "Archive repo",
                                      message: `Archive "${r.name}" and all its tasks? It will be hidden from the list. You can unarchive it later via "Show archived".`,
                                      confirmLabel: "Archive",
                                      onConfirm: () => toggleArchive("repo", r.name, undefined, true),
                                    })
                              }
                              title={
                                r.archived
                                  ? "Restore this repo"
                                  : "Archive this repo and all its tasks"
                              }
                              className="text-[10px] text-neutral-500 hover:text-neutral-200"
                            >
                              {r.archived ? "↩ Unarchive repo" : "🗄 Archive repo"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            loadTasks(r.name);
                            loadMyTasks();
                          }}
                          disabled={tasksLoading[r.name]}
                          title="Refresh this repo's tasks from disk"
                          className={`inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 ${
                            tasksLoading[r.name] ? "animate-spin" : ""
                          }`}
                        >
                          ↻
                        </button>
                      </td>
                    </tr>

                    {isOpen &&
                      (tasksLoading[r.name] ? (
                        <tr className="border-b border-neutral-900 bg-neutral-950/40">
                          <td colSpan={8} className="px-3 py-2 pl-10 text-xs text-neutral-500">
                            Loading tasks…
                          </td>
                        </tr>
                      ) : tasksErr[r.name] ? (
                        <tr className="border-b border-neutral-900 bg-neutral-950/40">
                          <td colSpan={8} className="px-3 py-2 pl-10 text-xs text-red-400">
                            {tasksErr[r.name]}
                          </td>
                        </tr>
                      ) : (tasks[r.name] || []).filter(
                          (t) => archiveVisible(r, t) && matchesFilter(r, t)
                        ).length === 0 ? (
                        <tr className="border-b border-neutral-900 bg-neutral-950/40">
                          <td colSpan={8} className="px-3 py-2 pl-10 text-xs text-neutral-500">
                            {filters.size > 0
                              ? "No tasks match this filter."
                              : showArchived
                              ? "No archived tasks."
                              : "No tasks."}
                          </td>
                        </tr>
                      ) : (
                        (tasks[r.name] || [])
                          .filter((t) => archiveVisible(r, t) && matchesFilter(r, t))
                          .map((t) => {
                          const key = `${r.name}::${t.name}`;
                          const serverState = envStateFor(conn, t.baseCommit);
                          // Treat a just-submitted task as building until the
                          // server reflects it.
                          const envState: EnvState =
                            submitting.has(key) && serverState === "none"
                              ? "building"
                              : serverState;
                          const myTask = conn?.id
                            ? myTasks.get(`${conn.id}::${t.taskName}`)
                            : undefined;
                          // base_commit in task.toml.lines.txt changed after the
                          // task was created → offer to delete the stale task.
                          const baseChanged = Boolean(
                            myTask &&
                              t.baseCommit &&
                              myTask.baseSha &&
                              myTask.baseSha.toLowerCase() !== t.baseCommit.toLowerCase()
                          );
                          const errorMsgs = myTask
                            ? myTask.messages.filter((m) => m.level === "error")
                            : [];
                          return (
                            <tr
                              key={key}
                              className={`border-b border-neutral-900 bg-neutral-950/40 hover:bg-neutral-900/40 ${
                                t.archived ? "opacity-50" : ""
                              }`}
                            >
                              <td className="px-3 py-1.5">
                                <span className="whitespace-nowrap pl-6 text-neutral-300">
                                  <span className="text-neutral-600">└ </span>📄 {t.name}
                                  <button
                                    onClick={() => copyValue(`${key}:name`, t.name)}
                                    title="Copy task name"
                                    className="ml-1.5 text-neutral-500 hover:text-neutral-200"
                                  >
                                    {copiedKey === `${key}:name` ? "✓" : "⧉"}
                                  </button>
                                  {t.baseCommit && (
                                    <span className="ml-2 text-[10px] text-neutral-600">
                                      @{t.baseCommit.slice(0, 7)}
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-1.5"></td>
                              <td className="px-3 py-1.5">
                                {myTask && <PipelineProgress steps={myTask.steps} />}
                              </td>
                              <td className="px-3 py-1.5 text-xs text-neutral-500">
                                {fmtDate(t.modifiedMs)}
                              </td>
                              <td className="px-3 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={updating.has(key)}
                                  onChange={() => toggleUpdating(key)}
                                  title="Mark this task as updating (disables its action buttons)"
                                  className="h-4 w-4 accent-amber-600"
                                />
                              </td>
                              <td className="px-3 py-1.5">
                                <div
                                  className={`flex flex-col items-start gap-1.5 ${
                                    updating.has(key) ? "pointer-events-none opacity-40" : ""
                                  }`}
                                >
                                {!isConnected ? (
                                  <span className="text-[10px] text-neutral-600">
                                    connect repo first
                                  </span>
                                ) : (
                                  <div className="flex flex-col gap-1">
                                    {myTask ? (
                                      baseChanged ? (
                                        <div className="flex max-w-[260px] flex-col gap-1">
                                          {deleting.has(key) ? (
                                            <button
                                              disabled
                                              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-300"
                                            >
                                              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-red-400" />
                                              Deleting…
                                            </button>
                                          ) : (
                                            <button
                                              onClick={() =>
                                                setConfirmState({
                                                  title: "Delete task",
                                                  message: `Delete task "${t.name}"? This archives the created task on AfterQuery so you can rebuild it for the new base_commit.`,
                                                  confirmLabel: "Delete",
                                                  danger: true,
                                                  onConfirm: () => deleteTask(r.name, t, myTask),
                                                })
                                              }
                                              className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
                                            >
                                              Delete
                                            </button>
                                          )}
                                          <span className="text-[10px] leading-snug text-amber-400">
                                            base_commit changed:{" "}
                                            <span className="text-neutral-400">
                                              {myTask.baseSha?.slice(0, 7)} → {t.baseCommit?.slice(0, 7)}
                                            </span>
                                            . This task was created and its environment built against
                                            the old commit, so it no longer matches. Delete it, then
                                            re-run Add environment → New task for the new base_commit.
                                          </span>
                                        </div>
                                      ) : validating.has(key) || isValidating(myTask) ? (
                                        <button
                                          disabled
                                          title="Validating…"
                                          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-300"
                                        >
                                          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-violet-400" />
                                          Validating…
                                        </button>
                                      ) : myTask.failedStage || /fail/i.test(myTask.status || "") ? (
                                        showArchived ? null : (
                                          <button
                                            onClick={() => submitForValidation(r.name, conn, t, myTask)}
                                            title="Validation failed — save files + submit again"
                                            className="rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500"
                                          >
                                            Submit for validation
                                          </button>
                                        )
                                      ) : myTask.status && myTask.status !== "Draft" ? (
                                        <span className="text-xs font-medium text-emerald-400">
                                          {myTask.status}
                                        </span>
                                      ) : showArchived ? (
                                        <span className="text-xs text-neutral-500">
                                          {myTask.status || "Draft"}
                                        </span>
                                      ) : (
                                        <button
                                          onClick={() => submitForValidation(r.name, conn, t, myTask)}
                                          title="Save files + submit for validation"
                                          className="rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500"
                                        >
                                          Submit for validation
                                        </button>
                                      )
                                    ) : creating.has(key) ? (
                                      <button
                                        disabled
                                        title="Creating task…"
                                        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-300"
                                      >
                                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-emerald-400" />
                                        Creating…
                                      </button>
                                    ) : envState === "published" ? (
                                      <button
                                        onClick={() => newTask(r.name, conn, t)}
                                        title="Environment published for this base_commit"
                                        className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                                      >
                                        New task
                                      </button>
                                    ) : envState === "building" ? (
                                      <button
                                        disabled
                                        title="Building environment…"
                                        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-300"
                                      >
                                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-sky-400" />
                                        Building…
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => addEnvironment(r.name, conn?.id, t)}
                                        disabled={!t.baseCommit}
                                        title={t.baseCommit ? "Build environment for this base_commit" : "No base_commit found"}
                                        className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        Add environment
                                      </button>
                                    )}
                                    {envMsg[key] && (
                                      <span className="max-w-[240px] break-words text-[10px] text-neutral-400">
                                        {envMsg[key]}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {showArchived &&
                                  (deleting.has(key) ? (
                                    <span className="inline-flex items-center gap-1.5 text-[10px] text-neutral-400">
                                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-red-400" />
                                      Deleting…
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() =>
                                        setConfirmState({
                                          title: "Delete task permanently",
                                          message: `Permanently delete "${t.name}"? This archives the task on AfterQuery (if it was created) and removes its folder from disk. This cannot be undone.`,
                                          confirmLabel: "Delete",
                                          danger: true,
                                          onConfirm: () => deleteArchivedTask(r.name, t, myTask),
                                        })
                                      }
                                      className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
                                    >
                                      🗑 Delete
                                    </button>
                                  ))}
                                <button
                                  onClick={() =>
                                    t.archived
                                      ? toggleArchive("task", r.name, t.name, false)
                                      : setConfirmState({
                                          title: "Archive task",
                                          message: `Archive task "${t.name}"? It will be hidden from the list. You can unarchive it later via "Show archived".`,
                                          confirmLabel: "Archive",
                                          onConfirm: () => toggleArchive("task", r.name, t.name, true),
                                        })
                                  }
                                  title={t.archived ? "Restore this task" : "Archive this task"}
                                  className="text-[10px] text-neutral-500 hover:text-neutral-200"
                                >
                                  {t.archived ? "↩ Unarchive" : "🗄 Archive"}
                                </button>
                                </div>
                              </td>
                              <td className="px-3 py-1.5">
                                {myTask && errorMsgs.length > 0 ? (
                                  <div className="group relative inline-block">
                                    <button
                                      onClick={() => copyMessages(key, t.name, myTask.messages)}
                                      title="Copy error messages"
                                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 text-red-300 hover:bg-neutral-800"
                                    >
                                      {copiedKey === key ? "✓" : "⚠"}
                                    </button>
                                    <div className="pointer-events-none absolute right-0 top-7 z-50 hidden max-h-[280px] w-[340px] overflow-auto rounded border border-neutral-700 bg-neutral-950 p-2 text-left shadow-xl group-hover:block">
                                      {errorMsgs.map((m, i) => (
                                        <div key={i} className="mb-1.5 last:mb-0 text-[10px] leading-snug">
                                          <span className="text-red-400">[{m.scope}]</span>
                                          <span className="text-neutral-300"> — {m.message}</span>
                                          {m.path && (
                                            <span className="text-neutral-600"> ({m.path})</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-neutral-700">—</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5">
                                {myTask?.id ? (
                                  <a
                                    href={taskUrl(myTask.id)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Open this task on AfterQuery"
                                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white"
                                  >
                                    ↗
                                  </a>
                                ) : (
                                  <span className="text-neutral-700">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-neutral-600">
        {filtered.length} of {repos.length} repo{repos.length === 1 ? "" : "s"} ·{" "}
        auth: {manualToken.trim() ? "manual token present" : "using extension / refresh token"}
      </p>

      {confirmState && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirmState(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-neutral-100">{confirmState.title}</h3>
            <p className="mt-2 text-xs leading-relaxed text-neutral-400">{confirmState.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmState(null)}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const fn = confirmState.onConfirm;
                  setConfirmState(null);
                  fn();
                }}
                className={`rounded px-3 py-1.5 text-xs font-medium text-white ${
                  confirmState.danger
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-amber-600 hover:bg-amber-500"
                }`}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
