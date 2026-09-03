import { recordSpan } from "./notes-provenance.ts";

// AN UNRESOLVED RECORD MAKES ITS NEIGHBOUR'S SPAN UNTRUSTWORTHY.
//
// `recordSpan` bounds a record by where its next locatable SIBLING begins. When
// a proposal's title cannot be found in the source, that record stops bounding
// anything, and the record before it silently absorbs its block. Observed on
// the real import: the model abbreviated two parentheticals, and Calligraphy
// Napa Valley's span ran through both Napa records — it came out holding 7
// photos instead of 5, with no warning of any kind. It would have saved.
//
// The failure is not about photos. `recordSpan` is the shared provenance
// primitive behind media attribution, private-note authorisation and
// description attribution alike, so an oversized span is falsely authoritative
// for all three. Fixing only media would leave the other two trusting the same
// bad boundary.
//
// What is known deterministically about an unlocatable record is where the
// model READ it: the chunk it was produced from, whose source offsets are
// stored and tile the source exactly. The record must overlap that range. That
// range is therefore ambiguous — it may belong to the unresolved record or to
// its neighbour, and nothing here can tell which.
//
// So the range is not used as positive evidence for anybody. It is not
// reassigned, nothing is deleted, and the model's own values are left alone.
// The affected proposals are surfaced instead, because only the professional
// can say where the boundary really is.

export interface SourceRange {
  start: number;
  /** exclusive */
  end: number;
}

export interface ChunkRange extends SourceRange {
  ordinal: number;
}

/** The chunk ordinals a proposal was produced from — one, or several after a
 *  continuation merge. */
export function ordinalsOf(proposal: { ordinal?: unknown; sourceOrdinals?: unknown }): number[] {
  const merged = Array.isArray(proposal.sourceOrdinals) ? proposal.sourceOrdinals.map(Number) : [];
  if (merged.length) return merged.filter((n) => Number.isFinite(n));
  const one = Number(proposal.ordinal);
  return Number.isFinite(one) ? [one] : [];
}

/** The source range a proposal was read from. Null when its chunks are unknown,
 *  which is itself a reason to trust nothing about it. */
export function readRangeOf(
  proposal: { ordinal?: unknown; sourceOrdinals?: unknown },
  chunks: ChunkRange[],
): SourceRange | null {
  const want = ordinalsOf(proposal);
  const hit = chunks.filter((c) => want.includes(c.ordinal));
  if (!hit.length) return null;
  return { start: Math.min(...hit.map((c) => c.start)), end: Math.max(...hit.map((c) => c.end)) };
}

export function overlaps(a: SourceRange, b: SourceRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Where a record's own block sits in the full source, as offsets. */
export function spanRangeOf(fullSource: string, title: string, allTitles: string[]): SourceRange | null {
  const span = recordSpan(fullSource, title, allTitles.filter((t) => t !== title));
  if (span === null) return null;
  const start = fullSource.indexOf(span);
  if (start < 0) return null;
  return { start, end: start + span.length };
}

/**
 * The source ranges no record may claim as evidence.
 *
 * One range per proposal whose identity the source cannot confirm. Merged and
 * sorted so callers can test cheaply.
 */
export function ambiguousRanges(
  proposals: Array<{ title?: unknown; ordinal?: unknown; sourceOrdinals?: unknown }>,
  fullSource: string,
  chunks: ChunkRange[],
): SourceRange[] {
  const titles = proposals.map((p) => String(p.title ?? "")).filter(Boolean);
  const raw: SourceRange[] = [];
  for (const p of proposals) {
    const title = String(p.title ?? "");
    if (!title) continue;
    if (spanRangeOf(fullSource, title, titles) !== null) continue;   // identity confirmed
    const read = readRangeOf(p, chunks);
    if (read) raw.push(read);
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: SourceRange[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * The same source with every ambiguous range blanked out.
 *
 * Offsets and line structure are preserved — spaces for text, newlines kept —
 * so a span still starts in the right place and still ends at the right
 * sibling. What changes is that the ambiguous bytes can no longer MATCH
 * anything: a photo there attributes to nobody, a sentence there proves no
 * description belongs to the neighbour, and a "Private note:" directive there
 * authorises nothing. Positive evidence only; this is never used to accuse.
 */
export function withoutAmbiguous(fullSource: string, ranges: SourceRange[]): string {
  if (!ranges.length) return fullSource;
  const out = [...fullSource];
  for (const r of ranges) {
    for (let i = Math.max(0, r.start); i < Math.min(out.length, r.end); i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}

/**
 * The chunks that produced a record the source cannot confirm.
 *
 * The private-note gate is deliberately CHUNK-scoped: it bounds a record by the
 * siblings produced from the same chunk, searching that chunk's own text. So
 * blanking the full source does not reach it — an unfindable same-chunk sibling
 * still lets its "Private note:" directive fall inside its neighbour's span and
 * authorise a note that is not the neighbour's to keep. The chunk text has to
 * be blanked on that path too.
 */
export function unresolvedOrdinals(
  proposals: Array<{ title?: unknown; ordinal?: unknown; sourceOrdinals?: unknown }>,
  fullSource: string,
): Set<number> {
  const titles = proposals.map((p) => String(p.title ?? "")).filter(Boolean);
  const out = new Set<number>();
  for (const p of proposals) {
    const title = String(p.title ?? "");
    if (!title) continue;
    if (spanRangeOf(fullSource, title, titles) !== null) continue;
    for (const o of ordinalsOf(p)) out.add(o);
  }
  return out;
}

/** The same chunk texts with those chunks blanked — evidence from them proves
 *  nothing for anybody, including the records that share them. */
export function withoutAmbiguousChunks<T extends { ordinal: number; segment_text?: unknown }>(
  chunks: T[], ordinals: Set<number>,
): T[] {
  if (!ordinals.size) return chunks;
  return chunks.map((c) => ordinals.has(Number(c.ordinal))
    ? { ...c, segment_text: String(c.segment_text ?? "").replace(/[^\n]/g, " ") }
    : c);
}

export interface ProvenanceDoubt {
  /** True when this record's own identity could not be confirmed. */
  unresolved: boolean;
  /** True when its apparent span reaches into someone else's ambiguous range. */
  overlapping: boolean;
}

export function doubtFor(
  proposal: { title?: unknown; ordinal?: unknown; sourceOrdinals?: unknown },
  fullSource: string,
  allTitles: string[],
  ranges: SourceRange[],
): ProvenanceDoubt {
  const title = String(proposal.title ?? "");
  const span = spanRangeOf(fullSource, title, allTitles);
  if (span === null) return { unresolved: true, overlapping: false };
  return { unresolved: false, overlapping: ranges.some((r) => overlaps(span, r)) };
}

/** Review text for a proposal whose provenance is in doubt. Empty when it is not. */
export function provenanceWarningsFor(
  proposal: { title?: unknown; ordinal?: unknown; sourceOrdinals?: unknown },
  fullSource: string,
  allTitles: string[],
  ranges: SourceRange[],
): string[] {
  const title = String(proposal.title ?? "").trim() || "This record";
  const d = doubtFor(proposal, fullSource, allTitles, ranges);
  if (d.unresolved) {
    return [`${title}: Sendset could not find this community in your source, so it cannot confirm which ` +
            `information belongs to it. Check its name against your source before saving.`];
  }
  if (d.overlapping) {
    return [`${title}: part of your source next to this community could not be matched to a community name, ` +
            `so Sendset cannot tell where this record ends. Confirm its photos and description before saving.`];
  }
  return [];
}
