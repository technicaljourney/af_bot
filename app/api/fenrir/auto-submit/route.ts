import { NextRequest, NextResponse } from "next/server";
import { submitUrl, listSubmissions, FenrirError } from "@/lib/fenrir";
import { getStoredToken } from "@/lib/authStore";
import { recordSubmitted, forgetSubmitted } from "@/lib/autoSubmitLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Submit one repo for fuzzing AND record it in the durable auto-submit ledger,
 * so it is never sent twice — not even after you delete it from AfterQuery.
 *
 * Modes:
 *   {repoUrl, ref}                  → submit, then record
 *   {repoUrl, ref, markOnly:true}   → record WITHOUT submitting (used for repos
 *                                     already on the account, so deleting them
 *                                     later doesn't make them look new again)
 *   {forget:[repoUrl,…]}            → drop records, allowing a resubmission
 */
export async function POST(req: NextRequest) {
  let body: {
    token?: string;
    repoUrl?: string;
    ref?: string;
    intakeChoice?: string;
    markOnly?: boolean;
    via?: "auto-submit" | "already-on-server" | "manual";
    forget?: string[];
    seedFromAccount?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (Array.isArray(body.forget) && body.forget.length) {
    const removed = await forgetSubmitted(body.forget);
    return NextResponse.json({ ok: true, forgotten: removed });
  }

  // One-shot backfill: record every repo currently on the account, so an empty
  // ledger doesn't treat long-standing repos as brand new. It cannot recover
  // repos already deleted before the ledger existed — those must be added by
  // hand (or left to be submitted once more).
  if (body.seedFromAccount) {
    const token = (body.token && body.token.trim()) || getStoredToken();
    if (!token) {
      return NextResponse.json({ ok: false, error: "No auth token." }, { status: 400 });
    }
    try {
      const subs = await listSubmissions(token);
      let seeded = 0;
      for (const s of subs) {
        if (!s.repoUrl) continue;
        await recordSubmitted(s.repoUrl, { submissionId: s.id, via: "already-on-server" });
        seeded++;
      }
      return NextResponse.json({ ok: true, seeded, scanned: subs.length });
    } catch (e) {
      const msg = e instanceof FenrirError ? e.message : (e as Error).message;
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
  }

  if (!body.repoUrl?.trim()) {
    return NextResponse.json({ ok: false, error: "repoUrl required." }, { status: 400 });
  }

  // Record-only: the repo is already on the account, so remember it rather than
  // re-submitting. This is what stops a later deletion resurrecting it.
  if (body.markOnly) {
    const entry = await recordSubmitted(body.repoUrl, {
      ref: body.ref,
      via: body.via || "already-on-server",
    });
    return NextResponse.json({ ok: true, recorded: true, entry });
  }

  const token = (body.token && body.token.trim()) || getStoredToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No auth token. Connect the extension or paste one." },
      { status: 400 }
    );
  }

  try {
    const result = await submitUrl(token, {
      repoUrl: body.repoUrl,
      ref: body.ref,
      intakeChoice: body.intakeChoice || "submit_poc",
    });
    // Record BEFORE returning so a crash between here and the client can never
    // leave a submitted repo unrecorded (which would resubmit it next poll).
    const entry = await recordSubmitted(body.repoUrl, {
      ref: body.ref,
      submissionId: result?.submission?.id,
      via: "auto-submit",
    });
    return NextResponse.json({ ok: true, ...result, entry });
  } catch (e) {
    if (e instanceof FenrirError) {
      // The account already has it — that IS "submitted"; record so we stop
      // retrying it every poll.
      if (/already|duplicate|exists/i.test(e.message)) {
        await recordSubmitted(body.repoUrl, { ref: body.ref, via: "already-on-server" });
        return NextResponse.json({ ok: true, duplicate: true, recorded: true });
      }
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status, detail: e.detail },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
