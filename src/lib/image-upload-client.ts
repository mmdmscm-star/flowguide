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

import { MAX_UPLOAD_BYTES, MAX_PHOTO_BYTES, OVERSIZED_IMAGE_MESSAGE } from "./photo-upload.ts";
import { boundDisplayImage } from "./image-bounding.ts";

export type ImageUploadResult = { url: string } | { error: string };
/** Handed to an editor that can upload but must not choose where. */
export type UploadImage = (file: File) => Promise<ImageUploadResult>;

const GENERIC = "Could not upload that image.";

/** The sentence for a source file too big to be worth decoding in a phone's
 *  browser. MAX_PHOTO_BYTES is not a new limit — it is the bucket's own
 *  file_size_limit from 0029, which has always described what Sendset accepts
 *  at all. Until now the transport budget hid it. */
const TOO_LARGE_TO_PROCESS =
  `This picture is larger than Sendset can handle. Choose one under ${MAX_PHOTO_BYTES / 1048576} MB.`;

export async function uploadCreatorImage(endpoint: string, file: File): Promise<ImageUploadResult> {
  // THE ORDER OF THESE THREE CHECKS IS THE WHOLE FIX.
  //
  // The transport budget used to be tested against the file the professional
  // CHOSE, so an ordinary 12-megapixel phone photograph — over 4 MiB, and the
  // common case — was refused outright with "choose one under 4 MB". They were
  // being asked to go and shrink their own photograph. It is now tested against
  // the file that will actually be sent, which for a phone photograph is about
  // a sixth of the size.
  //
  // A ceiling still exists on the file we are willing to DECODE, because
  // "resize it in the browser" is not an answer to a 60-megapixel panorama on a
  // three-year-old phone. That ceiling is the bucket's own, not a new number.
  if (file.size > MAX_PHOTO_BYTES) return { error: TOO_LARGE_TO_PROCESS };

  // Bounded to what the renderers actually show. Returns the original
  // unchanged for anything that is not an oversized JPEG, and on any failure.
  const upload = await boundDisplayImage(file);

  // REFUSED HERE, BEFORE THE REQUEST EXISTS.
  //
  // A body over the transport budget is rejected by the platform before our
  // route runs, and what comes back is plain text — so `res.json()` yields
  // nothing and the caller reports "could not upload", which is true and
  // useless. The browser is holding the File and can say the useful thing
  // instead. The route keeps its own copy of this check for callers that are
  // not this function.
  if (upload.size > MAX_UPLOAD_BYTES) return { error: OVERSIZED_IMAGE_MESSAGE };
  try {
    const body = new FormData();
    body.append("file", upload);
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
