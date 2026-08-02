import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getSilverTaskDir } from "@/lib/silverDir";
import { feedbackJsonPath } from "@/lib/silverTaskMeta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LOCAL-ONLY: remove a task folder under `<silverDir>/<taskName>/`, plus its
 * sibling `<taskName>.feedback.json` if present (a stale feedback file would
 * silently block a future resubmit if the folder is recreated).
 *
 * This touches NOTHING on AfterQuery — drafts/submissions stay untouched
 * (that's /api/silver/draft-delete). Called by the per-row Delete button in
 * the Silver UI; the auto-handler never calls it.
 *
 * Strict safety: the resolved path must be an immediate child of the
 * silver dir (no traversal) and must itself be a directory (never deletes
 * top-level files like `repos.json`).
 */
export async function POST(req: NextRequest) {
  let body: { fileName?: string; taskName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const raw = (body.taskName || body.fileName || "").trim();
  if (!raw) {
    return NextResponse.json(
      { ok: false, error: "taskName (or fileName) required." },
      { status: 400 }
    );
  }
  // Strip a legacy ".zip" suffix from stored UI state.
  const name = raw.replace(/\.zip$/i, "");
  const safe = path.basename(name);
  if (safe !== name || !safe || safe.startsWith(".")) {
    return NextResponse.json({ ok: false, error: "Invalid taskName." }, { status: 400 });
  }
  const dir = getSilverTaskDir();
  const full = path.join(dir, safe);
  if (path.dirname(full) !== path.resolve(dir)) {
    return NextResponse.json({ ok: false, error: "Path outside silver dir." }, { status: 400 });
  }
  try {
    const st = await fs.stat(full);
    if (!st.isDirectory()) {
      return NextResponse.json(
        { ok: false, error: `Refusing to delete non-directory: ${safe}` },
        { status: 400 }
      );
    }
    await fs.rm(full, { recursive: true, force: false });
    let removedFeedback = false;
    try {
      await fs.rm(feedbackJsonPath(safe));
      removedFeedback = true;
    } catch {
      /* no feedback file — fine */
    }
    return NextResponse.json({ ok: true, removed: safe, removedFeedback });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: true, alreadyMissing: true });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
