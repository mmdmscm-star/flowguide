import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { processSegment, buildSplitChildren, shouldPresplit, EntryPoint } from "@/lib/ingestion";

export const maxDuration = 60;
type Context = { params: Promise<{ runId: string; ordinal: string }> };

// Lease must exceed the 60s function limit so a killed request's 'processing'
// claim is recoverable but not stolen from a live worker.
const CLAIM_LEASE_SECONDS = 90;

// POST /api/ingest/:runId/chunks/:ordinal — process one bounded chunk.
// A chunk is CLAIMED atomically (claim_chunk) before the model is called, so two
// simultaneous requests cannot both invoke the model. Body: { forceSplit? }.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId, ordinal: ordinalStr } = await context.params;
  const ordinal = Number(ordinalStr);
  const body = await request.json().catch(() => ({}));
  const forceSplit = body?.forceSplit === true;

  const supabase = createServerClient();
  const { data: run } = await supabase
    .from("ingestion_runs")
    .select("id, user_id, packet_id, entry_point, status, source_text")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.user_id !== session.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (run.status !== "active") return NextResponse.json({ error: "run_not_active", status: run.status }, { status: 409 });

  const entryPoint = run.entry_point as EntryPoint;

  // Subdivide [start,end) at a natural boundary and retry the pieces.
  async function doSplit(start: number, end: number) {
    if (end - start <= 1) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_error: "segment too small to subdivide" });
      return NextResponse.json({ error: "cannot_subdivide", message: "A block is too large to process and can't be split further." }, { status: 422 });
    }
    const children = buildSplitChildren(run!.source_text as string, start, end);
    if (children.length < 2) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_error: "no split boundary" });
      return NextResponse.json({ error: "cannot_subdivide" }, { status: 422 });
    }
    const { error } = await supabase.rpc("split_chunk", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_children: children });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ status: "split", added: children.length });
  }

  // Client-signalled timeout: subdivide without a model call (needs the chunk range).
  if (forceSplit) {
    const { data: chunk } = await supabase
      .from("ingestion_chunks").select("source_start, source_end, status")
      .eq("run_id", runId).eq("ordinal", ordinal).maybeSingle();
    if (!chunk) return NextResponse.json({ error: "chunk not found" }, { status: 404 });
    if (chunk.status === "completed") return NextResponse.json({ status: "completed", reused: true });
    if (chunk.status === "split") return NextResponse.json({ status: "split", superseded: true });
    return doSplit(chunk.source_start as number, chunk.source_end as number);
  }

  // Atomic claim — only ONE request proceeds to the model for a given chunk.
  const { data: claim, error: claimErr } = await supabase.rpc("claim_chunk", {
    p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 400 });
  const c = claim as { claimed: boolean; status: string; segment_text?: string; segment_hash?: string; section_hint?: string; source_start?: number; source_end?: number };
  if (!c.claimed) return NextResponse.json({ status: c.status }); // completed / split / processing (another worker)

  const segmentText = c.segment_text as string;
  const sourceStart = c.source_start as number;
  const sourceEnd = c.source_end as number;

  if (shouldPresplit(segmentText)) return doSplit(sourceStart, sourceEnd);

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

  if (outcome.kind === "split") return doSplit(sourceStart, sourceEnd);
  if (outcome.kind === "error") {
    await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_error: outcome.message });
    return NextResponse.json({ error: "chunk_failed", message: outcome.message }, { status: outcome.status >= 400 ? outcome.status : 502 });
  }

  const { error: stageErr } = await supabase.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_segment_hash: c.segment_hash, p_result: outcome.result,
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
