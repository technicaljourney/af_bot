import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getSilverTaskDir } from "@/lib/silverDir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Writes a Silver feedback JSON to `<silverDir>/<taskName>.feedback.json`.
 *
 *  The `.feedback.json` suffix keeps it distinct from `<taskName>.json`,
 *  which is the USER's task-metadata / "ready to submit" marker — feedback
 *  must never overwrite it. The feedback file's presence is the "already
 *  handled — don't re-submit" guard; the user deletes it to allow a retry. */
export async function POST(req: NextRequest) {
  let body: { taskName?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.taskName || typeof body.taskName !== "string") {
    return NextResponse.json({ ok: false, error: "taskName required." }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ ok: false, error: "content required." }, { status: 400 });
  }
  const dir = getSilverTaskDir();
  // Keep the file name to a safe basename within the silver dir.
  const base = path.basename(body.taskName).replace(/\.zip$/i, "");
  if (!base || base.startsWith(".") || base !== body.taskName.replace(/\.zip$/i, "")) {
    return NextResponse.json({ ok: false, error: "Invalid taskName." }, { status: 400 });
  }
  const full = path.join(dir, `${base}.feedback.json`);
  if (path.dirname(full) !== path.resolve(dir)) {
    return NextResponse.json({ ok: false, error: "Path outside silver dir." }, { status: 400 });
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(full, body.content, "utf8");
    return NextResponse.json({ ok: true, path: full });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
