import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildRunChunks, SEGMENTER_VERSION } from "@/lib/ingestion";
import { segmentHash } from "@/lib/segmentation";
import { generateSlug } from "@/lib/slug";

export const maxDuration = 60;

const INGEST_MAX_CHARS = 200000;

// POST /api/ingest/organize — Initial Organize with AI. Creates the draft packet,
// the ingestion run, the persisted chunk plan, and the packet-origin marker in
// ONE database transaction (create_organize_run), so a partial failure cannot
// leave an unexplained empty draft. Body: { rawText, packetType }.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
  const packetType = typeof body.packetType === "string" ? body.packetType : "general";

  if (rawText.length < 10) return NextResponse.json({ error: "Paste more text first." }, { status: 400 });
  if (rawText.length > INGEST_MAX_CHARS) {
    return NextResponse.json({ error: "input_too_large", message: `Too large (${rawText.length.toLocaleString()} chars; limit ${INGEST_MAX_CHARS.toLocaleString()}).` }, { status: 413 });
  }

  const supabase = createServerClient();
  const chunks = buildRunChunks(rawText);
  const { data, error } = await supabase.rpc("create_organize_run", {
    p_owner: session.userId,
    p_packet_type: packetType,
    p_slug: generateSlug(),
    p_source_text: rawText,
    p_source_hash: segmentHash(rawText),
    p_source_len: rawText.length, // JS UTF-16 code-unit length (matches chunk offsets)
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const res = data as { packet_id: string; run_id: string };
  return NextResponse.json({ packetId: res.packet_id, runId: res.run_id, totalChunks: chunks.length }, { status: 201 });
}
