import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

type Context = { params: Promise<{ runId: string }> };

// GET /api/ingest/:runId — run + leaf-chunk status for progress and resume.
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await context.params;
  const supabase = createServerClient();

  const { data: run } = await supabase
    .from("ingestion_runs")
    .select("id, packet_id, entry_point, target_section_id, status, total_chunks, completed_chunks, error")
    .eq("id", runId)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Leaf chunks (status <> 'split') in deterministic order (source_start).
  const { data: chunks } = await supabase
    .from("ingestion_chunks")
    .select("ordinal, source_start, status, segment_hash, split_depth, attempt_count, error")
    .eq("run_id", runId)
    .neq("status", "split")
    .order("source_start");

  return NextResponse.json({
    run: {
      id: run.id,
      packetId: run.packet_id,
      entryPoint: run.entry_point,
      targetSectionId: run.target_section_id,
      status: run.status,
      totalChunks: run.total_chunks,
      completedChunks: run.completed_chunks,
      error: run.error,
    },
    chunks: (chunks || []).map((c) => ({
      ordinal: c.ordinal,
      sourceStart: c.source_start,
      status: c.status,
      segmentHash: c.segment_hash,
      splitDepth: c.split_depth,
      attemptCount: c.attempt_count,
      error: c.error,
    })),
  });
}
