// WHERE EACH PDF PAGE LANDED IN THE SOURCE — or an honest "unknown".
//
// The manifest (0060, ingestion_runs.source_documents) is how a fidelity
// problem is debugged later: "page 4 of prices.pdf is characters 1,204–1,980 of
// this run's source." It is built at organize time, from the text the
// professional is about to organize — which they may have edited.
//
// SO A SPAN IS RECORDED ONLY WHERE IT IS PROVABLE, and null where it is not:
//
//   * The document's whole contribution still appears exactly once, verbatim:
//     every page is located INSIDE it, in order. Exact.
//   * Otherwise (they edited it): a page keeps a span only if its text appears
//     exactly once in the whole source, after the previous page's. A page that
//     appears twice — the same paragraph pasted elsewhere, say — gets null,
//     because pointing at the wrong occurrence would be a false record, which
//     is worse than none.
//
// Offsets are JavaScript string indexes (UTF-16 code units), the same unit the
// chunks and source_len already use.
//
// TRUST. Everything here is REPORTED by this browser. The server re-hashes
// every span against the text it actually received, so a stored span is
// checked; the document fields — name, size, file hash, page count, reader —
// cannot be, because the file never leaves this device. They are provenance
// as reported, not attested (source-documents.ts).
import type { PdfPage } from "./pdf-extract.ts";

export interface ReadDocument {
  name: string;
  bytes: number;
  sha256: string;
  pageCount: number;
  extractor: string;
  pages: PdfPage[];
  /** Exactly what this document put in the box. */
  contributed: string;
}

export interface ManifestPage { page: number; chars: number; sha256: string; start: number | null; end: number | null }
export interface ManifestDocument {
  kind: "pdf";
  name: string;
  bytes: number;
  sha256: string;
  pageCount: number;
  extractor: string;
  pages: ManifestPage[];
}

const CONTROL = /[\u0000-\u001F\u007F]/g;

const occurrences = (hay: string, needle: string): number[] => {
  const at: number[] = [];
  if (!needle) return at;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
};

/** The manifest for these documents against this source. Never includes the
 *  page text itself: that already IS the source. */
export function buildManifest(source: string, docs: ReadDocument[]): ManifestDocument[] {
  let cursor = 0;
  return docs.map((doc) => {
    const block = occurrences(source, doc.contributed);
    const intact = block.length === 1;
    let at = intact ? block[0] : cursor;

    const pages: ManifestPage[] = doc.pages.map((p) => {
      const base = { page: p.page, chars: p.chars, sha256: p.sha256 };
      if (!p.text) return { ...base, start: null, end: null };

      if (intact) {
        const i = source.indexOf(p.text, at);
        // Inside an intact block the pages are there, in order, by construction.
        if (i < 0 || i + p.text.length > block[0] + doc.contributed.length) return { ...base, start: null, end: null };
        at = i + p.text.length;
        return { ...base, start: i, end: at };
      }

      const hits = occurrences(source, p.text);
      if (hits.length !== 1 || hits[0] < at) return { ...base, start: null, end: null };
      at = hits[0] + p.text.length;
      return { ...base, start: hits[0], end: at };
    });

    cursor = Math.max(cursor, at);
    return {
      kind: "pdf" as const,
      // The server refuses a name it cannot store as given, rather than
      // trimming it, so it is made storable here: control characters out, and
      // cut at 255 CHARACTERS (code points, never half an emoji).
      name: Array.from(doc.name.replace(CONTROL, "")).slice(0, 255).join("") || "document.pdf",
      bytes: doc.bytes,
      sha256: doc.sha256,
      pageCount: doc.pageCount,
      extractor: doc.extractor,
      pages,
    };
  });
}
