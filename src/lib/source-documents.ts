// CHECKING A SOURCE-DOCUMENT MANIFEST AGAINST THE TEXT IT DESCRIBES. Server.
//
// The browser builds the manifest (pdf-manifest.ts); this is where it is
// believed or not. It is not believed on the browser's word: every span is
// re-hashed against the exact text organize received, and one span that does
// not match refuses the whole request. A run must not carry provenance that
// is false — the same rule 0045 set for images — and a span that points at the
// wrong text would be exactly that.
//
// The database (0060) checks the SHAPE. This checks the TRUTH: that each span
// really is that page.
import { createHash } from "node:crypto";

export interface VerifiedManifest { ok: true; documents: unknown[] }
export interface RejectedManifest { ok: false; message: string }

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);

export function verifySourceDocuments(raw: unknown, source: string): VerifiedManifest | RejectedManifest | null {
  if (raw === undefined || raw === null) return null;
  const reject = (why: string): RejectedManifest => ({ ok: false, message: why });
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return reject("malformed manifest");

  const documents = raw.map((d) => {
    const doc = (d ?? {}) as Record<string, unknown>;
    return {
      kind: doc.kind, name: doc.name, bytes: doc.bytes, sha256: doc.sha256, pageCount: doc.pageCount,
      extractor: doc.extractor,
      pages: Array.isArray(doc.pages) ? doc.pages.map((p) => {
        const page = (p ?? {}) as Record<string, unknown>;
        // Exactly these fields and no others: nothing the browser adds rides
        // along into the database — page text in particular, which already IS
        // the source.
        return { page: page.page, chars: page.chars, sha256: page.sha256, start: page.start ?? null, end: page.end ?? null };
      }) : null,
    };
  });

  for (const doc of documents) {
    if (doc.kind !== "pdf" || !Array.isArray(doc.pages)) return reject("malformed manifest");
    for (const p of doc.pages) {
      if (!int(p.page) || !int(p.chars) || typeof p.sha256 !== "string" || !HEX64.test(p.sha256)) {
        return reject("malformed manifest");
      }
      if (p.start === null && p.end === null) continue;
      if (!int(p.start) || !int(p.end)) return reject("malformed manifest");
      const start = p.start as number, end = p.end as number;
      if (start < 0 || end <= start || end > source.length || end - start !== p.chars) {
        return reject("a page does not fit the source");
      }
      if (sha256(source.slice(start, end)) !== p.sha256) {
        return reject("a page does not match the source");
      }
    }
  }
  return { ok: true, documents };
}
