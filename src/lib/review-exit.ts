// What discard will actually do to this packet, in the professional's language.
//
// It clears the `needs_review` block and nothing else. Discard abandons the
// SOURCE, not the content the run already wrote — the photos it placed stay
// exactly where they are, so a media-ownership finding survives it untouched.
// The copy must not promise publishing is unblocked when a second, independent
// gate may still be holding it.
//
// `needs_review` blocks publishing, and discard is the way out. But discard is
// not one behaviour: `discard_ingestion_run` (migration 0012) DELETES the packet
// when it is the empty draft this very run created, and PRESERVES it in every
// other case. Those are opposite outcomes, and a safety state that misdescribes
// the consequence of its own exit teaches a professional not to trust the exit.
//
// So this mirrors the SQL's condition exactly rather than guessing from the kind
// of failure. If the SQL's predicate ever changes, this must change with it.

export interface PacketDisposition {
  entryPoint: string;
  /** packets.origin_ingestion_run_id — is this the run that created the packet? */
  isOriginRun: boolean;
  /** packets.status */
  isDraft: boolean;
  /** sections + items + blocks all zero, matching the SQL's three counts. */
  isEmpty: boolean;
}

/** True when discard_ingestion_run would delete the packet outright. */
export function discardWouldDeletePacket(d: PacketDisposition): boolean {
  return d.entryPoint === "organize" && d.isOriginRun && d.isDraft && d.isEmpty;
}

/** The way out, phrased for what will actually happen.
 *
 *  When every outstanding failure is one the professional can DECIDE, discard
 *  stops being the only exit and stops being the honest sentence: telling
 *  someone to throw away the import when two clicks would clear it is how a
 *  safety state gets read as a malfunction. `allResolvable` is passed only when
 *  that is true of every remaining unit. */
export function describeReviewExit(d: PacketDisposition, opts?: { allResolvable?: boolean }): string {
  if (opts?.allResolvable) {
    return "Decide what to do with each piece below. Once every one is handled, publishing is unblocked.";
  }
  return discardWouldDeletePacket(d)
    ? "Discard this import and try again — the empty packet will be removed."
    : "Discard the import to clear this review. Everything you can see stays — discarding abandons the source, not the photos it already placed.";
}
