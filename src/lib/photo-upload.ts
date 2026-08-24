// What FlowGuide will accept as a creator-uploaded photo, and how it decides.
//
// Pure and dependency-free so the rules can be tested without a bucket, a
// session or a network.

export const PHOTO_BUCKET = "packet-photos";

/** Matches the bucket's own file_size_limit in migration 0029. Two places, one
 *  number: the bucket refuses oversized objects even if this route is bypassed,
 *  and this route gives a sentence instead of a storage error. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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
