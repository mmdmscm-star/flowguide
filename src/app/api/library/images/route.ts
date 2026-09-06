import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE, storeCreatorImage } from "@/lib/photo-upload";

export const maxDuration = 30;

// POST /api/library/images — store one image for reusable Library material.
//
// OWNERSHIP IS THE SESSION, as it is for profile branding and for the same
// reason: there is no packet here to own. A Library entry is the professional's
// own reusable material, copied INTO Sendsets rather than belonging to one — so
// binding its images to a packet id would be binding them to the wrong thing,
// and would break the moment the entry were used twice.
//
// THIS ROUTE ONLY STORES BYTES. It writes no Library row; it returns a URL, and
// putting that URL on an entry goes through the existing Library update path,
// which checks ownership AND the revision. So a signed-in caller can place an
// object in the bucket — exactly as they already can via /api/profile/images —
// but cannot attach it to anything they do not own.
//
// The bucket, the magic-number sniffing, the size limit and the unguessable
// object name are all storeCreatorImage's, unchanged. There is no second
// storage mechanism here and there must not be one.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  // Checked before the body is read into memory, as well as inside the helper.
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

  const supabase = createServerClient();
  const stored = await storeCreatorImage(supabase, Buffer.from(await file.arrayBuffer()));
  if (!stored.ok) {
    if (stored.code === "upload_failed") console.error("[library-images] upload failed", { userId: session.userId });
    return NextResponse.json({ error: stored.code, message: stored.message }, { status: stored.status });
  }
  return NextResponse.json({ ok: true, url: stored.url });
}
