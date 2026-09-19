// READING A PDF THE PROFESSIONAL ALREADY HAS — in their browser.
//
// A PDF is a SEED, exactly like a .csv: it is read on the device, its text is
// shown in the same box a paste goes into, and the file itself is never
// uploaded, stored or referenced again. What `organize` receives is text.
//
// WHY THE BROWSER. The deployed platform refuses a request body over roughly
// 4.5MB, and a brochure with photographs is routinely larger than that even
// when its text is a few kilobytes — so reading on the server would mean
// either a 4MB ceiling or storing a client's document before they had chosen
// to keep anything. It also keeps an untrusted-document parser out of a
// function that holds the service-role key: here it runs in the uploader's own
// sandboxed worker, on their own file.
//
// WHAT IT GUARANTEES, OR IT REFUSES THE WHOLE FILE:
//   * pages in order, each read by geometry rather than drawing order
//     (pdf-layout.ts), with a refusal wherever that order is not certain;
//   * no summarizing, no model, no reinterpretation;
//   * never "success" for a page it did not actually read — a scanned page, a
//     page whose text cannot be decoded, or a scan wearing a hidden OCR layer
//     is named and refused, never passed off as read.
//
// PURE OF ANY BUNDLER: pdf.js is passed in. The browser hands over the module
// it lazily loaded with its worker; the tests hand over the same module in
// Node. One extractor, so what is tested is what runs.
import { layoutPage, LAYOUT_VERSION, type PdfTextRun } from "./pdf-layout.ts";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const PDF_TIMEOUT_MS = 30_000;
/** The same ceiling a paste and a text file meet: organize refuses above it. */
export const MAX_SOURCE_CHARS = 200_000;

export type PdfErrorCode =
  | "too_large" | "not_pdf" | "encrypted" | "malformed" | "too_many_pages"
  | "empty" | "scanned" | "mixed" | "ocr_layer" | "undecodable" | "layout"
  | "too_long" | "timeout";

/** One page as read. `sha256` is of `text` (UTF-8): it is what lets the
 *  server confirm, at organize time, that a span in the source is exactly the
 *  text this browser reported for the page — without the page text travelling
 *  twice. (That the text came from the PDF is this reader's word: the server
 *  never sees the file.) */
export interface PdfPage { page: number; text: string; chars: number; sha256: string }

export type PdfResult =
  | {
      ok: true;
      name: string;
      bytes: number;
      sha256: string;
      pageCount: number;
      extractor: string;
      pages: PdfPage[];
      /** Every page's text in order, a blank line between pages — the same
       *  separator a picture's transcription uses, and nothing more. No page
       *  markers: they would reach the claim parser as though written. */
      text: string;
    }
  | { ok: false; code: PdfErrorCode; message: string; pages?: number[] };

/** "page 3", "pages 3 and 7", "pages 3, 5 and 7". */
export function pageList(pages: number[]): string {
  const p = [...pages].sort((a, b) => a - b);
  if (p.length === 1) return `page ${p[0]}`;
  return `pages ${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sentence for each refusal. Specific, because "couldn't read that PDF"
 *  tells nobody whether to remove a password, split the file or give up. */
export function pdfError(code: PdfErrorCode, detail: { pages?: number[]; count?: number; bytes?: number } = {}): string {
  const pages = detail.pages?.length ? pageList(detail.pages) : "";
  switch (code) {
    case "too_large":
      return `This PDF is ${((detail.bytes ?? 0) / 1048576).toFixed(1)} MB — the limit is ${MAX_PDF_BYTES / 1048576} MB. Try a smaller file, or paste the part you need.`;
    case "not_pdf":
      return "This file isn’t a PDF, even though it’s named like one.";
    case "encrypted":
      return "This PDF is password-protected. Remove the password (or print it to a new PDF) and try again.";
    case "malformed":
      return "This file isn’t a readable PDF — it may be damaged.";
    case "too_many_pages":
      return `This PDF has ${detail.count} pages — the limit is ${MAX_PDF_PAGES}. Split it, or paste the part you need.`;
    case "empty":
      return "This PDF has no text in it.";
    case "scanned":
      return "This PDF looks like scanned pages, so there’s no text to read. Sendset can’t read scanned PDFs yet.";
    case "mixed":
      return `${capital(pages)} ${detail.pages!.length === 1 ? "has" : "have"} no readable text (they may be scanned), so this PDF wasn’t added.`;
    case "ocr_layer":
      return `${capital(pages)} ${detail.pages!.length === 1 ? "looks" : "look"} like a scanned page with a hidden text layer. Sendset can’t read scanned PDFs yet.`;
    case "undecodable":
      return `Some text on ${pages} couldn’t be decoded, so this PDF can’t be read safely.`;
    case "layout":
      return `Sendset couldn’t safely determine the reading order on ${pages}. This PDF uses columns or a complex layout that isn’t supported yet.`;
    case "too_long":
      return `This PDF has ${(detail.count ?? 0).toLocaleString("en-US")} characters of text — with what’s already here, that’s over the ${MAX_SOURCE_CHARS.toLocaleString("en-US")}-character limit. Paste the part you need instead.`;
    case "timeout":
      return "This PDF took too long to read. Try a smaller file, or paste the part you need.";
  }
}

const refuse = (code: PdfErrorCode, detail: { pages?: number[]; count?: number; bytes?: number } = {}): PdfResult =>
  ({ ok: false, code, message: pdfError(code, detail), ...(detail.pages ? { pages: detail.pages } : {}) });

// The narrow slice of pdf.js this module uses. Typed here so the module does
// not import pdf.js's types, and so a test can see exactly what is relied on.
interface PdfjsTextItem { str?: string; transform?: number[]; width?: number; height?: number; dir?: string }
interface PdfjsPage {
  getViewport(o: { scale: number }): { transform: number[] };
  getTextContent(o: Record<string, unknown>): Promise<{ items: PdfjsTextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  cleanup?(): void;
}
interface PdfjsDocument { numPages: number; getPage(n: number): Promise<PdfjsPage>; destroy(): Promise<void> }
export interface PdfjsModule {
  version: string;
  OPS: Record<string, number>;
  Util: { transform(a: number[], b: number[]): number[] };
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfjsDocument>; destroy(): Promise<void> };
}

export interface ExtractOptions {
  pdfjs: PdfjsModule;
  /** Where pdf.js finds its character maps. Without them, a font that uses a
   *  predefined CMap decodes to nothing — which would read as an empty page. */
  cMapUrl?: string;
  /** Characters still available in the box before the organize ceiling. */
  remainingChars?: number;
  timeoutMs?: number;
}

/** SHA-256, hex — of the file and of each page's text. The file hash is
 *  REPORTED to the server, never checked by it (the file never leaves this
 *  device): it lets someone who later holds a file see whether it matches
 *  what was reported, and proves nothing on its own. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hasMagic = (b: Uint8Array) => {
  // "%PDF-" within the first kilobyte, as the specification allows.
  const head = new TextDecoder("latin1").decode(b.subarray(0, 1024));
  return head.includes("%PDF-");
};

export async function extractPdf(name: string, bytesIn: ArrayBuffer | Uint8Array, opts: ExtractOptions): Promise<PdfResult> {
  const bytes = bytesIn instanceof Uint8Array ? bytesIn : new Uint8Array(bytesIn);
  if (bytes.length > MAX_PDF_BYTES) return refuse("too_large", { bytes: bytes.length });
  if (bytes.length === 0 || !hasMagic(bytes)) return refuse("not_pdf");

  // Hashed BEFORE pdf.js sees the buffer: the worker takes ownership of it.
  const sha256 = await sha256Hex(bytes);
  const { pdfjs } = opts;

  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // CVE-2024-4367: pdf.js could be made to run script through font handling.
    // Fixed upstream long before the version pinned here, and refused here
    // regardless: nothing in a PDF is ever evaluated.
    isEvalSupported: false,
    // Text only. Fonts are never loaded into the page and nothing is drawn.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    ...(opts.cMapUrl ? { cMapUrl: opts.cMapUrl, cMapPacked: true } : {}),
    verbosity: 0,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PdfResult>((resolve) => {
    timer = setTimeout(() => { void task.destroy(); resolve(refuse("timeout")); }, opts.timeoutMs ?? PDF_TIMEOUT_MS);
  });

  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
    void task.destroy().catch(() => {});
  }

  async function read(): Promise<PdfResult> {
    let doc: PdfjsDocument;
    try {
      doc = await task.promise;
    } catch (e) {
      const n = (e as { name?: string })?.name ?? "";
      if (n === "PasswordException") return refuse("encrypted");
      return refuse("malformed");
    }
    if (doc.numPages > MAX_PDF_PAGES) return refuse("too_many_pages", { count: doc.numPages });

    const imageOps = new Set(Object.entries(pdfjs.OPS)
      .filter(([k]) => /image/i.test(k)).map(([, v]) => v));
    const setRenderMode = pdfjs.OPS.setTextRenderingMode;

    const pages: PdfPage[] = [];
    const scanned: number[] = [];
    const ocr: number[] = [];
    const layout: number[] = [];
    const undecodable: number[] = [];
    let pagesWithText = 0;

    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        // NO NORMALIZATION FROM pdf.js. Its default applies compatibility
        // mappings that could change a value; the one mapping this pipeline
        // makes (ligatures) is made explicitly, in pdf-layout.ts.
        const content = await page.getTextContent({ disableNormalization: true, includeMarkedContent: false });
        const ops = await page.getOperatorList();
        const hasImage = ops.fnArray.some((f) => imageOps.has(f));
        const invisibleText = ops.fnArray.some((f, i) => f === setRenderMode && ops.argsArray[i]?.[0] === 3);

        let rtl = false;
        const runs: PdfTextRun[] = [];
        for (const item of content.items) {
          if (typeof item.str !== "string" || !item.transform) continue;
          if (item.dir === "rtl") rtl = true;
          const t = pdfjs.Util.transform(viewport.transform, item.transform);
          const angle = Math.atan2(t[1], t[0]);
          runs.push({
            str: item.str,
            x: t[4],
            y: t[5],
            width: Number(item.width) || 0,
            size: Math.abs(t[3]) || Number(item.height) || 10,
            rotated: Math.abs(angle) > 0.02,
          });
        }
        page.cleanup?.();

        const readable = runs.some((r) => r.str.trim().length > 0);
        if (!readable) {
          // Nothing to read. A picture with no text is a scanned page; a page
          // with neither is simply blank, and contributes nothing.
          if (hasImage) scanned.push(n);
          pages.push({ page: n, text: "", chars: 0, sha256: "" });
          continue;
        }
        pagesWithText++;
        // A scan that already carries somebody else's OCR: an image with text
        // drawn invisibly over it. Its "text" is that OCR's reading, not the
        // document's, and v1 does not read scans.
        if (hasImage && invisibleText) { ocr.push(n); continue; }
        // Right-to-left scripts are read by position here, left to right,
        // which would reverse them. Refused rather than reversed.
        if (rtl) { layout.push(n); continue; }

        const result = layoutPage(runs);
        if (!result.ok) {
          (result.reason === "undecodable" ? undecodable : layout).push(n);
          continue;
        }
        pages.push({ page: n, text: result.text, chars: result.text.length, sha256: "" });
      }
    } catch {
      return refuse("malformed");
    }

    // The order of these is the order of their seriousness to the reader.
    if (!pagesWithText && !scanned.length && !ocr.length) return refuse("empty");
    if (!pagesWithText && scanned.length) return refuse("scanned");
    if (scanned.length) return refuse("mixed", { pages: scanned });
    if (ocr.length) return refuse("ocr_layer", { pages: ocr });
    if (undecodable.length) return refuse("undecodable", { pages: undecodable });
    if (layout.length) return refuse("layout", { pages: layout });

    // Each page's own hash, blank pages included (the hash of nothing).
    const encoder = new TextEncoder();
    for (const p of pages) p.sha256 = await sha256Hex(encoder.encode(p.text));

    const text = pages.filter((p) => p.text).map((p) => p.text).join("\n\n");
    if (!text.trim()) return refuse("empty");
    const remaining = opts.remainingChars ?? MAX_SOURCE_CHARS;
    if (text.length > remaining) return refuse("too_long", { count: text.length });

    return {
      ok: true, name, bytes: bytes.length, sha256, pageCount: doc.numPages,
      extractor: `pdfjs-dist@${pdfjs.version}+${LAYOUT_VERSION}`,
      pages, text,
    };
  }
}
