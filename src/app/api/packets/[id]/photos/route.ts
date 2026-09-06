import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE, storeCreatorImage } from "@/lib/photo-upload";

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
  // THE TRANSPORT BUDGET, not the bucket's limit. A larger body never
  // reaches this line — Vercel refuses it upstream with a plain-text 413 —
  // so this exists to give a caller that DOES reach us the same sentence the
  // browser already showed, rather than a different one. See MAX_UPLOAD_BYTES.
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({
      error: "too_large",
      message: OVERSIZED_IMAGE_MESSAGE,
    }, { status: 413 });
  }

  // Validation, the random object name and the write all live in one shared
  // place; see storeCreatorImage.
  const stored = await storeCreatorImage(supabase, Buffer.from(await file.arrayBuffer()));
  if (!stored.ok) {
    if (stored.code === "upload_failed") console.error("[photos] upload failed", { packetId });
    return NextResponse.json({ error: stored.code, message: stored.message }, { status: stored.status });
  }
  return NextResponse.json({ ok: true, url: stored.url });
}
