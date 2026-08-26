import { auditPrices, type PriceAudit } from "./price-provenance.ts";

// THE GATE BETWEEN A PROPOSED PRICE AND THE LIBRARY.
//
// A price the source never stated must not reach a Library item, because from
// there it reaches a client as a quote. The rule is checked in three places and
// only one of them is the boundary:
//
//   materialise  computes warnings so the professional SEES the problem
//   patch        recomputes after an edit, so a fix clears it
//   save         RE-AUDITS FROM SOURCE and refuses — the integrity boundary
//
// The stored `priceWarnings` array is UX. It is written by the server, but it
// lives in a payload the client can PATCH, so treating it as the gate would
// mean the gate could be cleared by editing the thing it guards. Save therefore
// ignores it and audits again from the chunk text.

/** Ordinals of the chunks whose text produced this proposal. A merged
 *  cross-chunk community carries both halves, so both segments are authoritative
 *  for it — auditing a merged record against one half would report the other
 *  half's legitimate prices as unsupported. */
export function sourceOrdinalsOf(p: Record<string, unknown>): number[] {
  const listed = p.sourceOrdinals;
  if (Array.isArray(listed)) {
    const ns = listed.map(Number).filter((n) => Number.isFinite(n));
    if (ns.length) return [...new Set(ns)].sort((a, b) => a - b);
  }
  const own = Number(p.ordinal);
  return Number.isFinite(own) ? [own] : [];
}

export interface ChunkText { ordinal: number; segment_text?: string | null }

/** The authoritative source text for one proposal. */
export function sourceTextFor(p: Record<string, unknown>, chunks: ChunkText[]): string {
  const want = new Set(sourceOrdinalsOf(p));
  return chunks
    .filter((c) => want.has(Number(c.ordinal)))
    .map((c) => String(c.segment_text ?? ""))
    .join("\n");
}

/** Audit one proposal against its own chunk text. */
export function auditProposal(p: Record<string, unknown>, chunks: ChunkText[]): PriceAudit {
  return auditPrices(p, sourceTextFor(p, chunks));
}

/** Everything a professional needs to act: which prices, and what to do. */
export function priceWarningsFor(p: Record<string, unknown>, chunks: ChunkText[]): string[] {
  const a = auditProposal(p, chunks);
  return [...a.unsupported, ...a.unsupportedRanges];
}

/** The sentence shown when a save is refused. Names the community and the
 *  exact values, because "unsupported pricing" is not something anyone can act
 *  on without knowing which figure is wrong. */
export function priceBlockMessage(title: string, offending: string[]): string {
  const name = String(title ?? "").trim() || "This community";
  const list = offending.join(", ");
  const isAre = offending.length === 1 ? "isn’t" : "aren’t";
  const it = offending.length === 1 ? "it" : "them";
  return `${name} shows ${list}, which ${isAre} in its source. Correct or remove ${it} before saving.`;
}
