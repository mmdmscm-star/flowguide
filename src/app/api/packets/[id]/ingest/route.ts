import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildRunChunks, SEGMENTER_VERSION, EntryPoint } from "@/lib/ingestion";
import { segmentHash } from "@/lib/segmentation";

export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

// GET /api/packets/:id/ingest — the active/finalizing run for this packet, if any
// (so the editor can reconnect and resume after a refresh).
export async function GET(_request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const supabase = createServerClient();
  const { data } = await supabase
    .from("ingestion_runs")
    .select("id, status, total_chunks, completed_chunks")
    .eq("packet_id", id)
    .eq("user_id", session.userId)
    .in("status", ["active", "finalizing"])
    .maybeSingle();
  return NextResponse.json({ activeRun: data ? { runId: data.id, status: data.status, totalChunks: data.total_chunks, completedChunks: data.completed_chunks } : null });
}

// A generous cap — chunking handles large sources, but reject absurd payloads.
const INGEST_MAX_CHARS = 200000;

// POST /api/packets/:id/ingest — create a persisted, resumable ingestion run.
// Body: { entryPoint: 'organize'|'append'|'section_append', targetSectionId?, rawText, packetType? }
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = await request.json();
  const entryPoint = body.entryPoint as EntryPoint;
  const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
  const targetSectionId = body.targetSectionId ?? null;

  // Organize creates its own packet atomically via /api/ingest/organize.
  if (!["append", "section_append"].includes(entryPoint)) {
    return NextResponse.json({ error: "bad entryPoint" }, { status: 400 });
  }
  if (rawText.length < 10) return NextResponse.json({ error: "Paste more text first." }, { status: 400 });
  if (rawText.length > INGEST_MAX_CHARS) {
    return NextResponse.json({ error: "input_too_large", message: `Too large (${rawText.length.toLocaleString()} chars; limit ${INGEST_MAX_CHARS.toLocaleString()}).` }, { status: 413 });
  }

  const supabase = createServerClient();

  // If an import is already active for this packet, tell the client to resume it.
  const { data: existing } = await supabase
    .from("ingestion_runs")
    .select("id")
    .eq("packet_id", id)
    .eq("user_id", session.userId)
    .in("status", ["active", "finalizing"])
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "run_active", runId: existing.id, message: "An import is already in progress for this packet." }, { status: 409 });
  }

  const chunks = buildRunChunks(rawText);
  const { data: runId, error } = await supabase.rpc("create_ingestion_run", {
    p_owner: session.userId,
    p_packet_id: id,
    p_entry_point: entryPoint,
    p_target_section_id: targetSectionId,
    p_source_text: rawText,
    p_source_hash: segmentHash(rawText),
    p_source_len: rawText.length, // JS UTF-16 code-unit length (matches chunk offsets)
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ runId, totalChunks: chunks.length }, { status: 201 });
}
