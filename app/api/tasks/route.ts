import { NextResponse } from "next/server";
import { listTasks } from "@/lib/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { dir, tasks, mdFound } = await listTasks();
    return NextResponse.json({ ok: true, dir, mdFound, count: tasks.length, tasks });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
