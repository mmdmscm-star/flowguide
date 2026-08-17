// Recompute media ownership against the CURRENT packet.
//
// This is what migration 0014 exists for. Findings are never stored and replayed
// — they are re-derived from live rows every time they are shown, applied, or
// checked before publishing. That is the whole design: a professional who drags
// a photo onto the right item makes the finding disappear by fixing the thing
// itself, with no resolution state to go stale.
//
// The other half of the design is refusing to answer. Every offset here is an
// index into packets.raw_input, and raw_input has writers that replace it
// wholesale. So before emitting a single finding this proves the source it is
// reasoning about is still byte-for-byte the source the offsets were measured
// against. If it cannot prove that, it declines. A wrong ownership accusation
// against a packet the professional already fixed is worse than no check at all.

import { detectSourceRecords, segmentHash, SEGMENTER_VERSION } from "./segmentation.ts";
import { verifyOwnership, type ChunkRange, type ProducedItem, type OwnershipReport } from "./media-ownership.ts";

/** A run row, as persisted. */
export interface RunProvenance {
  id: string;
  sourceHash: string;
  sourceLen: number;
  segmenterVersion: string;
  /** NULL when unknown — pre-0014, or voided because raw_input was replaced. */
  sourceOffsetBase: number | null;
}

/** An item row plus its LIVE photos. */
export interface ItemProvenance {
  id: string;
  title: string;
  /** NULL for items created manually or before 0014. */
  originChunkOrdinal: number | null;
  originEmitIndex: number | null;
  photoUrls: string[];
}

export type DeclineReason =
  | "no_provenance"        // nothing in this packet records where it came from
  | "no_offset_base"       // the run predates 0014, or raw_input was replaced
  | "segmenter_changed"    // the plan was made by a different segmenter
  | "source_moved"         // raw_input is no longer what the offsets indexed
  | "source_not_tabular"   // prose: there are no records to own anything
  | "incomplete_provenance"; // some items carry a run but no chunk/emit index

export type RecomputeResult =
  | { status: "declined"; reason: DeclineReason; detail: string }
  | { status: "ok"; report: OwnershipReport; items: ItemProvenance[]; source: string };

/**
 * Re-derive ownership for one run's contribution to a packet.
 *
 * `items` must be every item currently attached to the packet that carries this
 * run's origin_run_id, with its CURRENT photo rows.
 */
export function recomputeOwnership(opts: {
  rawInput: string;
  run: RunProvenance;
  chunks: ChunkRange[];
  items: ItemProvenance[];
}): RecomputeResult {
  const { rawInput, run, chunks, items } = opts;

  if (items.length === 0) {
    return { status: "declined", reason: "no_provenance",
      detail: "no item in this packet records the run that created it" };
  }
  if (run.sourceOffsetBase === null || run.sourceOffsetBase === undefined) {
    return { status: "declined", reason: "no_offset_base",
      detail: "this run has no recorded offset base, so its chunk ranges cannot be located in the packet source" };
  }
  if (run.segmenterVersion !== SEGMENTER_VERSION) {
    // The plan was produced by different boundary rules. Re-deriving records
    // with today's rules against yesterday's chunk ranges would compare two
    // different partitions of the same text.
    return { status: "declined", reason: "segmenter_changed",
      detail: `the plan was made by ${run.segmenterVersion}, this build is ${SEGMENTER_VERSION}` };
  }

  // THE LOAD-BEARING CHECK. Everything downstream is offset arithmetic against
  // this slice; if it is not the exact text the offsets were measured against,
  // every conclusion is fiction.
  const base = run.sourceOffsetBase;
  const source = (rawInput || "").slice(base, base + run.sourceLen);
  if (source.length !== run.sourceLen || segmentHash(source) !== run.sourceHash) {
    return { status: "declined", reason: "source_moved",
      detail: "the packet source no longer matches what this run was planned against" };
  }

  const incomplete = items.filter((i) => i.originChunkOrdinal === null || i.originEmitIndex === null);
  if (incomplete.length > 0) {
    return { status: "declined", reason: "incomplete_provenance",
      detail: `${incomplete.length} item(s) record a run but not a chunk, so they cannot be bound` };
  }

  const detected = detectSourceRecords(source);
  if (!detected) {
    // Prose has no record structure, so there is nothing for a photo to be
    // "on the wrong one" OF. Silence here is honest, not a pass.
    return { status: "declined", reason: "source_not_tabular",
      detail: "this source has no detectable record structure, so ownership is not defined for it" };
  }

  // Emission order, NOT sort_order — the professional owns sort_order and
  // /api/reorder rewrites it freely. This is exactly why 0014 records the index.
  const ordered = [...items].sort((a, b) =>
    (a.originChunkOrdinal! - b.originChunkOrdinal!) || (a.originEmitIndex! - b.originEmitIndex!));

  const producedItems: ProducedItem[] = ordered.map((i) => ({
    chunkOrdinal: i.originChunkOrdinal!,
    title: i.title,
    photos: i.photoUrls,
  }));

  return {
    status: "ok",
    report: verifyOwnership({ source, records: detected.records, chunks, producedItems }),
    items: ordered,
    source,
  };
}

/** Findings that block publishing, resolved to real item ids. */
export interface ResolvedFinding {
  code: string;
  url?: string;
  itemId: string;
  itemTitle: string;
  /** Present only when exactly one destination is resolvable. */
  proposedItemId?: string;
  proposedItemTitle?: string;
  detail: string;
}

/** Map a report's array indices onto the item ids the UI and RPCs need. */
export function resolveFindings(result: RecomputeResult): ResolvedFinding[] {
  if (result.status !== "ok") return [];
  return result.report.findings.map((f) => {
    const item = result.items[f.itemIndex];
    const dest = f.proposedItemIndex !== undefined ? result.items[f.proposedItemIndex] : undefined;
    return {
      code: f.code,
      ...(f.url ? { url: f.url } : {}),
      itemId: item?.id ?? "",
      itemTitle: f.itemTitle,
      ...(dest ? { proposedItemId: dest.id, proposedItemTitle: dest.title } : {}),
      detail: f.detail,
    };
  });
}
