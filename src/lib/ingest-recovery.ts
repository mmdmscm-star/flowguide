import { buildMediaLedger } from "./media-ledger.ts";

// RECOVERING A RUN WHOSE STRUCTURAL GUARD TRIPPED.
//
// finalize refuses when packets.structural_rev has moved since the run began
// (0034). That refusal is correct — something in the packet's structure changed
// while AI was working — but it used to be TERMINAL: the run stayed active, the
// completed work was unreachable, and the only exit was discarding it.
//
// The professional gets a choice instead. This module decides whether that
// choice may be OFFERED, because "apply anyway" must never succeed at finalize
// and then leave the FlowGuide unpublishable.

/** Exactly the delimiter finalize_ingestion_run concatenates with (0026). A
 *  second copy of a literal is a drift risk, so a test asserts the projection
 *  below equals the raw_input finalize actually writes. */
export const APPEND_DELIMITER = "\n\n--- Added ---\n\n";

/**
 * The `raw_input` this run will leave behind, mirroring finalize's own branch:
 * an `organize` run REPLACES raw_input with its source; every other entry point
 * CONCATENATES onto what is already there.
 *
 * This matters more than it looks. Media accounting compares stored photos
 * against raw_input, and raw_input ACCUMULATES across runs — so a photo from an
 * earlier import is accounted for by the earlier source, not by this run's.
 * Judging against this run's source alone reports every historical photo as
 * `media_not_in_source` and refuses recovery on ordinary FlowGuides.
 */
export function projectRawInput(
  entryPoint: string,
  currentRawInput: string | null | undefined,
  runSourceText: string | null | undefined,
): string {
  const src = String(runSourceText ?? "");
  if (entryPoint === "organize") return src;
  const cur = String(currentRawInput ?? "");
  return cur + APPEND_DELIMITER + src;
}

export type RecoveryBlocker =
  | { code: "target_section_missing" }
  | { code: "media_not_in_source"; urls: string[] };

export interface RecoveryVerdict {
  /** May the professional be offered "Add the organized content"? */
  canApply: boolean;
  blockers: RecoveryBlocker[];
}

/**
 * Whether a tripped run can be reconciled by re-baselining and finalizing.
 *
 * ONLY `media_not_in_source` BLOCKS. `media_missing` and `media_duplicated` are
 * expected here and must not block: this runs BEFORE the run applies, so the
 * photos the source promises are legitimately not stored yet. Treating every
 * ledger failure as a blocker refuses recovery on a perfectly clean packet.
 */
export function assessRecovery(input: {
  entryPoint: string;
  rawInput: string | null | undefined;
  sourceText: string | null | undefined;
  storedPhotos: Array<{ url: string; itemId: string }>;
  /** section_append only: does the run's target section still belong to this
   *  packet? Undefined for entry points that have no named destination. */
  targetSectionValid?: boolean;
}): RecoveryVerdict {
  const blockers: RecoveryBlocker[] = [];

  // A section_append has a NAMED destination. If it is gone there is nowhere
  // correct to put the items, and quietly choosing another section would be
  // worse than refusing. finalize and rebaseline both re-check this; the UI
  // must not offer an action that can only fail.
  if (input.entryPoint === "section_append" && input.targetSectionValid === false) {
    blockers.push({ code: "target_section_missing" });
  }

  const source = projectRawInput(input.entryPoint, input.rawInput, input.sourceText);
  const ledger = buildMediaLedger({ source, stored: input.storedPhotos });
  const orphaned = ledger.failures
    .filter((f) => f.code === "media_not_in_source")
    .map((f) => f.url);
  if (orphaned.length > 0) blockers.push({ code: "media_not_in_source", urls: orphaned });

  return { canApply: blockers.length === 0, blockers };
}

/** What the professional reads. Says what changed, what will happen, and — when
 *  recovery is refused — why, in terms of the thing they did. */
export function recoveryMessage(v: RecoveryVerdict): string {
  if (v.canApply) {
    return "This Sendset changed while AI was working, so the organized content wasn’t added automatically. Nothing has been lost — you can add it now, after your existing sections.";
  }
  const target = v.blockers.find((b) => b.code === "target_section_missing");
  if (target) {
    return "The section this content was being added to no longer exists, so it can’t be added automatically. Discard this import and run it again on the section you want.";
  }
  const media = v.blockers.find((b) => b.code === "media_not_in_source") as
    { code: "media_not_in_source"; urls: string[] } | undefined;
  const n = media?.urls.length ?? 0;
  return `This Sendset changed while AI was working, and ${n === 1 ? "a photo was" : `${n} photos were`} added that ${n === 1 ? "isn’t" : "aren’t"} part of the information you gave Sendset. Adding the organized content now would leave this Sendset unpublishable. Remove ${n === 1 ? "that photo" : "those photos"}, or discard this import and run it again.`;
}
