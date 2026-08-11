// Source-specific image optimisation, deliberately isolated to one file.
//
// A photo index for a 36-photo listing must not download 36 full-size images on
// a phone, so index tiles ask their source for a small rendition. Today every
// stored photo happens to be a Cloudinary URL, but direct upload into FlowGuide
// is likely future work — so the gallery renderer must not learn about
// Cloudinary. It calls `thumbnailUrl()` and knows nothing else.
//
// Adding a source later means adding a branch HERE and nothing anywhere else.
// A source we do not recognise gets its original URL back, unchanged: the tile
// still renders, still lazy-loads, and is merely heavier than it could be.
// Degrading to "correct but larger" is the right failure mode for a renderer.

/** `https://res.cloudinary.com/<cloud>/image/upload/` + the rest of the path. */
const CLOUDINARY = /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/i;

/**
 * A URL for the same photo at roughly `width` device pixels, when the source
 * can produce one. Returns the input unchanged for unrecognised sources.
 *
 * `c_limit` never upscales, so a stored 200x200 photo is served at 200x200
 * rather than being blown up to fill the request.
 */
export function thumbnailUrl(url: string, width: number): string {
  const trimmed = (url || "").trim();
  if (!trimmed || !Number.isFinite(width) || width <= 0) return url;

  const match = CLOUDINARY.exec(trimmed);
  if (!match) return url;

  const [, base, rest] = match;

  // Leave an explicitly transformed URL alone — someone chose that rendition on
  // purpose, and chaining another transform onto it could fight that intent.
  // A bare version segment (`v1782351988`) is not a transformation.
  const firstSegment = rest.split("/")[0];
  const isVersion = /^v\d+$/i.test(firstSegment);
  const looksTransformed = !isVersion && /^[a-z]+_[^/]*$/i.test(firstSegment);
  if (looksTransformed) return url;

  return `${base}c_limit,w_${Math.round(width)},q_auto,f_auto/${rest}`;
}
