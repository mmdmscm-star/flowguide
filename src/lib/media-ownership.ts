// Media ownership verification.
//
// Stage 1 proved that every source photo was stored SOMEWHERE. It could not
// prove a photo belonging to source entity A was not persisted onto entity B —
// and that is the failure that reached a live client packet twice. Counting is
// blind to theft because theft is conservative: the stolen photo still lands
// somewhere, so the totals balance.
//
// This module answers the ownership question structurally rather than by
// inference. A chunk's source range is exact and persisted; a record's span is
// computed by the detector. So "which record produced this item" is a fact, and
// ownership reduces to arithmetic over offsets.
//
// Deliberately NOT here: any attempt to anchor an item by matching its title in
// the source. That was measured against both incidents and is unsafe — a
// legitimate item ("Primrose Alzheimer's Living", whose source header is just
// "Primrose") and a fabricated one ("Drake T Community Property") both occur
// ZERO times in their sources. See docs/investigations/media-ownership-provenance.md.

import type { SourceRecord } from "./segmentation.ts";
import { isMediaUrl } from "./media-ledger.ts";

export interface ChunkRange {
  ordinal: number;
  start: number;
  end: number;
}

/** One item as produced by a chunk, in the order the chunk emitted it. */
export interface ProducedItem {
  chunkOrdinal: number;
  title: string;
  photos: string[];
}

export type OwnershipCode =
  | "media_on_wrong_record"     // objective: the source puts this photo elsewhere
  | "continuation_fabrication"  // a non-first chunk of a record invented an item
  | "ownership_unverifiable";   // structure cannot bind item -> record

export interface OwnershipFinding {
  code: OwnershipCode;
  url?: string;
  /** Index into `records` — where the source actually puts this media. */
  expectedRecord?: number;
  /** Index into `producedItems` — where it was placed. */
  itemIndex: number;
  itemTitle: string;
  /** Only set when exactly one destination item is resolvable. */
  proposedItemIndex?: number;
  proposedItemTitle?: string;
  detail: string;
}

export interface OwnershipReport {
  /** producedItems[i] belongs to records[bindings[i]]; null = not bindable. */
  bindings: (number | null)[];
  findings: OwnershipFinding[];
  /** True when every produced item bound to exactly one record. */
  fullyBound: boolean;
}

/** Every offset at which a media URL occurs, in source order. */
export function mediaOccurrences(source: string): Array<{ url: string; at: number }> {
  const out: Array<{ url: string; at: number }> = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source || "")) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (isMediaUrl(url)) out.push({ url, at: m.index });
  }
  return out;
}

const recordAt = (records: SourceRecord[], off: number) =>
  records.findIndex((r) => off >= r.start && off < r.end);

/** Records a chunk overlaps at all. */
const recordsTouched = (records: SourceRecord[], c: ChunkRange) =>
  records.map((r, i) => ({ r, i })).filter(({ r }) => r.start < c.end && r.end > c.start);

/**
 * Bind produced items to source records, then check that every stored media
 * occurrence sits on an item belonging to the record the SOURCE puts it in.
 *
 * Binding is structural and conservative:
 *   - a chunk may only INTRODUCE items for records whose head it contains, and
 *     when the counts agree the nth item is the nth record (source order holds);
 *   - a chunk containing no record head at all is a pure continuation of the one
 *     record it sits inside — an oversized record split across chunks;
 *   - anything else leaves those items unbound and reports them as unverifiable
 *     rather than guessing. Ambiguity becomes review, never a second guess.
 */
export function verifyOwnership(opts: {
  source: string;
  records: SourceRecord[];
  chunks: ChunkRange[];
  producedItems: ProducedItem[];
}): OwnershipReport {
  const { source, records, chunks, producedItems } = opts;
  const bindings: (number | null)[] = producedItems.map(() => null);
  const findings: OwnershipFinding[] = [];

  const byChunk = new Map<number, number[]>();
  producedItems.forEach((it, i) => {
    const list = byChunk.get(it.chunkOrdinal) ?? [];
    list.push(i);
    byChunk.set(it.chunkOrdinal, list);
  });

  for (const chunk of chunks) {
    const idxs = byChunk.get(chunk.ordinal) ?? [];
    if (idxs.length === 0) continue;
    const touched = recordsTouched(records, chunk);
    // A chunk can only INTRODUCE an item for a record whose beginning it holds.
    // A record whose head landed in an earlier chunk is a continuation here, not
    // a new entity — that asymmetry is what makes the incident's plan legible:
    // chunk 1 held Reserve's orphaned TAIL plus the whole Chanate record, so its
    // single item is unambiguously Chanate's, and Reserve's stranded photos are
    // provably on the wrong record rather than merely unverifiable.
    const heads = touched.filter(({ r }) => r.start >= chunk.start && r.start < chunk.end);

    if (heads.length === idxs.length) {
      // Source order is preserved, so the nth item corresponds to the nth head.
      idxs.forEach((itemIdx, n) => { bindings[itemIdx] = heads[n].i; });
      continue;
    }
    if (heads.length === 0 && touched.length === 1) {
      // Pure continuation: an oversized record split across chunks.
      for (const i of idxs) bindings[i] = touched[0].i;
      continue;
    }
    for (const i of idxs) {
      findings.push({
        code: "ownership_unverifiable",
        itemIndex: i,
        itemTitle: producedItems[i].title,
        detail: `chunk ${chunk.ordinal} begins ${heads.length} records but produced ${idxs.length} items, so ownership cannot be established structurally`,
      });
    }
  }

  // A record's FIRST chunk is the one that may introduce its item(s). A later
  // chunk of the same record is a continuation: its media belongs to the item
  // that already exists, and it must not invent a second standalone entity.
  const firstChunkOfRecord = new Map<number, number>();
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    for (const { i } of recordsTouched(records, chunk)) {
      if (!firstChunkOfRecord.has(i)) firstChunkOfRecord.set(i, chunk.ordinal);
    }
  }
  producedItems.forEach((it, i) => {
    const rec = bindings[i];
    if (rec === null) return;
    if (firstChunkOfRecord.get(rec) === it.chunkOrdinal) return;
    // Only the items bound to this record from its FIRST chunk are candidates.
    const siblings = producedItems
      .map((s, si) => ({ s, si }))
      .filter(({ s, si }) => bindings[si] === rec && s.chunkOrdinal === firstChunkOfRecord.get(rec));
    const unique = siblings.length === 1 ? siblings[0] : null;
    findings.push({
      code: "continuation_fabrication",
      itemIndex: i,
      itemTitle: it.title,
      expectedRecord: rec,
      ...(unique ? { proposedItemIndex: unique.si, proposedItemTitle: unique.s.title } : {}),
      detail: unique
        ? `chunk ${it.chunkOrdinal} continues a record that already produced "${unique.s.title}"`
        : `chunk ${it.chunkOrdinal} continues a record with ${siblings.length} existing items, so no single merge target is resolvable`,
    });
  });

  // Ownership proper: every media occurrence must be on an item of its record.
  const occurrences = mediaOccurrences(source);
  const byUrl = new Map<string, number[]>();
  for (const o of occurrences) {
    const rec = recordAt(records, o.at);
    if (rec < 0) continue;
    const list = byUrl.get(o.url) ?? [];
    list.push(rec);
    byUrl.set(o.url, list);
  }

  producedItems.forEach((it, i) => {
    const rec = bindings[i];
    if (rec === null) return;
    for (const url of it.photos) {
      if (!isMediaUrl(url)) continue;
      const sourceRecords = byUrl.get(url);
      if (!sourceRecords || sourceRecords.length === 0) continue; // accounting's job
      if (sourceRecords.includes(rec)) continue;                  // correct owner
      const expected = sourceRecords[0];
      const owners = producedItems
        .map((s, si) => ({ s, si }))
        .filter(({ si }) => bindings[si] === expected);
      const unique = owners.length === 1 ? owners[0] : null;
      findings.push({
        code: "media_on_wrong_record",
        url,
        expectedRecord: expected,
        itemIndex: i,
        itemTitle: it.title,
        ...(unique ? { proposedItemIndex: unique.si, proposedItemTitle: unique.s.title } : {}),
        detail: unique
          ? `the source places this photo in the record that produced "${unique.s.title}"`
          : `the source places this photo in a record with ${owners.length} items, so no single destination is resolvable`,
      });
    }
  });

  return { bindings, findings, fullyBound: bindings.every((b) => b !== null) };
}
