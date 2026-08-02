import { NextRequest, NextResponse } from "next/server";
import { recordSubmit } from "@/lib/silverStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * URL-triggered submit: opening
 *
 *   http://localhost:3137/silver-task/<taskName>
 *
 * in a browser submits that task immediately and shows the result as a
 * small HTML page.
 *
 * It forwards to the same internal /api/silver/submit the UI button uses,
 * so every guard still applies: feedback-file skip, duplicate-draft skip,
 * task.toml presence/status checks, scaffold-only upload, metadata
 * validation. Auth comes from the extension-fed server token store — keep
 * the extension connected (or paste a token in the UI) before using this.
 *
 * On success the submit is counted in the local task-stats.json (deduped
 * by submissionId, same as UI-driven submits).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { taskName: string } }
) {
  const taskName = decodeURIComponent(params.taskName || "").trim();
  if (!taskName) {
    return htmlPage(400, "❌", "No task name", "Use /silver-task/&lt;taskName&gt;.");
  }

  let result: Record<string, unknown>;
  try {
    const r = await fetch(new URL("/api/silver/submit", req.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskName }),
      cache: "no-store",
    });
    result = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    return htmlPage(
      502,
      "❌",
      `Submission FAILED: ${esc(taskName)}`,
      esc((e as Error).message)
    );
  }

  if (!result.ok) {
    return htmlPage(
      502,
      "❌",
      `Submission FAILED: ${esc(taskName)}`,
      `${result.step ? `<b>Step:</b> ${esc(String(result.step))}<br>` : ""}${esc(
        String(result.error || "Unknown error.")
      )}`
    );
  }
  if (result.skipped) {
    // A skip means the task was NOT submitted — most commonly because it
    // was already submitted (duplicate draft / feedback file). For curl
    // and scripting this is a hard failure: HTTP 409 + error text.
    return htmlPage(
      409,
      "❌",
      `Submission FAILED: ${esc(taskName)}`,
      `<b>Error:</b> ${esc(
        String(result.message || `Already handled (${result.reason || "guard"}).`)
      )}`
    );
  }

  const submissionId = typeof result.submissionId === "string" ? result.submissionId : "";
  if (submissionId) await recordSubmit(taskName, submissionId);

  return htmlPage(
    200,
    "✅",
    `Submission SUCCESS: ${esc(taskName)}`,
    `<b>Draft:</b> ${esc(String(result.draftId ?? "?"))}<br>` +
      `<b>Submission:</b> ${esc(submissionId || "?")}<br>` +
      `${esc(String(result.fileCount ?? "?"))} files uploaded.`
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(
  status: number,
  emoji: string,
  title: string,
  detailHtml: string
): NextResponse {
  const body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { background: #0a0a0a; color: #d4d4d4; font-family: ui-monospace, monospace;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #171717; border: 1px solid #262626; border-radius: 12px;
          padding: 28px 32px; max-width: 560px; }
  h1 { font-size: 18px; margin: 0 0 12px; color: #fafafa; }
  p  { font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
  a  { color: #38bdf8; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${emoji} ${title}</h1>
    <p>${detailHtml}</p>
    <a href="/">← back to the app</a>
  </div>
</body>
</html>`;
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
