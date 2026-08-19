// Pure decision logic for a Library AI import.
//
// The run machinery is shared with packet ingestion; what is specific to a
// Library import is (a) what phase a run is in when a professional reopens it,
// and (b) what order proposals are shown in. Both are here rather than in a
// route, because both are exactly the kind of rule that is easy to get subtly
// wrong and impossible to notice by reading.

import type { ItemContentPayload } from "./item-content.ts";

export interface ImportChunk {
  ordinal: number;
  sourceStart: number;
  status: string;
}

export interface Proposal extends ItemContentPayload {
  id: string;
  ordinal: number;
  idx: number;
  selected: boolean;
}

/** Where a run is when someone reopens the app. */
export type ImportPhase = "extracting" | "review" | "closed";

/**
 * Phase is DERIVED, never stored.
 *
 * A dedicated `awaiting_review` status would have to be added to the predicate
 * of both one-active indexes — a run being reviewed is emphatically non-terminal
 * — and forgetting either would let a professional start a second import while
 * reviewing the first. That is the failure 0013 had to repair for needs_review.
 * Deriving means there is no new non-terminal value any predicate can forget.
 */
export function derivePhase(
  runStatus: string,
  chunks: readonly ImportChunk[],
): ImportPhase {
  if (runStatus !== "active") return "closed";
  if (chunks.length === 0) return "extracting";
  // A split parent is represented by its children and is not outstanding work.
  const outstanding = chunks.filter((c) => c.status !== "completed" && c.status !== "split");
  return outstanding.length === 0 ? "review" : "extracting";
}

/** Leaf chunks only — the ones the drive loop still has work for. */
export function pendingOrdinals(chunks: readonly ImportChunk[]): number[] {
  return chunks
    .filter((c) => c.status !== "completed" && c.status !== "split")
    .map((c) => c.ordinal)
    .sort((a, b) => a - b);
}

/**
 * SOURCE ORDER, not identity order.
 *
 * `(ordinal, idx)` is a proposal's IDENTITY — stable across reconnects, which is
 * what makes materialisation idempotent. It is NOT presentation order: when a
 * chunk is split, its children are appended with HIGHER ordinals while their
 * text belongs in the middle of the paste. Sorting by ordinal would drag those
 * items to the end of a review of forty, where they no longer line up with the
 * source the professional is reading against.
 *
 * So order comes from the chunk's position in the source, then position within
 * the chunk. A proposal whose chunk is unknown sorts last rather than throwing —
 * a missing chunk is a bug, but losing the item from the review is worse.
 */
export function orderProposals<T extends { ordinal: number; idx: number }>(
  proposals: readonly T[],
  chunks: readonly ImportChunk[],
): T[] {
  const startOf = new Map(chunks.map((c) => [c.ordinal, c.sourceStart]));
  return [...proposals].sort((a, b) => {
    const sa = startOf.get(a.ordinal);
    const sb = startOf.get(b.ordinal);
    if (sa === undefined || sb === undefined) {
      if (sa === undefined && sb === undefined) return a.ordinal - b.ordinal || a.idx - b.idx;
      return sa === undefined ? 1 : -1;
    }
    return sa - sb || a.idx - b.idx;
  });
}

/**
 * FINISH IS NOT ABANDON.
 *
 * Both close the run, and both drop whatever proposals remain — so the only
 * thing standing between "I am done" and losing work is being told what is about
 * to go. This computes that, and the finish route refuses without an explicit
 * acknowledgement whenever it is non-zero.
 */
export function unsavedAtFinish(proposals: readonly { selected: boolean }[]): {
  total: number; selected: number; needsAcknowledgement: boolean;
} {
  const total = proposals.length;
  const selected = proposals.filter((p) => p.selected).length;
  return { total, selected, needsAcknowledgement: total > 0 };
}
