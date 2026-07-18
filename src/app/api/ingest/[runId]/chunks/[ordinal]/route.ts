import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { processSegment, buildSplitChildren, shouldPresplit, EntryPoint } from "@/lib/ingestion";
import { validateEntryPointResult } from "@/lib/ingest-validate";
import { nextFault } from "@/lib/test-faults";

export const maxDuration = 60;
type Context = { params: Promise<{ runId: string; ordinal: string }> };

// Lease is just above the 60s function limit: a killed request's 'processing'
// claim becomes reclaimable ~5s after the limit, but a live worker (which
// finishes well under 60s) is never stolen.
const CLAIM_LEASE_SECONDS = 65;
// A chunk that has already been claimed once (and failed/timed out) is subdivided
// on its next claim instead of re-invoking the model, so a too-big/slow segment
// converges instead of looping.
const AUTO_SPLIT_AT_ATTEMPT = 2;
// ...but ONLY when the previous failure suggests the segment is too big. A
// transient provider error (429/5xx) says nothing about size: subdividing on it
// makes every chunk smaller and smaller until split_depth is exhausted and the
// whole import fails with "too small to subdivide further". Observed in
// acceptance testing — a provider blip destroyed a 110-item import. Transient
// failures retry the SAME segment up to this many attempts before falling back
// to subdivision.
const MAX_TRANSIENT_ATTEMPTS = 4;
const TRANSIENT_MARK = "[transient]";
// A permanent failure (out of credits, rejected key) cannot be fixed by retrying
// OR by subdividing — every child would fail identically. Fail fast instead of
// shredding the run.
const PERMANENT_MARK = "[permanent]";
const isTransientStatus = (s: number) => s === 429 || (s >= 500 && s <= 599);
const isPermanentStatus = (s: number) => s === 401 || s === 402 || s === 403;
function failureMark(status: number) {
  if (isPermanentStatus(status)) return PERMANENT_MARK;
  if (isTransientStatus(status)) return TRANSIENT_MARK;
  return "";
}

// POST /api/ingest/:runId/chunks/:ordinal — process one bounded chunk. The chunk
// is CLAIMED atomically (claim_chunk returns an attempt generation); stage/fail/
// split are bound to that generation, so a stale claimant can't act after the
// chunk was reclaimed by another attempt.
export async function POST(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId, ordinal: ordinalStr } = await context.params;
  const ordinal = Number(ordinalStr);

  const supabase = createServerClient();
  const { data: run } = await supabase
    .from("ingestion_runs")
    .select("id, user_id, packet_id, entry_point, status, source_text")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.user_id !== session.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (run.status !== "active") return NextResponse.json({ error: "run_not_active", status: run.status }, { status: 409 });

  const entryPoint = run.entry_point as EntryPoint;

  // Atomic claim — only ONE request proceeds for a given chunk generation.
  const { data: claim, error: claimErr } = await supabase.rpc("claim_chunk", {
    p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 400 });
  const c = claim as {
    claimed: boolean; status: string; attempt?: number; segment_text?: string; segment_hash?: string;
    section_hint?: string; source_start?: number; source_end?: number;
  };
  if (!c.claimed) return NextResponse.json({ status: c.status }); // completed / split / processing (another attempt)

  const attempt = c.attempt as number;
  const segmentText = c.segment_text as string;
  const sourceStart = c.source_start as number;
  const sourceEnd = c.source_end as number;

  async function doSplit() {
    if (sourceEnd - sourceStart <= 1) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_attempt: attempt, p_error: "segment too small to subdivide" });
      return NextResponse.json({ error: "cannot_subdivide", message: "A block is too large to process and can't be split further." }, { status: 422 });
    }
    const children = buildSplitChildren(run!.source_text as string, sourceStart, sourceEnd);
    if (children.length < 2) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_attempt: attempt, p_error: "no split boundary" });
      return NextResponse.json({ error: "cannot_subdivide" }, { status: 422 });
    }
    const { error } = await supabase.rpc("split_chunk", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_attempt: attempt, p_children: children });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ status: "split", added: children.length });
  }

  // An oversized segment is subdivided without spending a model call.
  if (shouldPresplit(segmentText)) return doSplit();
  // A retried segment is subdivided ONLY if its last failure was about size.
  // claim_chunk does not clear `error`, so the previous attempt's reason is still
  // readable here.
  if (attempt >= AUTO_SPLIT_AT_ATTEMPT) {
    const { data: prev } = await supabase
      .from("ingestion_chunks").select("error").eq("run_id", runId).eq("ordinal", ordinal).maybeSingle();
    const prevErr = String(prev?.error || "");
    if (prevErr.startsWith(PERMANENT_MARK)) {
      // Re-record the same permanent failure against this attempt and stop.
      await supabase.rpc("mark_chunk_failed", {
        p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_attempt: attempt, p_error: prevErr,
      });
      return NextResponse.json(
        { error: "chunk_failed", message: prevErr.slice(PERMANENT_MARK.length).trim(), permanent: true },
        { status: 402 },
      );
    }
    const wasTransient = prevErr.startsWith(TRANSIENT_MARK);
    if (!wasTransient || attempt > MAX_TRANSIENT_ATTEMPTS) return doSplit();
    // else: fall through and retry the same segment against the model.
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI service not configured" }, { status: 500 });

  const { data: packet } = await supabase.from("packets").select("packet_type").eq("id", run.packet_id).maybeSingle();
  const isLead = entryPoint === "organize" && sourceStart === 0;

  // Acceptance-test fault injection. Inert unless FLOWGUIDE_TEST_FAULT_FILE is
  // set outside production (see test-faults.ts). Injected results are fed through
  // the SAME validation path as a real model response, so a wrong shape is caught
  // by the real guard rather than by the hook.
  // Literal NODE_ENV comparison: the bundler inlines it, so this whole branch —
  // and every fault path below it — is dead code eliminated from the production
  // build. test-faults.ts re-checks NODE_ENV at runtime as a backstop.
  const fault = process.env.NODE_ENV === "production" ? null : nextFault(runId, ordinal, attempt);
  let outcome: Awaited<ReturnType<typeof processSegment>>;
  if (fault?.kind === "error") {
    outcome = { kind: "error", status: fault.status, message: fault.message };
  } else if (fault?.kind === "split") {
    outcome = { kind: "split" };
  } else if (fault?.kind === "wrongShape" || fault?.kind === "emptyResult") {
    const injected =
      fault.kind === "emptyResult"
        ? (entryPoint === "section_append" ? { items: [] } : { sections: [] })
        // Deliberately the OTHER entry point's shape.
        : (entryPoint === "section_append"
            ? { sections: [{ title: "Wrong", items: [{ title: "Nope" }] }] }
            : { items: [{ title: "Nope" }] });
    const valid = validateEntryPointResult(entryPoint, injected);
    outcome = valid.ok
      ? { kind: "ok", result: valid.result }
      : { kind: "error", status: 502, message: valid.message };
  } else {
    outcome = await processSegment({
      entryPoint,
      packetType: packet?.packet_type || "general",
      isLead,
      segmentText,
      sectionHint: (c.section_hint as string) || "",
      apiKey,
    });
  }

  if (outcome.kind === "split") return doSplit();
  if (outcome.kind === "error") {
    // Tag transient provider failures so the next attempt retries this segment
    // instead of subdividing it (see MAX_TRANSIENT_ATTEMPTS).
    const mark = failureMark(outcome.status);
    await supabase.rpc("mark_chunk_failed", {
      p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_attempt: attempt,
      p_error: (mark ? `${mark} ` : "") + outcome.message,
    });
    return NextResponse.json(
      { error: "chunk_failed", message: outcome.message, permanent: mark === PERMANENT_MARK },
      { status: outcome.status >= 400 ? outcome.status : 502 },
    );
  }

  const { error: stageErr } = await supabase.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_attempt: attempt, p_segment_hash: c.segment_hash, p_result: outcome.result,
  });
  if (stageErr) return NextResponse.json({ error: stageErr.message }, { status: 400 });

  if (isLead && (outcome.title || outcome.clientName)) {
    await supabase
      .from("ingestion_runs")
      .update({ derived_title: outcome.title || "", derived_client_name: outcome.clientName || "" })
      .eq("id", runId)
      .eq("derived_title", "");
  }

  return NextResponse.json({ status: "completed" });
}
