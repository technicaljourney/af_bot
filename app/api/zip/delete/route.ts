import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getTaskZipDir } from "@/lib/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { fileName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.fileName || typeof body.fileName !== "string") {
    return NextResponse.json({ ok: false, error: "fileName required." }, { status: 400 });
  }

  const dir = getTaskZipDir();
  const safe = path.basename(body.fileName);
  if (safe !== body.fileName || !safe.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ ok: false, error: "Invalid fileName." }, { status: 400 });
  }
  const full = path.join(dir, safe);
  if (path.dirname(full) !== path.resolve(dir)) {
    return NextResponse.json({ ok: false, error: "Path outside zip dir." }, { status: 400 });
  }

  try {
    await fs.unlink(full);
    return NextResponse.json({ ok: true, removed: safe });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: true, alreadyMissing: true });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
