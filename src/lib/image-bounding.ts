// BOUNDING A RECIPIENT-FACING PHOTOGRAPH TO THE SIZE SOMETHING ACTUALLY SHOWS.
//
// A 12-megapixel phone photograph was reaching recipients whole. Measured on a
// real one — 4032x3024, 3,779 KB — displayed in a ~360px card. The renderers
// never asked for that: print asks for 1600px, email for 1104, the web card for
// 1280 at 2x. The gallery asks for nothing at all and therefore gets whatever
// was stored, which is why the ceiling has to be at the STORING end.
//
// 1600px IS NOT THE CARD WIDTH. It is the largest rendition any renderer in
// this product requests — print's hero — so a bounded photograph still prints
// at full quality and a phone still fills its screen with it. What it gives up
// is full-screen inspection on a large hi-dpi desktop, where 1600px upscales by
// about half. That is the trade, and it is the reason this number is not 800.
//
// JPEG ONLY, DELIBERATELY. A canvas round-trip flattens a transparent PNG onto
// a background nobody chose and destroys an animated GIF's animation, and
// deciding safely whether a PNG has alpha or a GIF has frames means parsing
// their chunk structure. Every oversized photograph observed in this product's
// storage is a JPEG, because that is what phones produce — so the narrow path
// fixes the whole measured problem, and everything else is passed through
// untouched rather than handled half-well.
//
// NOTHING HERE TOUCHES SOURCE DOCUMENTS. Evidence images post directly to
// /api/ingest/source-image and never call this module or the function that
// calls it. That separation is structural, not a flag.

/** The largest rendition any renderer asks for — print's hero. */
export const MAX_DISPLAY_EDGE = 1600;
/** High enough that a re-encode is not visible at print size. */
export const DISPLAY_QUALITY = 0.82;

/** JPEG, by its magic number rather than by the type the browser guessed.
 *  Agrees with sniffImageType, which is the server's copy of the same rule. */
export function isJpegBytes(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length < 3) return false;
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/**
 * The target size for an image of these dimensions, or null to leave it alone.
 *
 * ALREADY SMALL ENOUGH IS LEFT EXACTLY AS IT IS — not re-encoded "for
 * consistency". Re-encoding a 1200px photograph would lose a generation of
 * quality to make a number tidier, and generational loss is the one cost a
 * lossy format cannot take back.
 */
export function planBound(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= MAX_DISPLAY_EDGE) return null;
  const scale = MAX_DISPLAY_EDGE / longest;
  // round, not floor: floor loses a pixel on one edge and can change the
  // aspect ratio by enough to letterbox a 4:3 photograph in a 4:3 frame.
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A resize that made the file BIGGER is not an improvement. Highly optimised
 *  small JPEGs can survive a canvas round-trip heavier than they arrived. */
export function keepSmaller(originalBytes: number, encodedBytes: number): boolean {
  return encodedBytes > 0 && encodedBytes < originalBytes;
}

// ---------------------------------------------------------------------------
// The browser half. Everything above is pure and tested directly; everything
// below is feature-detected and falls back to the original file on any failure.
// ---------------------------------------------------------------------------

type Decoded = { width: number; height: number; draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void; release: () => void };

/** Decode with EXIF orientation applied, by whichever path this browser has.
 *
 *  `createImageBitmap` with `imageOrientation: "from-image"` is the direct
 *  route. Where it is missing or refuses the option, an <img> and an object URL
 *  do the same job — browsers have applied EXIF orientation to <img> for years,
 *  which is why the fallback is not a quality compromise. */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        width: bitmap.width, height: bitmap.height,
        draw: (ctx, w, h) => ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, w, h),
        release: () => bitmap.close(),
      };
    } catch { /* fall through to the <img> path */ }
  }
  if (typeof URL === "undefined" || typeof Image === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    return {
      width: img.naturalWidth, height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      // The object URL is revoked here rather than after load, because the
      // bitmap is only guaranteed usable while the element holds it.
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** Encode a canvas, preferring OffscreenCanvas and falling back to <canvas>. */
async function encode(
  width: number, height: number,
  paint: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "function") {
    try {
      const off = new OffscreenCanvas(width, height);
      const ctx = off.getContext("2d");
      if (ctx) {
        paint(ctx);
        return await off.convertToBlob({ type: "image/jpeg", quality: DISPLAY_QUALITY });
      }
    } catch { /* fall through to the element canvas */ }
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  paint(ctx);
  if (typeof canvas.toBlob !== "function") return null;
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", DISPLAY_QUALITY));
}

/**
 * The file that should actually be uploaded.
 *
 * NEVER LOSES THE PHOTOGRAPH. Every failure path — an unsupported browser, a
 * decoder that throws, a canvas that will not encode, a result that came out
 * larger — returns the original file. The worst outcome of this function is
 * that nothing happens, which is exactly today's behaviour.
 */
export async function boundDisplayImage(file: File): Promise<File> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    // Anything that is not a plain JPEG is passed through: a transparent PNG
    // and an animated GIF both LOSE something on a canvas, and neither is the
    // problem this exists to solve.
    if (!isJpegBytes(head)) return file;

    const decoded = await decode(file);
    if (!decoded) return file;
    try {
      const target = planBound(decoded.width, decoded.height);
      if (!target) return file;
      const blob = await encode(target.width, target.height,
        (ctx) => decoded.draw(ctx, target.width, target.height));
      if (!blob || !keepSmaller(file.size, blob.size)) return file;
      return new File([blob], file.name, { type: "image/jpeg", lastModified: file.lastModified });
    } finally {
      decoded.release();
    }
  } catch {
    return file;
  }
}
