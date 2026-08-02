import { NextRequest, NextResponse } from "next/server";
import { listLocalRepoNames, fenrirDirByKey } from "@/lib/fenrirLocal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Base repo names present in ONE work folder (the active tab). */
export async function POST(req: NextRequest) {
  let body: { folder?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const dir = fenrirDirByKey(body.folder);
  const names = await listLocalRepoNames(dir);
  return NextResponse.json({ ok: true, names, dir });
}
