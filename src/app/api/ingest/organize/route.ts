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
  // Only the two delimiters a file extension can actually declare. Anything
  // else is ignored rather than trusted: the hint's whole value is that it is a
  // fact about the file the professional chose, not a parameter to be believed.
  const rawHint = typeof body.delimiterHint === "string" ? body.delimiterHint : "";
  const delimiterHint = rawHint === "\t" || rawHint === "," ? rawHint : null;
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  // WHERE THIS TEXT CAME FROM. Present only when the professional built it by
  // correcting a transcription; a paste and a .csv both leave it absent, which
  // is what keeps every existing caller a text-origin run by default.
  const sourceImageUrl = typeof body.sourceImageUrl === "string" && body.sourceImageUrl.trim()
    ? body.sourceImageUrl.trim() : null;

  if (rawText.length < 10) return NextResponse.json({ error: "Paste more text first." }, { status: 400 });
  if (rawText.length > INGEST_MAX_CHARS) {
    return NextResponse.json({ error: "input_too_large", message: `Too large (${rawText.length.toLocaleString()} chars; limit ${INGEST_MAX_CHARS.toLocaleString()}).` }, { status: 413 });
  }
  if (requestKey.length < 8) return NextResponse.json({ error: "missing request key" }, { status: 400 });

  const supabase = createServerClient();
  const chunks = buildRunChunks(rawText);
  const { data, error } = await supabase.rpc("create_organize_run", {
    p_owner: session.userId,
    p_packet_type: packetType,
    p_slug: generateSlug(),
    p_source_text: rawText,
    p_source_hash: segmentHash(rawText),
    p_source_len: rawText.length, // JS UTF-16 code-unit length (matches chunk offsets)
    p_request_key: requestKey,     // idempotency for duplicate/retried POSTs
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks,
    p_delimiter_hint: delimiterHint,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const res = data as { packet_id: string; run_id: string };

  // PROVENANCE, STAMPED AFTER THE ATOMIC CREATE — AND IT FAILS CLOSED.
  //
  // create_organize_run's signature is fixed and this path adds no migration,
  // so the two columns are set in a second statement. Both in ONE update, never
  // separately: 0045's coherence CHECK requires source_origin and
  // source_image_url to agree, and setting either alone is a row Postgres will
  // refuse — correctly, because that row would be a lie about the evidence.
  //
  // A FAILED STAMP STOPS THE REQUEST. 0045 exists so an image-origin run cannot
  // be mistaken for an ordinary paste; a run that silently lost its provenance
  // is the exact thing it was added to prevent, and it would be invisible
  // afterwards — the text reads like any other source. So this returns an error
  // instead of a packet.
  //
  // NOTHING IS STRUCTURED IN THE MEANTIME. This route creates the packet, the
  // run and the chunk plan and does no model work at all; structuring happens
  // later, in the chunk routes, driven by the editor the browser is sent to
  // ONLY on a success response. Withholding that response is therefore
  // sufficient to guarantee no image-derived text enters the pipeline without
  // its provenance.
  //
  // THE DRAFT IS NOT LOST. create_organize_run is idempotent on
  // (owner, request_key), so pressing Organize again returns the same run and
  // re-attempts the stamp rather than creating a second draft.
  if (sourceImageUrl) {
    const { error: markError } = await supabase
      .from("ingestion_runs")
      .update({ source_origin: "image", source_image_url: sourceImageUrl })
      .eq("id", res.run_id)
      .eq("user_id", session.userId);
    if (markError) {
      console.error("[organize] provenance stamp failed; refusing to proceed", { runId: res.run_id, markError });
      return NextResponse.json({
        error: "provenance_not_recorded",
        message: "Could not record that this came from a picture, so it was not organized. Please try again.",
      }, { status: 500 });
    }
  }

  return NextResponse.json({ packetId: res.packet_id, runId: res.run_id, totalChunks: chunks.length }, { status: 201 });
}
