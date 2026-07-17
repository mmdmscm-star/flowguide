import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { processSegment, buildSplitChildren, shouldPresplit, EntryPoint } from "@/lib/ingestion";

export const maxDuration = 60;
type Context = { params: Promise<{ runId: string; ordinal: string }> };

// POST /api/ingest/:runId/chunks/:ordinal — process one bounded chunk.
// Idempotent: a completed chunk returns immediately. Body: { forceSplit? }.
// On truncation, pre-split, or a client-signalled timeout (forceSplit), the chunk
// is subdivided at a natural boundary and the pieces are retried instead.
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

  const { data: chunk } = await supabase
    .from("ingestion_chunks")
    .select("ordinal, source_start, source_end, segment_text, segment_hash, section_hint, status, split_depth")
    .eq("run_id", runId)
    .eq("ordinal", ordinal)
    .maybeSingle();
  if (!chunk) return NextResponse.json({ error: "chunk not found" }, { status: 404 });
  if (chunk.status === "completed") return NextResponse.json({ status: "completed", reused: true });
  if (chunk.status === "split") return NextResponse.json({ status: "split", superseded: true });

  const entryPoint = run.entry_point as EntryPoint;

  // --- adaptive split path (pre-split huge segment, or client-signalled timeout) ---
  async function doSplit() {
    if (chunk!.source_end - chunk!.source_start <= 1) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_error: "segment too small to subdivide" });
      return NextResponse.json({ error: "cannot_subdivide", message: "A block is too large to process and can't be split further." }, { status: 422 });
    }
    const children = buildSplitChildren(run!.source_text as string, chunk!.source_start, chunk!.source_end);
    if (children.length < 2) {
      await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_error: "no split boundary" });
      return NextResponse.json({ error: "cannot_subdivide" }, { status: 422 });
    }
    const { error } = await supabase.rpc("split_chunk", { p_run_id: runId, p_owner: session!.userId, p_ordinal: ordinal, p_children: children });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ status: "split", added: children.length });
  }

  if (forceSplit || shouldPresplit(chunk.segment_text as string)) {
    return doSplit();
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI service not configured" }, { status: 500 });

  // load packet type for the prompt
  const { data: packet } = await supabase.from("packets").select("packet_type").eq("id", run.packet_id).maybeSingle();
  const isLead = entryPoint === "organize" && chunk.source_start === 0;

  const outcome = await processSegment({
    entryPoint,
    packetType: packet?.packet_type || "general",
    isLead,
    segmentText: chunk.segment_text as string,
    sectionHint: (chunk.section_hint as string) || "",
    apiKey,
  });

  if (outcome.kind === "split") return doSplit();
  if (outcome.kind === "error") {
    await supabase.rpc("mark_chunk_failed", { p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_error: outcome.message });
    return NextResponse.json({ error: "chunk_failed", message: outcome.message }, { status: outcome.status >= 400 ? outcome.status : 502 });
  }

  const { error: stageErr } = await supabase.rpc("stage_chunk_result", {
    p_run_id: runId, p_owner: session.userId, p_ordinal: ordinal, p_segment_hash: chunk.segment_hash, p_result: outcome.result,
  });
  if (stageErr) return NextResponse.json({ error: stageErr.message }, { status: 400 });

  // Capture the packet title from the organize lead chunk (metadata only).
  if (isLead && (outcome.title || outcome.clientName)) {
    await supabase
      .from("ingestion_runs")
      .update({ derived_title: outcome.title || "", derived_client_name: outcome.clientName || "" })
      .eq("id", runId)
      .eq("derived_title", "");
  }

  return NextResponse.json({ status: "completed" });
}
