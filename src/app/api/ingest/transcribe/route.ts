import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE, sniffImageType } from "@/lib/photo-upload";
import { callTranscriptionModel } from "@/lib/transcribe";
import { MAX_OUTPUT_TOKENS, STRUCTURE_MODEL } from "@/lib/ai-structure";

export const maxDuration = 60;

// POST /api/ingest/transcribe — read one picture into draft source text.
//
// OWNERSHIP IS THE SESSION. There is no packet to own yet: on /new the packet
// and the run are created together by create_organize_run, AFTER the
// professional has read the transcription and pressed Organize. So this is the
// same check /api/library/images and /api/profile/images use, for the same
// reason — and like them it only stores bytes, attaching nothing to anything.
//
// THIS ROUTE STORES NOTHING. Reading a picture and KEEPING it are separate
// acts, and only the second one is something the professional has asked for.
// Someone who photographs a client document, reads what came back and then
// abandons the page has not asked us to hold their document — so the bytes are
// read, transcribed, and dropped. Persisting happens later, on Continue, in
// /api/ingest/source-image.
//
// WHAT THIS RETURNS IS NOT CONTENT. It is a DRAFT OF THE SOURCE, which the
// professional corrects before anything is structured from it. The route
// cannot start an ingestion run, cannot write to storage, and does not try to.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      error: "not_configured", source: "ours",
      message: "Reading images is not available right now.",
    }, { status: 503 });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_request", source: "ours", message: "Expected an image upload." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "no_file", source: "ours", message: "Choose an image first." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty_file", source: "ours", message: "That file is empty." }, { status: 400 });
  }
  // OUR limit, and it is ours: the bucket's own file_size_limit from 0029. It
  // is not a claim about what the model provider will accept — that ceiling has
  // not been measured, so a provider refusal is reported separately below.
  // THE TRANSPORT BUDGET, not the bucket's limit. A larger body never
  // reaches this line — Vercel refuses it upstream with a plain-text 413 —
  // so this exists to give a caller that DOES reach us the same sentence the
  // browser already showed, rather than a different one. See MAX_UPLOAD_BYTES.
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({
      error: "too_large", source: "ours",
      message: OVERSIZED_IMAGE_MESSAGE,
    }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // The magic number, not the Content-Type the uploader chose. Same rule and
  // same allowlist as every other upload surface; SVG is absent on purpose.
  const kind = sniffImageType(bytes);
  if (!kind) {
    return NextResponse.json({
      error: "unsupported_type", source: "ours",
      message: "That doesn't look like a JPEG, PNG, WebP or GIF image.",
    }, { status: 415 });
  }

  const read = await callTranscriptionModel({
    bytes, mime: kind.mime, apiKey,
    model: STRUCTURE_MODEL, maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!read.ok) {
    // `source` travels to the client so the UI can say whose refusal this was.
    return NextResponse.json(
      { error: read.error, source: read.source, message: read.message },
      { status: read.status });
  }

  // Text only. The picture is still on the professional's device.
  return NextResponse.json({ ok: true, text: read.text });
}
