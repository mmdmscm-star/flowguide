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
  // WHAT THE CREATOR SAID THIS SOURCE IS. Absent for every existing caller and
  // for anyone who simply pastes and organizes, which is the point: the default
  // is that nobody was asked, and that is the behaviour the product has always
  // had. `split` is accepted and persisted but is not offered on screen while
  // it behaves identically to auto.
  const rawIntent = typeof body.groupingIntent === "string" ? body.groupingIntent : "auto";
  const groupingIntent = rawIntent === "keep_together" || rawIntent === "split" ? rawIntent : "auto";
  const groupingTitle = typeof body.groupingTitle === "string" ? body.groupingTitle.trim() : "";
  // The database requires a name for keep_together, so refuse here with a
  // sentence rather than letting a CHECK produce a constraint error.
  if (groupingIntent === "keep_together" && !groupingTitle) {
    return NextResponse.json({
      error: "grouping_title_required",
      message: "Name the item before organizing, or turn off keeping it together.",
    }, { status: 400 });
  }

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
  // ONE UPDATE FOR BOTH PAIRS. Each pair has its own coherence CHECK — image
  // origin with its URL (0045), grouping intent with its title (0046) — and
  // each must move together or Postgres refuses the row. Setting them in one
  // statement satisfies both, and a failure of either stops the request.
  const stamp: Record<string, unknown> = {};
  if (sourceImageUrl) { stamp.source_origin = "image"; stamp.source_image_url = sourceImageUrl; }
  if (groupingIntent !== "auto") {
    stamp.grouping_intent = groupingIntent;
    stamp.grouping_title = groupingIntent === "keep_together" ? groupingTitle : null;
  }
  if (Object.keys(stamp).length) {
    const { error: markError } = await supabase
      .from("ingestion_runs")
      .update(stamp)
      .eq("id", res.run_id)
      .eq("user_id", session.userId);
    if (markError) {
      console.error("[organize] run stamp failed; refusing to proceed", { runId: res.run_id, markError });
      return NextResponse.json({
        error: "provenance_not_recorded",
        message: "Could not record how this source should be organized, so it was not organized. Please try again.",
      }, { status: 500 });
    }
  }

  return NextResponse.json({ packetId: res.packet_id, runId: res.run_id, totalChunks: chunks.length }, { status: 201 });
}
