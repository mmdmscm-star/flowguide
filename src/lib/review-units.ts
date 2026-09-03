import { createHash } from "node:crypto";
import type { UnresolvedUnit } from "./enforce-chunk.ts";

// TWO KINDS OF "UNRESOLVED", AND THEY ARE NOT THE SAME THING.
//
// 1. REVIEW-REQUIRED PRODUCT EXCEPTION
//    A known contract violation where source content would otherwise be
//    silently hidden, lost, or treated unsafely, AND a professional decision is
//    required to settle it. These persist into `ingestion_runs.review`, they
//    block publishing, and the creator is shown the verbatim source.
//    Today: privacy_rejected.
//
// 2. OBSERVED-UNRESOLVED TELEMETRY
//    The deterministic layer recognized potentially meaningful source material
//    but cannot prove enough to demand a specific decision. These stay in
//    accounting and evidence. They do not block publishing and they are not
//    shown as a question.
//    Today: ambiguous unlabelled pricing (SOURCE_UNRESOLVED).
//
// The distinction is the whole point. Promoting every uncertainty into the
// review UI to make the accounting visible would produce review fatigue and
// teach people to click through warnings - which costs more than the accounting
// is worth. The registry below is what keeps the line drawn on purpose rather
// than by whichever code path happened to be written first.
//
// TO ADD A FUTURE EXCEPTION (a proven attribution conflict, say): add an entry
// to REVIEW_REQUIRED with its own code and guidance. Nothing else needs to
// change - the route, the RPC and the panel are all driven from this registry.
// The bar for entry is PROOF, not suspicion: if the layer cannot show that
// something would be hidden, lost or unsafe, it belongs in OBSERVED_ONLY.

export interface ExceptionKind {
  /** Stable, persisted discriminator. Never reuse one for a different meaning. */
  code: string;
  /** What the professional is being asked, in their language. */
  guidance: string;
  /** WHICH DECISIONS THIS KIND CAN HONESTLY OFFER.
   *
   *  The panel used to render all three for every kind, which was fine while
   *  every kind was a question about a private note. It stopped being fine the
   *  moment a kind held a bundle of RECIPIENT-facing material: offering "keep as
   *  private note" there proposes writing a venue's public description, address,
   *  pricing and contact names into a creator-only field, which is not what the
   *  card is about and not what the button appears to promise.
   *
   *  Omit to offer all three. */
  dispositions?: ReviewDisposition[];
}

/** What a professional can decide about one unit.
 *
 *  `kept_private` is the only one that CHANGES anything: it writes the excerpt
 *  into that item's creator-only notes. The other two settle the question —
 *  one asserting the professional placed the material themselves, one
 *  discarding it deliberately. */
export type ReviewDisposition = "kept_private" | "resolved" | "ignored";

// WHICH KINDS MAY OFFER "KEEP AS PRIVATE NOTE", AND WHY.
//
// Exactly one question decides it: is the held material a PRIVATE-NOTE
// PROPOSAL, so that filing it privately is one of the real answers?
//
//   privacy-rejected      yes — the model made it private without authority,
//                         and "actually, it is private" is a real answer.
//   unbound-private-note  yes — it IS a private note; only its provenance is
//                         unproven.
//   audience-undecided    yes — the source parked the audience, and private is
//                         one of the two answers the professional can give.
//   private-shown         yes — the source marks it private and no private copy
//                         exists, so keeping one is the point.
//
//   cross-cell-detail          NO — a real fact with a neighbour's columns run
//                              onto it. A placement problem, not a privacy one.
//   unbound-recipient-content  NO — a bundle written for the client.
//
// The second group are placement and content-integrity decisions. Offering to
// file them privately would hide material from the person it was written for,
// on the button that reads like the careful choice.
export const REVIEW_REQUIRED: Record<string, ExceptionKind> = {
  "privacy-rejected": {
    code: "privacy_rejected",
    guidance:
      "This was written as a private note, but nothing in your source marks it private — " +
      "so your client would never see it. What should Sendset do with it?",
  },
  // THE SOURCE SAID IT HAD NOT DECIDED YET.
  //
  // `Planner Notes — Audience Not Yet Decided` is a column heading that asks a
  // question rather than answering one. Neither existing kind can say that
  // honestly: `privacy-rejected` would claim the source marks nothing private,
  // which is true but beside the point, and would invite "leave it out" for a
  // judgment the professional explicitly parked. So it gets its own sentence.
  //
  // It surfaces from WHEREVER the model put it. The one thing that must not
  // happen is the model's choice of field settling an audience the source left
  // open — private on one venue and client-facing on the next, from one import.
  "audience-undecided": {
    code: "audience_undecided",
    guidance:
      "Your file marks this as not yet decided for sharing, so Sendset has not " +
      "shown it to your client or filed it as a private note. Which is it?",
  },
  // PRIVATE SOURCE CONTENT THAT WAS ABOUT TO BE VISIBLE, AND IS HELD NOWHERE ELSE.
  //
  // The ordinary case needs no question: if the same content is already in the
  // item's private notes, the visible copy is a duplicate and is simply removed.
  // This kind is the remainder — the content would be LOST by that removal, and
  // losing it silently is the one outcome worse than asking.
  "private-shown": {
    code: "private_shown",
    guidance:
      "Your source marks this private, but it was written where your client would " +
      "see it and Sendset found no private copy of it. What should happen to it?",
  },
  // A PROPOSAL THAT COULD NOT BE PLACED IN THE SOURCE AT ALL.
  //
  // The same principle as `unbound-private-note`, applied to the other
  // direction. Failing to establish provenance must not silently authorise
  // recipient-facing content either: if FlowGuide cannot say which row of the
  // file this venue is, it cannot vouch for the facts written about it, and
  // publishing them anyway is the escape hatch the whole contract exists to
  // close. Measured on two real imports, an unbound proposal carried a
  // NEIGHBOURING record's email, phone and website often enough that this is a
  // live risk rather than a theoretical one.
  //
  // ONE CARD PER ITEM, carrying everything withheld, because the professional is
  // making a single decision about one venue — not a decision per detail.
  "unbound-recipient-content": {
    code: "unbound_recipient_content",
    guidance:
      "Sendset couldn't reliably tell which source record this information belongs to, " +
      "so it left it out rather than risk showing it under the wrong item. " +
      "Everything proposed is kept here until you decide.",
    // NOT A PRIVATE-NOTE DECISION. What is held is a mixed bundle of material
    // meant for the CLIENT — description, address, priced details, a contact's
    // name. Filing that privately would hide the whole item from the person it
    // was written for, on a button that reads like a safe choice. The two
    // honest actions are: the professional put it where it belongs, or they
    // decided it does not belong in this FlowGuide.
    dispositions: ["resolved", "ignored"],
  },
  // A DETAIL THAT RAN PAST ITS OWN COLUMN.
  //
  // This is NOT `privacy-rejected` wearing a different label. That kind asks
  // about text the model chose to hide; this one is about text the model chose
  // to SHOW, which turned out to include a neighbouring column — in the venue
  // import, another venue's address and contact, and in three cases the source's
  // own private-notes column. The question the professional is being asked is a
  // different question, so it gets its own sentence rather than a borrowed one
  // that would have described it falsely.
  //
  // AND IT IS NOT A PRIVATE-NOTE DECISION EITHER, which an earlier version of
  // this comment got wrong. The excerpt is a real fact with a neighbour's
  // columns run onto the end of it — "$350" followed by another firm's address
  // and availability. Offering to file that privately proposes hiding a price
  // the client is supposed to see, in order to deal with text that should never
  // have been attached to it. The two honest answers are the same as for held
  // recipient content: the professional put the fact where it belongs, or it
  // does not belong here. Nothing is truncated or repaired on their behalf.
  // A PRIVATE NOTE ON A PROPOSAL THAT COULD NOT BE PLACED IN THE SOURCE.
  //
  // Reuse of `privacy-rejected` was considered first and rejected, because its
  // sentence would be FALSE here. It tells the professional "nothing in your
  // source marks it private" — and for the contractor import, the source marks
  // that column `INTERNAL ONLY` and plainly does. What is missing is not the
  // marker but the PROOF that this note is that row's, because a neighbouring
  // proposal carried the same firm's email, phone and website.
  //
  // Getting that sentence wrong is not cosmetic: a professional told their
  // source says nothing could reasonably answer "leave it out" and discard a
  // note their file did mark internal. So the decision is the same and the
  // three dispositions are the same; only the explanation differs, which is
  // exactly what a separate kind is for.
  "unbound-private-note": {
    code: "unbound_private_note",
    guidance:
      "Sendset could not tell which row of your file this note came from, so it " +
      "could not confirm your source meant to keep it private. What should happen to it?",
  },
  "cross-cell-detail": {
    code: "cross_cell_detail",
    guidance:
      "This detail ran past its own column in your file and picked up text from " +
      "elsewhere in the source, so Sendset did not show it to your client. " +
      "What should happen to it?",
    dispositions: ["resolved", "ignored"],
  },
};

/** Recognized, recorded, and deliberately NOT a question. */
export const OBSERVED_ONLY: Record<string, string> = {
  "source-unresolved": "a value the reconciler could not bind to a claim",
};

export const REVIEW_REQUIRED_CODES = new Set(Object.values(REVIEW_REQUIRED).map((e) => e.code));

/** Fail closed on an unrecognized kind: something the layer produced but nobody
 *  classified is, by definition, not proven safe to hide. A source test asserts
 *  every kind is classified explicitly, so this should never fire in practice -
 *  it is here so that if it ever does, the answer is a question rather than
 *  silence. */
export function isReviewRequired(kind: string): boolean {
  if (kind in REVIEW_REQUIRED) return true;
  if (kind in OBSERVED_ONLY) return false;
  return true;
}

export interface ReviewFailure {
  id: string;
  code: string;
  kind?: string;
  record?: number;
  chunk?: number;
  title?: string | null;
  /** The verbatim source excerpt. Present ONLY while unresolved - the RPC
   *  removes it on resolve or ignore. */
  text?: string;
  reason?: string;
  itemIds?: string[];
  status?: string;
  resolved_at?: string;
}

/** Deterministic, content-derived, stable across reloads and replays.
 *  A positional id would move whenever anything else in the array changed, and
 *  a stale client would then clear a different unit than the one on screen. */
export function unitId(
  runId: string,
  u: { chunk: number; record: number; kind: string; text: string },
): string {
  return "u_" + createHash("sha256")
    .update([runId, u.chunk, u.record, u.kind, u.text].join(" "))
    .digest("hex").slice(0, 16);
}

/** Units produced by enforcement for ONE chunk, reduced to the review-required
 *  ones and stamped with stable ids. Written to `ingestion_chunks.review_units`
 *  by the enforcement path; `fact_ledger` keeps the full telemetry. */
export function buildReviewUnits(
  runId: string, chunk: number, units: UnresolvedUnit[],
): ReviewFailure[] {
  const out = new Map<string, ReviewFailure>();
  for (const u of units) {
    if (!isReviewRequired(u.kind)) continue;
    const text = String(u.text ?? "").trim();
    if (!text) continue;
    const id = unitId(runId, { chunk, record: u.record, kind: u.kind, text });
    if (out.has(id)) continue;      // one excerpt on one record is one decision
    out.set(id, {
      id, code: REVIEW_REQUIRED[u.kind]?.code ?? "unclassified_exception",
      kind: u.kind, record: u.record, chunk,
      title: u.title ?? null, text, reason: u.reason, status: "unresolved",
    });
  }
  return [...out.values()];
}

/** Finalize's half: attach the item a unit belongs to, once items exist. */
export function attachItems(
  units: ReviewFailure[], itemIdByTitle: Map<string, string[]>,
): ReviewFailure[] {
  return units.map((f) => {
    const ids = f.title ? itemIdByTitle.get(f.title) : undefined;
    // An ambiguous title must not name a specific item. The title is shown
    // either way, so the professional still knows what they are looking at;
    // pointing at the wrong item would be worse than pointing at none.
    return ids && ids.length === 1 ? { ...f, itemIds: ids } : f;
  });
}

/** A failure the professional can actually decide. Everything else - a missing
 *  photo, a run that produced nothing - has its own remediation and keeps its
 *  existing exit. */
export function isResolvable(f: ReviewFailure): boolean {
  return REVIEW_REQUIRED_CODES.has(f?.code) && typeof f?.id === "string" && f.id.length > 0;
}

/** The decisions a kind can honestly offer. Registry-driven for the same reason
 *  the guidance is: a future kind arrives with its own answer set, and the panel
 *  does not have to know the difference. */
const ALL_DISPOSITIONS: ReviewDisposition[] = ["kept_private", "resolved", "ignored"];
export function dispositionsFor(f: ReviewFailure): ReviewDisposition[] {
  return REVIEW_REQUIRED[f?.kind ?? ""]?.dispositions ?? ALL_DISPOSITIONS;
}

/** The sentence shown with a held unit, from the registry rather than the panel,
 *  so a future exception arrives with its own wording. */
export function guidanceFor(f: ReviewFailure): string {
  return REVIEW_REQUIRED[f?.kind ?? ""]?.guidance
    ?? "This needs a decision before publishing.";
}

/** Mirrors the RPC's count exactly: a failure with no `status` key is legacy
 *  and counts as OUTSTANDING. Reading a missing status as "handled" would let a
 *  run finalize with real work still in it. */
export function unresolvedCount(failures: ReviewFailure[] | undefined): number {
  return (failures ?? []).filter((f) => (f?.status ?? "unresolved") === "unresolved").length;
}

/** True when a remaining blocker is one of the non-resolvable kinds, i.e. the
 *  per-unit controls cannot clear this run and discard is still the exit. */
export function hasUnresolvableBlocker(failures: ReviewFailure[] | undefined): boolean {
  return (failures ?? []).some((f) => !isResolvable(f) && (f?.status ?? "unresolved") === "unresolved");
}
