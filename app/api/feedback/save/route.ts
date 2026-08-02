import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getTaskZipDir } from "@/lib/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where feedback JSONs land. Default: <task_zip>/ (alongside the zips). */
function getFeedbackDir(): string {
  const fromEnv = process.env.FEEDBACK_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return getTaskZipDir();
}

export async function POST(req: NextRequest) {
  let body: { fileName?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.fileName || typeof body.fileName !== "string") {
    return NextResponse.json({ ok: false, error: "fileName required." }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ ok: false, error: "content required." }, { status: 400 });
  }

  const dir = getFeedbackDir();
  // Build basename: strip .zip extension, force .json.
  const safeIn = path.basename(body.fileName);
  if (safeIn !== body.fileName) {
    return NextResponse.json({ ok: false, error: "Invalid fileName." }, { status: 400 });
  }
  const outName = safeIn.replace(/\.zip$/i, "") + ".json";
  const full = path.join(dir, outName);
  if (path.dirname(full) !== path.resolve(dir)) {
    return NextResponse.json({ ok: false, error: "Path outside feedback dir." }, { status: 400 });
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(full, body.content, "utf8");
    return NextResponse.json({ ok: true, path: full });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
