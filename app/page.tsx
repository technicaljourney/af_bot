"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Submissions from "@/components/Submissions";
import Rewrite from "@/components/Rewrite";
import Silver from "@/components/Silver";
import Fenrir from "@/components/Fenrir";
import Gold from "@/components/Gold";

interface TaskRow {
  fileName: string;
  taskName: string;
  domain: string;
  language: string;
  status: string;
  group: string;
  sizeBytes: number;
  createdMs: number;
  matched: boolean;
}

type RowState = "idle" | "running" | "success" | "error";

interface RowResult {
  state: RowState;
  message?: string;
  submissionId?: string;
  step?: string;
  detail?: unknown;
}

const TOKEN_KEY = "pluto.afterquery.token";
const LANG_KEY = "pluto.afterquery.language";
const DOMAINS_KEY = "pluto.afterquery.domains";

// AfterQuery's "Domain" is a fixed category dropdown — the create-submission API
// requires one of these exact strings. Extend this list with the rest of the
// options from the AfterQuery dropdown.
const DOMAIN_CATEGORIES = [
  "ML / DL / AI",
  "Scientific Computing & Numerics",
  "Graphics, Image & Video",
  "Cybersecurity",
  "Games (bots & solvers)",
  "Compilers, Parsers & Language Internals",
];

const LANGUAGES = [
  "Python",
  "Go",
  "Rust",
  "C",
  "C++",
  "JavaScript",
  "TypeScript",
  "Java",
  "Shell/Bash",
  "Other",
];

/** Clean a pasted token: drop a header name, "Bearer", quotes, and all whitespace. */
function cleanToken(raw: string): string {
  return raw
    .trim()
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, "");
}

function decodeJwt(
  token: string
): { exp?: number; iat?: number; email?: string; name?: string } | null {
  try {
    const t = cleanToken(token);
    const parts = t.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "="; // restore base64url padding
    const bin = atob(b64);
    // Decode as UTF-8 so non-ASCII names/emails don't break JSON.parse.
    let jsonStr: string;
    try {
      jsonStr = decodeURIComponent(
        Array.from(bin)
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
      );
    } catch {
      jsonStr = bin;
    }
    const json = JSON.parse(jsonStr);
    return { exp: json.exp, iat: json.iat, email: json.email, name: json.name };
  } catch {
    return null;
  }
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  return `${(bytes / 1024).toFixed(1)} KB`;
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

function statusBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("succeed")) return "bg-emerald-900 text-emerald-200";
  if (s.includes("fail")) return "bg-red-900 text-red-200";
  // "needs review" / "needs-revision" → red; "Review Ready" / "Ready for Review" → blue.
  if (s.includes("revision") || s.includes("needs")) return "bg-red-900 text-red-200";
  if (s.includes("ready") || s.includes("review")) return "bg-sky-900 text-sky-200";
  if (s.includes("pending")) return "bg-sky-900 text-sky-200";
  return "bg-neutral-800 text-neutral-400";
}

export default function Home() {
  const [token, setToken] = useState("");
  const [language, setLanguage] = useState("Python");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [dir, setDir] = useState("");
  const [mdFound, setMdFound] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [domains, setDomains] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [batchRunning, setBatchRunning] = useState(false);
  const [now, setNow] = useState(Date.now());

  interface AuthStatus {
    hasToken: boolean;
    exp: number | null;
    email: string | null;
    source: string | null;
    expired: boolean;
    hasRefreshToken?: boolean;
    refreshError?: string | null;
  }
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showRefresh, setShowRefresh] = useState(false);
  const [rtInput, setRtInput] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [rtBusy, setRtBusy] = useState(false);
  const [rtMsg, setRtMsg] = useState("");
  const [authCheckedAt, setAuthCheckedAt] = useState(0);
  const [authRefreshing, setAuthRefreshing] = useState(false);
  const [view, setView] = useState<
    "tasks" | "submissions" | "rewrite" | "silver" | "fenrir" | "gold"
  >("gold");

  // Load persisted token + language.
  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY) || "");
    setLanguage(localStorage.getItem(LANG_KEY) || "Python");
    try {
      const saved = localStorage.getItem(DOMAINS_KEY);
      if (saved) setDomains(JSON.parse(saved));
    } catch {
      /* ignore corrupt persisted domains */
    }
  }, []);

  // Tick for the JWT countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Re-check the extension-provided token status (also callable from the button).
  const refreshAuth = useCallback(async () => {
    setAuthRefreshing(true);
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const data = await res.json();
      setAuthStatus(data);
      setAuthCheckedAt(Date.now());
    } catch {
      /* server may be reloading */
    } finally {
      setAuthRefreshing(false);
    }
  }, []);

  // Poll the token status on an interval.
  useEffect(() => {
    refreshAuth();
    const id = setInterval(refreshAuth, 4000);
    return () => clearInterval(id);
  }, [refreshAuth]);

  // Save a Firebase refresh token + API key; the server auto-mints ID tokens.
  const saveRefresh = useCallback(async () => {
    setRtBusy(true);
    setRtMsg("");
    try {
      const res = await fetch("/api/auth/refresh-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rtInput.trim(), apiKey: apiKeyInput.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save refresh token");
      // Drop any stale manually-pasted token — it would override the freshly
      // auto-minted one on every request and re-introduce the expiry problem.
      setToken("");
      localStorage.removeItem(TOKEN_KEY);
      setRtMsg("✓ Saved — auto-refreshing. Manual token cleared.");
      setRtInput("");
      await refreshAuth();
    } catch (e) {
      setRtMsg((e as Error).message);
    } finally {
      setRtBusy(false);
    }
  }, [rtInput, apiKeyInput, refreshAuth]);

  const clearRefresh = useCallback(async () => {
    setRtBusy(true);
    setRtMsg("");
    try {
      await fetch("/api/auth/refresh-token", { method: "DELETE" });
      setRtMsg("Refresh token cleared.");
      await refreshAuth();
    } catch (e) {
      setRtMsg((e as Error).message);
    } finally {
      setRtBusy(false);
    }
  }, [refreshAuth]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to load tasks");
      setTasks(data.tasks);
      setDir(data.dir);
      setMdFound(data.mdFound);
      // Domain is a category the user picks per task; persisted in localStorage,
      // not derived from the submission.md description (which is just a hint).
    } catch (e) {
      setLoadErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const jwt = useMemo(() => decodeJwt(token), [token]);
  const expInfo = useMemo(() => {
    if (!jwt?.exp) return null;
    const secsLeft = jwt.exp - Math.floor(now / 1000);
    return { secsLeft, expired: secsLeft <= 0 };
  }, [jwt, now]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.group) set.add(t.group);
    return Array.from(set);
  }, [tasks]);

  // Dropdown options = known categories ∪ every category present in submission.md,
  // so the list self-completes from the data instead of needing a hardcoded full set.
  const domainOptions = useMemo(() => {
    const set = new Set<string>(DOMAIN_CATEGORIES);
    for (const t of tasks) if (t.domain) set.add(t.domain);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (groupFilter !== "all" && t.group !== groupFilter) return false;
      if (statusFilter !== "all") {
        const s = t.status.toLowerCase();
        if (statusFilter === "unmatched" && t.matched) return false;
        if (statusFilter !== "unmatched" && !s.includes(statusFilter)) return false;
      }
      if (q) {
        const hay = `${t.taskName} ${t.fileName} ${t.domain}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, search, groupFilter, statusFilter]);

  // Tasks tab: show all zips, sorted by the trailing "_W_S" version suffix
  // (1_1, 1_2, …, 2_5). Tasks without a matching suffix sort to the end
  // alphabetically.
  const sorted = useMemo(() => {
    const suffixKey = (name: string): [number, number] | null => {
      const m = name.match(/[_-](\d+)_(\d+)$/);
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    return [...filtered].sort((a, b) => {
      const ka = suffixKey(a.taskName);
      const kb = suffixKey(b.taskName);
      if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1];
      if (ka) return -1;
      if (kb) return 1;
      return a.taskName.localeCompare(b.taskName);
    });
  }, [filtered]);

  const saveToken = (value: string) => {
    setToken(value);
    localStorage.setItem(TOKEN_KEY, value);
  };
  const saveLanguage = (value: string) => {
    setLanguage(value);
    localStorage.setItem(LANG_KEY, value);
  };

  const setDomain = (fileName: string, value: string) =>
    setDomains((prev) => {
      const next = { ...prev, [fileName]: value };
      try {
        localStorage.setItem(DOMAINS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota errors */
      }
      return next;
    });

  const setResult = (fileName: string, r: RowResult) =>
    setResults((prev) => ({ ...prev, [fileName]: r }));

  const submitOne = useCallback(
    async (task: TaskRow): Promise<boolean> => {
      const domain = (domains[task.fileName] ?? task.domain ?? "").trim();
      if (!token.trim() && !authStatus?.hasToken) {
        setResult(task.fileName, {
          state: "error",
          message: "No token — connect the extension or paste one.",
        });
        return false;
      }
      if (!domain) {
        setResult(task.fileName, { state: "error", message: "Select a domain category first." });
        return false;
      }
      setResult(task.fileName, { state: "running" });
      try {
        const res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: task.fileName,
            domain,
            token: cleanToken(token),
            language,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          setResult(task.fileName, {
            state: "error",
            message: data.error || "Submission failed",
            step: data.step,
            detail: data.detail,
          });
          return false;
        }
        setResult(task.fileName, {
          state: "success",
          submissionId: data.submissionId,
          message: data.harborSubmissionId
            ? `harbor: ${data.harborSubmissionId}`
            : undefined,
        });
        return true;
      } catch (e) {
        setResult(task.fileName, { state: "error", message: (e as Error).message });
        return false;
      }
    },
    [domains, token, language, authStatus]
  );

  const toggleSelect = (fileName: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });

  const selectAllFiltered = () =>
    setSelected(new Set(sorted.map((t) => t.fileName)));
  const clearSelection = () => setSelected(new Set());

  const submitSelected = useCallback(async () => {
    const queue = sorted.filter(
      (t) => selected.has(t.fileName) && results[t.fileName]?.state !== "success"
    );
    if (!queue.length) return;
    setBatchRunning(true);
    for (const task of queue) {
      // eslint-disable-next-line no-await-in-loop
      await submitOne(task);
    }
    setBatchRunning(false);
  }, [sorted, selected, results, submitOne]);

  const selectedCount = selected.size;
  const successCount = Object.values(results).filter((r) => r.state === "success").length;
  const errorCount = Object.values(results).filter((r) => r.state === "error").length;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Pluto Submissions</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Upload task zips to AfterQuery. Domain auto-fills from{" "}
          <code className="text-neutral-300">submission.md</code>; testing is skipped, version is{" "}
          <code className="text-neutral-300">Pluto v2</code>.
        </p>
        {dir && (
          <p className="mt-1 text-xs text-neutral-500">
            Reading zips from <code>{dir}</code>
            {!mdFound && " · submission.md not found (domains blank)"}
          </p>
        )}
      </header>

      {/* Auth + language bar */}
      <section className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium text-neutral-300">Authentication</label>
          <div className="flex items-center gap-2 text-xs">
            {token.trim() ? (
              // A manually pasted token overrides the extension.
              !jwt ? (
                <span className="text-amber-400">manual: not a recognizable JWT</span>
              ) : !jwt.exp ? (
                <span className="text-amber-400">manual: decoded, but no exp claim</span>
              ) : expInfo?.expired ? (
                <span className="text-red-400">manual token expired {fmtDate(jwt.exp * 1000)}</span>
              ) : (
                <span className="text-emerald-400">
                  manual · {jwt.email ? `${jwt.email} · ` : ""}
                  {Math.floor((expInfo?.secsLeft ?? 0) / 60)}m {(expInfo?.secsLeft ?? 0) % 60}s left
                </span>
              )
            ) : authStatus?.hasToken ? (
              <span className="text-emerald-400">
                ✓ via {authStatus.source || "extension"}
                {authStatus.email ? ` · ${authStatus.email}` : ""}
                {authStatus.exp
                  ? ` · ${Math.max(0, Math.floor((authStatus.exp - now / 1000) / 60))}m ${
                      Math.max(0, Math.floor(authStatus.exp - now / 1000)) % 60
                    }s left`
                  : ""}
              </span>
            ) : authStatus?.hasRefreshToken ? (
              <span className={authStatus.refreshError ? "text-red-400" : "text-amber-400"}>
                {authStatus.refreshError
                  ? `refresh-token error: ${authStatus.refreshError}`
                  : "minting token from refresh token…"}
              </span>
            ) : authStatus?.expired ? (
              <span className="text-red-400">
                extension token expired — open AfterQuery to let it refresh
              </span>
            ) : (
              <span className="text-amber-400">
                not connected — load the extension, or paste a token
              </span>
            )}
            <button
              onClick={refreshAuth}
              disabled={authRefreshing}
              title="Re-check the token now (forces an immediate status fetch)"
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {authRefreshing ? "checking…" : "↻ Refresh"}
            </button>
            {authCheckedAt > 0 && (
              <span className="text-neutral-600">
                {Math.max(0, Math.round((now - authCheckedAt) / 1000))}s ago
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-sm text-neutral-400">Language</label>
          <select
            value={language}
            onChange={(e) => saveLanguage(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowRefresh((s) => !s)}
              className={`rounded border px-3 py-1 text-xs hover:bg-neutral-800 ${
                authStatus?.hasRefreshToken
                  ? "border-emerald-700 text-emerald-300"
                  : "border-neutral-700 text-neutral-300"
              }`}
            >
              {authStatus?.hasRefreshToken
                ? "↻ Refresh token ✓"
                : showRefresh
                ? "Hide refresh token"
                : "Use refresh token"}
            </button>
            <button
              onClick={() => setShowManual((s) => !s)}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              {showManual ? "Hide manual token" : "Paste token manually"}
            </button>
          </div>
        </div>

        {showRefresh && (
          <div className="mt-3 space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3">
            <p className="text-xs text-neutral-400">
              Paste a Firebase <b>refresh token</b> + <b>Web API key</b> once. The server
              exchanges them for ID tokens and auto-refreshes — no extension or re-pasting.
              Stored locally on disk (treat like a password).
            </p>
            <input
              value={rtInput}
              onChange={(e) => setRtInput(e.target.value)}
              placeholder="Refresh token (IndexedDB firebaseLocalStorageDb → stsTokenManager.refreshToken)"
              spellCheck={false}
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 outline-none focus:border-sky-600"
            />
            <input
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Firebase Web API key (the ?key=AIza… on securetoken/identitytoolkit calls)"
              spellCheck={false}
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 outline-none focus:border-sky-600"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={saveRefresh}
                disabled={rtBusy || !rtInput.trim() || !apiKeyInput.trim()}
                className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {rtBusy ? "Saving…" : "Save & start auto-refresh"}
              </button>
              {authStatus?.hasRefreshToken && (
                <button
                  onClick={clearRefresh}
                  disabled={rtBusy}
                  className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
                >
                  Clear refresh token
                </button>
              )}
              {rtMsg && (
                <span
                  className={
                    rtMsg.startsWith("✓") ? "text-xs text-emerald-400" : "text-xs text-amber-400"
                  }
                >
                  {rtMsg}
                </span>
              )}
            </div>
            {authStatus?.refreshError && (
              <p className="text-xs text-red-400">refresh error: {authStatus.refreshError}</p>
            )}
          </div>
        )}

        {showManual && (
          <div className="mt-3">
            <textarea
              value={token}
              onChange={(e) => saveToken(e.target.value)}
              placeholder="Paste a Bearer token (overrides the extension)…"
              rows={2}
              spellCheck={false}
              className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 outline-none focus:border-sky-600"
            />
            <button
              onClick={() => saveToken("")}
              className="mt-2 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
            >
              Clear manual token
            </button>
          </div>
        )}

        <p className="mt-2 text-xs text-neutral-500">
          The browser extension (see <code>extension/</code>) forwards your AfterQuery token
          automatically and keeps it fresh. A pasted token overrides it. Tokens stay on your local
          machine.
        </p>
      </section>

      {/* View tabs */}
      <div className="mb-4 flex gap-1 border-b border-neutral-800 text-sm">
        {(["gold", "tasks", "submissions", "rewrite", "silver", "fenrir"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`-mb-px border-b-2 px-3 py-2 ${
              view === v
                ? "border-sky-500 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {v === "tasks"
              ? "Tasks (submit zips)"
              : v === "submissions"
              ? "Pluto Tasks"
              : v === "rewrite"
              ? "Rewrite"
              : v === "silver"
              ? "Silver"
              : v === "fenrir"
              ? "Fenrir"
              : "Gold"}
          </button>
        ))}
      </div>

      {view === "submissions" ? (
        <Submissions manualToken={token} />
      ) : view === "rewrite" ? (
        <Rewrite manualToken={token} />
      ) : view === "silver" ? (
        <Silver manualToken={token} />
      ) : view === "fenrir" ? (
        <Fenrir manualToken={token} />
      ) : view === "gold" ? (
        <Gold manualToken={token} />
      ) : (
      <>
      {/* Controls */}
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search task / domain…"
          className="min-w-[220px] flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-sky-600"
        />
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
        >
          <option value="all">All groups</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="pending">pending</option>
          <option value="succeed">succeeded</option>
          <option value="fail">failed</option>
          <option value="revision">needs-revision</option>
          <option value="unmatched">not in submission.md</option>
        </select>
        <button
          onClick={loadTasks}
          className="rounded border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Reload
        </button>
      </section>

      {/* Batch bar */}
      <section className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <button
          onClick={selectAllFiltered}
          className="rounded border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          Select all ({sorted.length})
        </button>
        <button
          onClick={clearSelection}
          className="rounded border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          Clear
        </button>
        <button
          onClick={submitSelected}
          disabled={batchRunning || selectedCount === 0}
          className="rounded bg-sky-600 px-4 py-1 font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {batchRunning ? "Submitting…" : `Submit selected (${selectedCount})`}
        </button>
        <select
          aria-label="Set domain for selected"
          value=""
          disabled={selectedCount === 0}
          onChange={(e) => {
            const v = e.target.value;
            if (v) selected.forEach((f) => setDomain(f, v));
            e.target.value = "";
          }}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 disabled:opacity-40"
        >
          <option value="">Set domain for selected…</option>
          {domainOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-neutral-500">
          {successCount > 0 && <span className="text-emerald-400">{successCount} done</span>}
          {successCount > 0 && errorCount > 0 && " · "}
          {errorCount > 0 && <span className="text-red-400">{errorCount} failed</span>}
        </span>
      </section>

      {loadErr && (
        <div className="mb-4 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {loadErr}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="w-8 px-3 py-2"></th>
              <th className="px-3 py-2">Task</th>
              <th className="px-3 py-2">Domain</th>
              <th className="px-3 py-2">MD status</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  Loading…
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  No tasks match.
                </td>
              </tr>
            ) : (
              sorted.map((task) => {
                const r = results[task.fileName];
                const domain = domains[task.fileName] ?? task.domain ?? "";
                return (
                  <tr
                    key={task.fileName}
                    className="border-b border-neutral-900 align-top hover:bg-neutral-900/50"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(task.fileName)}
                        onChange={() => toggleSelect(task.fileName)}
                        className="h-4 w-4 accent-sky-600"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-200">{task.taskName}</div>
                      <div className="text-xs text-neutral-500">
                        {task.fileName} · {fmtSize(task.sizeBytes)} · {fmtDate(task.createdMs)}
                        {task.group ? ` · ${task.group}` : ""}
                      </div>
                      {task.domain && (
                        <div className="mt-0.5 text-xs text-neutral-600" title={task.domain}>
                          ↳ {task.domain}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={domain}
                        onChange={(e) => setDomain(task.fileName, e.target.value)}
                        className={`w-full min-w-[220px] rounded border bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-sky-600 ${
                          domain
                            ? "border-neutral-800 text-neutral-200"
                            : "border-amber-800 text-neutral-500"
                        }`}
                      >
                        <option value="">Select a domain…</option>
                        {domainOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        {domain && !domainOptions.includes(domain) && (
                          <option value={domain}>{domain} (custom)</option>
                        )}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {task.status ? (
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${statusBadgeClass(
                            task.status
                          )}`}
                        >
                          {task.status}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => submitOne(task)}
                        disabled={r?.state === "running" || batchRunning}
                        className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {r?.state === "running" ? "…" : "Submit"}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {!r || r.state === "idle" ? (
                        <span className="text-neutral-600">—</span>
                      ) : r.state === "running" ? (
                        <span className="text-sky-400">uploading…</span>
                      ) : r.state === "success" ? (
                        <span className="text-emerald-400">
                          ✓ {r.submissionId ? `id ${r.submissionId}` : "submitted"}
                          {r.message ? <span className="text-neutral-500"> · {r.message}</span> : null}
                        </span>
                      ) : (
                        <div className="text-red-400">
                          ✗ {r.step ? `[${r.step}] ` : ""}
                          {r.message}
                          {r.detail ? (
                            <details className="mt-0.5">
                              <summary className="cursor-pointer text-neutral-500">why?</summary>
                              <pre className="mt-0.5 max-w-[420px] whitespace-pre-wrap break-all text-[10px] text-neutral-400">
                                {typeof r.detail === "string"
                                  ? r.detail
                                  : JSON.stringify(r.detail, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
    </main>
  );
}
