import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { MAX_PHOTO_BYTES, sniffImageType, storeCreatorImage } from "@/lib/photo-upload";

export const maxDuration = 30;

// POST /api/ingest/source-image — keep the picture an ingestion run came from.
//
// CALLED ONLY ON CONTINUE, and that is the whole reason it exists separately
// from /api/ingest/transcribe. Reading a picture and KEEPING it are different
// acts with different consequences: a professional who photographs a client
// document, reads the transcription and then changes their mind has not asked
// us to store their document anywhere. Storing on transcription would have left
// one in the bucket for every abandoned attempt, attached to no run and so
// outside the evidence lifecycle entirely — a source document with no expiry.
//
// So transcription returns text and nothing else, the browser holds the File,
// and the bytes are persisted here at the moment the professional commits to
// organizing from them. From that point the image is evidence: it is stamped
// onto the run as source_image_url and cleared by the same operation that
// clears source_text (0045).
//
// OWNERSHIP IS THE SESSION. There is no packet yet — on /new the packet and the
// run are created by create_organize_run immediately after this — so this is
// the same check /api/library/images and /api/profile/images use. Like them it
// stores bytes and attaches them to nothing; the attaching is done by the
// organize route, which is owner-scoped and fails closed.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Expected an image upload." }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no_file", message: "Choose an image first." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "empty_file", message: "That file is empty." }, { status: 400 });
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({
      error: "too_large",
      message: `That image is larger than ${Math.floor(MAX_PHOTO_BYTES / 1048576)}MB. Try a smaller one.`,
    }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // The magic number, not the Content-Type the uploader chose — the same rule
  // and the same allowlist as every other upload surface.
  if (!sniffImageType(bytes)) {
    return NextResponse.json({
      error: "unsupported_type",
      message: "That doesn't look like a JPEG, PNG, WebP or GIF image.",
    }, { status: 415 });
  }

  const supabase = createServerClient();
  const stored = await storeCreatorImage(supabase, bytes);
  if (!stored.ok) {
    if (stored.code === "upload_failed") console.error("[ingest-source-image] store failed", { userId: session.userId });
    return NextResponse.json({ error: stored.code, message: stored.message }, { status: stored.status });
  }
  return NextResponse.json({ ok: true, url: stored.url });
}
