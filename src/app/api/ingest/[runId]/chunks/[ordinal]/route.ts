import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { processSegment, buildSplitChildren, shouldPresplit, EntryPoint } from "@/lib/ingestion";

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

  // A retried (previously failed/timed-out) or oversized segment is subdivided
  // rather than sent to the model again.
  if (attempt >= AUTO_SPLIT_AT_ATTEMPT || shouldPresplit(segmentText)) return doSplit();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI service not configured" }, { status: 500 });

  const { data: packet } = await supabase.from("packets").select("packet_type").eq("id", run.packet_id).maybeSingle();
  const isLead = entryPoint === "organize" && sourceStart === 0;

  const outcome = await processSegment({
    entryPoint,
    packetType: packet?.packet_type || "general",
    isLead,
    segmentText,
    sectionHint: (c.section_hint as string) || "",
    apiKey,
  });

  if (outcome.kind === "split") return doSplit();
  if (outcome.kind === "error") {
    await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_attempt: attempt, p_error: outcome.message });
    return NextResponse.json({ error: "chunk_failed", message: outcome.message }, { status: outcome.status >= 400 ? outcome.status : 502 });
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
