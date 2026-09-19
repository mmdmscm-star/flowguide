// CHECKING A SOURCE-DOCUMENT MANIFEST AGAINST THE TEXT IT DESCRIBES. Server.
//
// WHAT THE SERVER CAN AND CANNOT KNOW. The PDF never reaches the server — it
// is read in the professional's browser, by design — so most of a manifest is
// CLIENT-REPORTED provenance: the file's name, size and SHA-256, its page
// count, and which extractor read it are what the browser said, and nothing
// here can confirm them. In particular the file hash does NOT prove which file
// was read or that the text came from it; it only lets someone who later holds
// a file check whether it matches what the browser reported.
//
// WHAT THE SERVER DOES VERIFY, independently, is the one thing it holds: the
// text. Every page span is re-hashed against the exact source organize
// received, and one span that does not match refuses the request. So a stored
// span is a checked fact — "these characters of source_text are the text the
// browser reported for page 4" — while the document-level fields stay reported.
//
// AND IT IS A BOUNDARY. This is an arbitrary JSON payload from an
// authenticated caller, so it is held to an exact shape — known fields only,
// every value bounded — and anything malformed or oversized refuses the whole
// request. Nothing is stripped, clipped or truncated into acceptability: a
// manifest is stored exactly as checked, or not at all. The database (0060)
// re-checks the shape as a second line.
import { createHash } from "node:crypto";
import { MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_SOURCE_CHARS } from "./pdf-extract.ts";

export interface VerifiedManifest { ok: true; documents: ManifestRecord[] }
export interface RejectedManifest { ok: false; reason: "malformed" | "mismatch"; message: string }

interface PageRecord { page: number; chars: number; sha256: string; start: number | null; end: number | null }
interface ManifestRecord {
  kind: "pdf"; name: string; bytes: number; sha256: string; pageCount: number; extractor: string; pages: PageRecord[];
}

/** Documents one organize may carry — the same ceiling as 0060's CHECK. */
export const MAX_SOURCE_DOCUMENTS = 20;
/** The whole manifest, serialized. The largest legitimate one — 20 documents
 *  of 50 pages — is well under half of this. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NAME = 255;
/** Which reader produced the text. Reported by the browser, so held to the
 *  shape this app's reader writes (see EXTRACTOR in pdf-extract.ts) rather
 *  than to one exact build, so a tab opened before a deploy still organizes. */
const EXTRACTOR = /^pdfjs-dist@\d{1,4}\.\d{1,4}\.\d{1,6}\+sendset-pdf-layout@\d{1,4}$/;

const DOC_KEYS = ["bytes", "extractor", "kind", "name", "pageCount", "pages", "sha256"];
const PAGE_KEYS = ["chars", "end", "page", "sha256", "start"];
const HEX64 = /^[0-9a-f]{64}$/;
// Control characters, and a surrogate half with no partner: neither is part of
// a real file name, and Postgres refuses the second in jsonb.
const BAD_NAME = /[\u0000-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EMPTY_SHA256 = sha256("");
const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(o).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
};

export function verifySourceDocuments(raw: unknown, source: string): VerifiedManifest | RejectedManifest | null {
  if (raw === undefined || raw === null) return null;
  const malformed = (why: string): RejectedManifest => ({ ok: false, reason: "malformed", message: why });
  const mismatch = (why: string): RejectedManifest => ({ ok: false, reason: "mismatch", message: why });

  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(raw), "utf8"); } catch { return malformed("unserializable"); }
  if (size > MAX_MANIFEST_BYTES) return malformed("manifest too large");
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SOURCE_DOCUMENTS) return malformed("document count");

  // Shape first, for every document, before any hashing.
  for (const d of raw) {
    if (!isPlainObject(d) || !exactKeys(d, DOC_KEYS)) return malformed("document fields");
    if (d.kind !== "pdf") return malformed("kind");
    if (typeof d.name !== "string" || BAD_NAME.test(d.name)) return malformed("name");
    const nameLength = [...d.name].length;   // code points, as Postgres counts them
    if (nameLength < 1 || nameLength > MAX_NAME) return malformed("name length");
    if (!intIn(d.bytes, 1, MAX_PDF_BYTES)) return malformed("bytes");
    if (typeof d.sha256 !== "string" || !HEX64.test(d.sha256)) return malformed("sha256");
    if (!intIn(d.pageCount, 1, MAX_PDF_PAGES)) return malformed("pageCount");
    if (typeof d.extractor !== "string" || d.extractor.length > 120 || !EXTRACTOR.test(d.extractor)) return malformed("extractor");
    if (!Array.isArray(d.pages) || d.pages.length !== d.pageCount) return malformed("page entries");
    for (let i = 0; i < d.pages.length; i++) {
      const p: unknown = d.pages[i];
      if (!isPlainObject(p) || !exactKeys(p, PAGE_KEYS)) return malformed("page fields");
      if (p.page !== i + 1) return malformed("page order");
      if (!intIn(p.chars, 0, MAX_SOURCE_CHARS)) return malformed("chars");
      if (typeof p.sha256 !== "string" || !HEX64.test(p.sha256)) return malformed("page sha256");
      if (p.start === null && p.end === null) continue;
      if (!intIn(p.start, 0, MAX_SOURCE_CHARS) || !intIn(p.end, 0, MAX_SOURCE_CHARS)) return malformed("span");
      if (p.chars === 0 || p.end - p.start !== p.chars) return malformed("span length");
    }
  }

  // Then the truth: every span is the text it claims to be.
  for (const d of raw as ManifestRecord[]) {
    for (const p of d.pages) {
      // A page that gave no text: its hash is checkable without a span.
      if (p.chars === 0 && p.sha256 !== EMPTY_SHA256) return mismatch("blank page hash");
      if (p.start === null || p.end === null) continue;
      if (p.end > source.length) return mismatch("span past the source");
      if (sha256(source.slice(p.start, p.end)) !== p.sha256) return mismatch("span does not match the source");
    }
  }

  // Exactly what was checked: a fresh copy, in a fixed order, of fields that
  // have all just been validated — nothing removed, nothing clipped.
  const documents: ManifestRecord[] = (raw as ManifestRecord[]).map((d) => ({
    kind: "pdf", name: d.name, bytes: d.bytes, sha256: d.sha256, pageCount: d.pageCount, extractor: d.extractor,
    pages: d.pages.map((p) => ({ page: p.page, chars: p.chars, sha256: p.sha256, start: p.start, end: p.end })),
  }));
  return { ok: true, documents };
}
