// A SENDSET'S QR CODE: its canonical public URL, and nothing else.
//
// It encodes publicSendsetUrl(slug) — https://sendset.io/p/<slug> — whatever
// host the professional happens to be browsing, because a QR code is printed
// and outlives any alias. The URL is stable across edits and Republish, so the
// code keeps working; unpublishing takes its destination offline, as it does
// for the link. No redirect layer: a scan is exactly a visit to the link.
//
// Generated locally (uqr, a zero-dependency port of Nayuki's reference
// encoder). No third-party QR service ever sees a Sendset's URL.
import { encode } from "uqr";
import { publicSendsetUrl } from "./public-url.ts";

/** The light margin a scanner needs, in modules. Four is the standard's minimum. */
export const QR_QUIET_ZONE = 4;
/** Downloaded PNGs are at least this many pixels square, in whole pixels per module. */
export const QR_PNG_MIN_PX = 1024;

export type SendsetQr = {
  url: string;
  /** Modules including the quiet zone; true is dark. */
  modules: boolean[][];
  size: number;
  version: number;
};

export function sendsetQr(slug: string): SendsetQr {
  const url = publicSendsetUrl(slug);
  // M, raised to the strongest level that fits the same size: a printed code
  // survives smudges and folds without growing denser.
  const r = encode(url, { ecc: "M", boostEcc: true, border: QR_QUIET_ZONE });
  return { url, modules: r.data, size: r.size, version: r.version };
}

/** A crisp, scalable SVG: white ground, one dark path, no fonts, no external references. */
export function sendsetQrSvg(qr: SendsetQr): string {
  let d = "";
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" width="${qr.size * 10}" height="${qr.size * 10}" shape-rendering="crispEdges">`
    + `<rect width="${qr.size}" height="${qr.size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

/** Whole pixels per module for a PNG of at least QR_PNG_MIN_PX, so edges stay sharp. */
export function sendsetQrPngScale(qr: SendsetQr): number {
  return Math.ceil(QR_PNG_MIN_PX / qr.size);
}

/** A file name that says what it is. The slug is already public in the URL. */
export function sendsetQrFileName(slug: string, ext: "png" | "svg"): string {
  return `sendset-qr-${slug.replace(/[^a-zA-Z0-9-]/g, "")}.${ext}`;
}

/** The part of CanvasRenderingContext2D a PNG export uses. */
export type QrCanvas = { fillStyle: string | CanvasGradient | CanvasPattern; fillRect(x: number, y: number, w: number, h: number): void };

/** Draw the code at `scale` pixels per module onto a canvas of size × scale pixels square. */
export function drawSendsetQr(ctx: QrCanvas, qr: SendsetQr, scale: number): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, qr.size * scale, qr.size * scale);
  ctx.fillStyle = "#000000";
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect(x * scale, y * scale, scale, scale); }));
}
