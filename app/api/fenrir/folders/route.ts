import { NextResponse } from "next/server";
import { getFenrirDirs } from "@/lib/fenrirLocal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The configured work folders (one tab each). Dir included for display. */
export async function POST() {
  const folders = getFenrirDirs().map((f) => ({ key: f.key, label: f.label, dir: f.dir }));
  return NextResponse.json({ ok: true, folders });
}
