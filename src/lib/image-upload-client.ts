// POSTING ONE IMAGE, from whichever surface is asking.
//
// The ENDPOINT IS THE CALLER'S DECISION and deliberately not this module's,
// because the endpoint is the authorization choice:
//
//   /api/packets/:id/photos   this session owns that packet
//   /api/library/images       this session is signed in
//
// A Library entry has no packet to own, which is why the second exists; the
// shared item editor is used by both, so it must be handed a way to upload
// rather than picking one. What is shared here is only the request shape and
// the reading of the reply — the parts that would otherwise be copied three
// times and drift.

import { MAX_UPLOAD_BYTES, OVERSIZED_IMAGE_MESSAGE } from "./photo-upload.ts";

export type ImageUploadResult = { url: string } | { error: string };
/** Handed to an editor that can upload but must not choose where. */
export type UploadImage = (file: File) => Promise<ImageUploadResult>;

const GENERIC = "Could not upload that image.";

export async function uploadCreatorImage(endpoint: string, file: File): Promise<ImageUploadResult> {
  // REFUSED HERE, BEFORE THE REQUEST EXISTS.
  //
  // A body over the transport budget is rejected by the platform before our
  // route runs, and what comes back is plain text — so `res.json()` yields
  // nothing and the caller reports "could not upload", which is true and
  // useless. The browser is holding the File and can say the useful thing
  // instead. The route keeps its own copy of this check for callers that are
  // not this function.
  if (file.size > MAX_UPLOAD_BYTES) return { error: OVERSIZED_IMAGE_MESSAGE };
  try {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(endpoint, { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    // The server's own sentence when it has one — "larger than 10MB" is worth
    // more than "could not upload".
    if (!res.ok || !data?.url) return { error: (data?.message as string) || GENERIC };
    return { url: data.url as string };
  } catch {
    return { error: "Could not upload that image. Check your connection and try again." };
  }
}
