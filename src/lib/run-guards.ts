// Run-level outcome guards.
//
// Per-chunk validation cannot see this class of failure. Every chunk can report
// success while the RUN as a whole produced nothing: a segment that legally
// returns an empty result is correct in isolation, but a new-packet import where
// EVERY segment returned empty is a silent total loss. The professional gets an
// empty packet and no error, which is the same shape of failure as the media
// incidents — absence, which no per-value check can detect.

/** Text that a person could actually structure into an entry: letters, once
 *  URLs are removed. Media-only text is real input but yields no entry, which is
 *  why the model is now allowed to return nothing for it. */
export function usableTextLength(source: string): number {
  return (source || "").replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}]/gu, "").length;
}

export type RunOutcomeCode = "run_produced_nothing";

export interface RunOutcomeFinding {
  code: RunOutcomeCode;
  summary: string;
  usableChars: number;
}

/**
 * MODE-AWARE by design.
 *
 * An `organize` run creates the packet's content: if the source held something
 * structurable and the run produced no items, the import failed, whatever the
 * chunks reported.
 *
 * An `append` or `section_append` run is reconciliation. It may legitimately add
 * zero NEW items — attaching photos, contacts or detail to entries that already
 * exist is a valid outcome, and demanding a new item would push the model back
 * toward inventing one. That is the pressure that produced `Primrose Photo 4`.
 */
export function checkRunOutcome(opts: {
  entryPoint: string;
  source: string;
  itemsCreated: number;
}): RunOutcomeFinding | null {
  if (opts.entryPoint !== "organize") return null;
  if (opts.itemsCreated > 0) return null;
  const usableChars = usableTextLength(opts.source);
  if (usableChars < 40) return null; // nothing structurable was ever provided
  return {
    code: "run_produced_nothing",
    // The WHAT only. The way out is describeReviewExit's job (review-exit.ts),
    // so the two never stack into "Discard it and try again. Discard this import…".
    summary: "The import finished without creating anything from your text.",
    usableChars,
  };
}
