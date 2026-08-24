import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { PHOTO_BUCKET, sniffImageType, MAX_PHOTO_BYTES, ACCEPTED_PHOTO_TYPES } from "@/lib/photo-upload";

export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };

// POST /api/packets/:id/photos — store one creator-supplied image.
//
// The browser never touches storage. It posts a file here, this route decides
// whether to keep it and what to call it, and returns a URL. That is the only
// reason the bucket can be public-read without being an open file host: there
// is no client-side write path to abuse.
export async function POST(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: packetId } = await context.params;
  const supabase = createServerClient();

  // OWNERSHIP FIRST, before reading the body. A stranger's upload should cost
  // us one query, not a 10MB read.
  const { data: packet } = await supabase
    .from("packets").select("id").eq("id", packetId).eq("user_id", session.userId).maybeSingle();
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Expected a file upload." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "no_file", message: "Choose an image to upload." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty_file", message: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({
      error: "too_large",
      message: `That image is larger than ${Math.floor(MAX_PHOTO_BYTES / 1048576)}MB. Try a smaller one.`,
    }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // THE TYPE COMES FROM THE BYTES, never from the browser.
  //
  // Content-Type and the file extension are both attacker-controlled. Sniffing
  // the magic number is what stops an HTML or SVG payload being stored under an
  // image name and served from a public bucket, where it would execute on our
  // own origin pattern.
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return NextResponse.json({
      error: "unsupported_type",
      message: `That file isn't a supported image. Use ${ACCEPTED_PHOTO_TYPES.map((t) => t.ext.toUpperCase()).join(", ")}.`,
    }, { status: 415 });
  }

  // UNGUESSABLE, AND CARRYING NOTHING.
  //
  // 32 random bytes, not the original filename and not the user or packet id.
  // The bucket is public-read, so the object name IS the access control: it
  // must be unguessable on its own, and it must not disclose whose packet a
  // photo belongs to or what the file was called on someone's desktop.
  const name = randomBytes(32).toString("hex");
  const objectPath = `${name.slice(0, 2)}/${name}.${sniffed.ext}`;

  const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(objectPath, bytes, {
    contentType: sniffed.mime,
    upsert: false,               // a collision at 32 bytes of entropy is a bug, not a retry
    cacheControl: "31536000",    // the object name is unique, so it can never go stale
  });
  if (upErr) {
    console.error("[photos] upload failed", { packetId, message: upErr.message });
    return NextResponse.json({
      error: "upload_failed",
      message: "Could not store that image. Please try again.",
    }, { status: 502 });
  }

  const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(objectPath);
  return NextResponse.json({ ok: true, url: pub.publicUrl, width: null, height: null });
}
