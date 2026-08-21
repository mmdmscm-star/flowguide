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
    .select("id, packet_id, destination, entry_point, target_section_id, status, total_chunks, completed_chunks, error, review")
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
      // Null for a library import. Every consumer must branch on this rather
      // than on packetId being falsy for some other reason.
      destination: run.destination,
      entryPoint: run.entry_point,
      targetSectionId: run.target_section_id,
      status: run.status,
      totalChunks: run.total_chunks,
      completedChunks: run.completed_chunks,
      error: run.error,
      // The review verdict was SELECTED here but never returned, so every
      // reload of a held run dropped the summary, the exit sentence and - now -
      // the held units themselves. A panel that cannot say what it is holding,
      // after the one event most likely to bring someone back to it, is a panel
      // that reads as a malfunction.
      review: run.review ?? {},
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
