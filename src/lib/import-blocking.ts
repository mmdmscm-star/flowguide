// WHEN DOES AN IMPORT BLOCK PUBLISHING?
//
// Stated once, because three routes ask it (reconnecting to a run, refusing a
// second import, refusing to publish) and a database function will ask it too
// (0051: public.packet_has_blocking_run). They must never disagree.
//
// A run blocks while it is non-terminal — active, finalizing, needs_review — and
// ALSO while it is finalized with its review still PENDING.
//
// WHY PENDING EXISTS. finalize_ingestion_run commits the imported content, and
// only afterwards does the finalize route work out whether that content needs a
// decision (media accounting, held units, an empty run). Before 0051 the run was
// `finalized` in that gap, so a publish landing there skipped the review gate
// entirely. 0051 makes the finalize function set `review = {pending: true}` in
// the same transaction as `finalized`; the route then replaces the marker with
// the decided review. Until it does, the run blocks.
//
// A pending run whose accounting keeps failing stays pending — deliberately.
// See docs/migrations/0051-review-pending.md for that limitation.

export const BLOCKING_RUN_STATUSES = ["active", "finalizing", "needs_review"] as const;

/** A PostgREST `or` filter selecting exactly the runs that block publishing. */
export const BLOCKING_RUN_FILTER =
  `status.in.(${BLOCKING_RUN_STATUSES.join(",")}),and(status.eq.finalized,review->pending.eq.true)`;

export type RunReviewState = { status?: string | null; review?: unknown };

function reviewObject(review: unknown): Record<string, unknown> | null {
  return review && typeof review === "object" && !Array.isArray(review)
    ? (review as Record<string, unknown>)
    : null;
}

/** The finalize function has applied the run but nobody has decided its review. */
export function isReviewPending(review: unknown): boolean {
  return reviewObject(review)?.pending === true;
}

export function runBlocksPublishing(run: RunReviewState | null | undefined): boolean {
  if (!run?.status) return false;
  if ((BLOCKING_RUN_STATUSES as readonly string[]).includes(run.status)) return true;
  return run.status === "finalized" && isReviewPending(run.review);
}

/**
 * A finalized run whose review has not been decided: the pending marker, or the
 * `{}` every run held before 0051. The finalize route writes its verdict only
 * onto a run in this state, so a replay can never overwrite a decision.
 */
export function isReviewUndecided(run: RunReviewState | null | undefined): boolean {
  if (run?.status !== "finalized") return false;
  const review = reviewObject(run.review);
  return !review || !("ok" in review);
}
