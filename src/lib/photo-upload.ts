// What FlowGuide will accept as a creator-uploaded photo, and how it decides.
//
// Pure and dependency-free so the rules can be tested without a bucket, a
// session or a network.

import { randomBytes } from "node:crypto";

// ONE BUCKET for every creator-supplied image. The name is historical - profile
// logos and headshots live here too - and it is an implementation detail: the
// object path is what carries privacy, and a second bucket would mean a second
// policy to keep correct for no gain.
export const PHOTO_BUCKET = "packet-photos";

/** Matches the bucket's own file_size_limit in migration 0029. Two places, one
 *  number: the bucket refuses oversized objects even if this route is bypassed,
 *  and this route gives a sentence instead of a storage error. */
// TWO DIFFERENT LIMITS, AND CONFLATING THEM WAS A LIE IN PRODUCTION.
//
// MAX_PHOTO_BYTES is what the STORAGE LAYER accepts: the packet-photos bucket's
// own file_size_limit from 0029. It is a real capability and it has not changed.
//
// MAX_UPLOAD_BYTES is what can actually REACH a route on this deployment, and
// it is smaller. Vercel refuses a function request body over roughly 4.5MB
// before any of our code runs, so a 5MB photograph never met the 10MB gate
// below — it died upstream as a plain-text FUNCTION_PAYLOAD_TOO_LARGE, which
// the browser then reported as "That picture could not be read." Three layers
// agreed on a number the platform overrode.
//
// MEASURED, against the deployed route, by posting bodies of increasing size to
// an endpoint that answers 401 when it is reached at all:
//
//   4000 KB  ->  401   reached the function
//   4300 KB  ->  401   reached the function
//   4400 KB  ->  413   FUNCTION_PAYLOAD_TOO_LARGE, upstream
//   4500 KB  ->  413
//
// So 4 MiB, which leaves roughly 200 KB of measured headroom for multipart
// framing and the rest of the request. It is NOT a provider limit and NOT a
// storage limit — it is this application's transport budget, derived from that
// measurement, and it should be re-measured rather than reasoned about if the
// platform changes.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** What the bucket accepts. Larger than what a request can carry today; the
 *  storage capability does not have to shrink because the transport did. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The sentence a professional can act on. Sizes in MB because that is what a
 *  phone's photo library shows them. */
export const OVERSIZED_IMAGE_MESSAGE =
  `This picture is larger than Sendset can upload right now. Choose one under ${MAX_UPLOAD_BYTES / 1048576} MB.`;

export interface AcceptedType { mime: string; ext: string }

// SVG IS ABSENT ON PURPOSE. It is a script container, and these objects are
// served publicly; an uploaded SVG would be stored XSS. It is not an oversight
// and should not be added because a creator asks for a logo.
export const ACCEPTED_PHOTO_TYPES: AcceptedType[] = [
  { mime: "image/jpeg", ext: "jpg" },
  { mime: "image/png", ext: "png" },
  { mime: "image/webp", ext: "webp" },
  { mime: "image/gif", ext: "gif" },
];

const startsWith = (b: Buffer, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/**
 * Identify an image from its leading bytes.
 *
 * The Content-Type header and the filename extension are both supplied by the
 * uploader and neither is evidence. The magic number is the only part of an
 * upload the uploader cannot lie about without changing what the file actually
 * is.
 *
 * Returns null for anything not on the allowlist — including a file that merely
 * CLAIMS to be an image.
 */
export function sniffImageType(bytes: Buffer): AcceptedType | null {
  if (!bytes || bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }

  // GIF: "GIF87a" or "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mime: "image/gif", ext: "gif" };
  }

  // WEBP: "RIFF" .... "WEBP" — both halves required, since RIFF alone is also
  // WAV and AVI.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

/** For the file picker. A hint to the OS dialog only — never a security
 *  control, because the browser decides what it sends and the bytes decide
 *  what we keep. */
export const PHOTO_ACCEPT_ATTR = ACCEPTED_PHOTO_TYPES.map((t) => t.mime).join(",");


/** The result of storing one creator-supplied image. */
export type StoreResult =
  | { ok: true; url: string; objectPath: string }
  | { ok: false; code: "empty_file" | "too_large" | "unsupported_type" | "upload_failed"; message: string; status: number };

/**
 * Validate and store one image. ONE implementation, shared by the packet-photo
 * route and the profile-image route.
 *
 * The security-critical decisions live here and nowhere else: the type comes
 * from the bytes, the object name is unguessable and carries neither the
 * uploader's filename nor any identity, and nothing is ever overwritten. A
 * second copy of this logic is a second place for one of those to drift.
 *
 * Ownership is NOT checked here - it differs per caller (a packet must belong
 * to the session; a profile IS the session) and belongs at the route, before
 * this is reached.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function storeCreatorImage(supabase: any, bytes: Buffer): Promise<StoreResult> {
  if (!bytes || bytes.length === 0) {
    return { ok: false, code: "empty_file", message: "That file is empty.", status: 400 };
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    return { ok: false, code: "too_large", status: 413,
      message: `That image is larger than ${Math.floor(MAX_PHOTO_BYTES / 1048576)}MB. Try a smaller one.` };
  }
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return { ok: false, code: "unsupported_type", status: 415,
      message: `That file isn't a supported image. Use ${ACCEPTED_PHOTO_TYPES.map((t) => t.ext.toUpperCase()).join(", ")}.` };
  }
  const name = randomBytes(32).toString("hex");
  const objectPath = `${name.slice(0, 2)}/${name}.${sniffed.ext}`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(objectPath, bytes, {
    contentType: sniffed.mime,
    upsert: false,
    cacheControl: "31536000",
  });
  if (error) {
    return { ok: false, code: "upload_failed", status: 502,
      message: "Could not store that image. Please try again." };
  }
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(objectPath);
  return { ok: true, url: data.publicUrl as string, objectPath };
}
