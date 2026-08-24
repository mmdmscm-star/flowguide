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
  /** Photos on this item the creator uploaded through FlowGuide. Authorized by
   *  construction: they have no source record and need none. */
  creatorUploaded?: string[];
  /** Zero-based position within its chunk's output, as EMITTED (0014's
   *  origin_emit_index). Optional so callers replaying a plan directly can omit
   *  it, but when present it is what proves the positional binding below is
   *  still describing the model's output rather than what survives today. */
  emitIndex?: number;
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

    // Positional binding says "the nth item is the nth head". That is only a
    // FACT about the model's output; `idxs` is what survives TODAY. Deleting an
    // item — an ordinary edit — silently shifts every later binding by one and
    // turns correct placements into confident, wrong "move it to X" proposals.
    // So when emission indices are recorded, require them to be intact: exactly
    // 0..n-1 with no gap. A gap means rows were removed and the correspondence
    // is no longer something we know.
    const emits = idxs.map((i) => producedItems[i].emitIndex);
    const emitsKnown = emits.every((e) => e !== undefined);
    const emitsIntact = !emitsKnown ||
      [...emits as number[]].sort((a, b) => a - b).every((e, n) => e === n);

    if (heads.length === idxs.length && emitsIntact) {
      // Source order is preserved, so the nth item corresponds to the nth head.
      // Bind in EMITTED order when known, not in whatever order rows arrived.
      const ordered = emitsKnown
        ? [...idxs].sort((a, b) => producedItems[a].emitIndex! - producedItems[b].emitIndex!)
        : idxs;
      ordered.forEach((itemIdx, n) => { bindings[itemIdx] = heads[n].i; });
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
        detail: emitsIntact
          ? `chunk ${chunk.ordinal} begins ${heads.length} records but produced ${idxs.length} items, so ownership cannot be established structurally`
          : `chunk ${chunk.ordinal} is missing items from its original output, so the remaining ones cannot be matched to records by position`,
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
    // An item may legitimately hold the same URL twice — that is what a source
    // listing it twice SHOULD produce. Reporting it twice would be two
    // indistinguishable findings the professional cannot act on separately.
    const seen = new Set<string>();
    const uploaded = new Set(it.creatorUploaded ?? []);
    for (const url of it.photos) {
      if (!isMediaUrl(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      // CREATOR-SUPPLIED: the professional uploaded this file themselves, so
      // ownership is settled at the point of upload and no source record is
      // required. Stated here rather than left to fall through the
      // "absent from source" branch below, which would make it incidental -
      // true only for as long as nothing else changes.
      if (uploaded.has(url)) continue;
      const sourceRecords = byUrl.get(url);
      if (!sourceRecords || sourceRecords.length === 0) continue; // accounting's job
      const distinct = [...new Set(sourceRecords)];
      if (distinct.includes(rec)) continue;                       // correct owner

      // The SAME url in two DIFFERENT records is genuinely ambiguous: the source
      // itself does not say which one this copy belongs to. Picking the first
      // would be a guess, and `includes(rec)` would silence a real finding
      // whenever the item happened to bind to either. Ambiguity is review.
      if (distinct.length > 1) {
        findings.push({
          code: "ownership_unverifiable",
          url,
          itemIndex: i,
          itemTitle: it.title,
          detail: `the source lists this photo under ${distinct.length} different records, so which one owns this copy cannot be established`,
        });
        continue;
      }

      const expected = distinct[0];
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
