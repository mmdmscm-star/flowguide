import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE, storeCreatorImage } from "@/lib/photo-upload";

export const maxDuration = 30;

// POST /api/profile/images — store one logo or headshot.
//
// This route STORES a file and returns a URL. It does not write the profile:
// which field the URL lands in, and when it is saved, stays with the existing
// profile save path. A route that both stored the bytes and updated the profile
// would be two decisions in one place, and the second one already has an owner.
//
// OWNERSHIP IS THE SESSION ITSELF. The packet-photo route asks "does this
// session own that packet"; here there is no packet — a professional is
// uploading their own branding, so being signed in IS the check. That
// difference is why this is a separate route rather than a parameter on the
// other one.
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
  // Same validation, same unguessable object name, same bucket — one
  // implementation, so the rules cannot drift between the two upload surfaces.
  const stored = await storeCreatorImage(supabase, Buffer.from(await file.arrayBuffer()));
  if (!stored.ok) {
    if (stored.code === "upload_failed") console.error("[profile-images] upload failed", { userId: session.userId });
    return NextResponse.json({ error: stored.code, message: stored.message }, { status: stored.status });
  }
  return NextResponse.json({ ok: true, url: stored.url });
}
