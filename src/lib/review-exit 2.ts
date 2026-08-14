// What discard will actually do to this packet, in the professional's language.
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

/** The way out, phrased for what will actually happen. */
export function describeReviewExit(d: PacketDisposition): string {
  return discardWouldDeletePacket(d)
    ? "Discard this import and try again — the empty packet will be removed."
    : "Discard the import to unblock publishing. Everything you can see stays.";
}
