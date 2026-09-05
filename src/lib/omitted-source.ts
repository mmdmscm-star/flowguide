// WHAT THE SOURCE SAID AND THE ITEM DOES NOT.
//
// `reconcile` has always counted orphaned fragments and nothing has ever read
// the count. On the real Spring Lake run that silence cost four material
// pricing qualifiers — annual increases, personal-assistance charges, the
// Community Fee's refundability, the April 1 2026 effective date — and five
// bullets, none of which appeared anywhere the professional could see.
//
// THE QUESTION IS ASKED ONCE, ABOUT THE RUN. Asking it per chunk is what makes
// it useless: measured on that run, the chunk-local test finds 58 orphans, of
// which most are not omissions at all. An amenity bullet is "missing" from its
// own chunk's proposal and present in the packet two chunks later; a
// transcription line-wrap — "charging port", "paths and beautiful
// resident-tended gardens" — is a fragment with no independent existence. Asked
// once, against the item that would actually publish, the same run yields 11.
//
//   58 chunk-local apparent orphans  ->  11 real run-level omissions
//
// So this takes the ASSEMBLED item, after the keep_together collapse and before
// anything is written, and reports what is genuinely absent from it.
//
// NO MODEL, NO GENERATED TEXT. The lines returned are verbatim slices of the
// professional's own source, produced by the same deterministic parser
// enforcement used and filtered by the same presence test the reconciler uses.
// Nothing here writes prose, ranks, summarises, or decides what a line means.

import { parseClaims } from "./claim-parser.ts";
import { inferDelimiter } from "./attribution.ts";
import { survives, isRecipientVisible, FIELDS, type Field } from "./placement.ts";

export interface SourceSegment {
  ordinal: number;
  segmentText: string;
}

/** What the client will actually see.
 *
 *  A PRIVATE NOTE IS NOT SURVIVAL. The question this module asks is not "is
 *  this text anywhere in the item" but "did it reach the person the Sendset was
 *  prepared for" — and `notes` is the one field whose entire meaning is that
 *  they never see it. Counting it would make the check agree that a pricing
 *  qualifier survived while the client reads the price without it, which is the
 *  exact failure it exists to catch.
 *
 *  Removal is driven by placement.ts's own RECIPIENT_VISIBLE map rather than by
 *  naming `notes` here, so a field that becomes private later stops counting
 *  without anyone remembering to come back. An unrecognised key is KEPT: the
 *  map knows which fields are private, and `highlight` — client-facing, and not
 *  in the Field enum — must not be dropped by a whitelist. */
export function recipientVisible(item: Record<string, unknown>): Record<string, unknown> {
  const known = new Set<string>(FIELDS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item ?? {})) {
    if (known.has(k) && !isRecipientVisible(k as Field)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Source lines that survive nowhere in the assembled item.
 *
 * PARSED THE WAY ENFORCEMENT PARSED IT — per segment, with the run's own
 * delimiter. Re-parsing the whole source instead would produce a different
 * fragment set than the one the contract actually saw, which is how two
 * adjacent bullets came to be read as a claim.
 *
 * PRESENCE IS `survives`, DELIBERATELY. It is the same tolerant test reconcile
 * uses for orphans: a line the model legitimately reworded, split between a
 * title and an address, or folded into a description is accounted for and is
 * not reported. Only genuinely absent content is returned — the alternative,
 * exact matching, would report most of a healthy import.
 *
 * AND IT IS ASKED OF THE RECIPIENT-VISIBLE ITEM ONLY. A line the model filed in
 * the private note reached the creator and not the client, so for a question
 * about what the client will read it did not survive.
 *
 * Order is source order; exact duplicates collapse, because one line written
 * twice is one omission.
 */
export function omittedSourceLines(
  segments: SourceSegment[], item: Record<string, unknown> | null | undefined,
  opts: { sourceText: string; delimiterHint?: string | null } = { sourceText: "" },
): string[] {
  // NOTHING TO COMPARE AGAINST IS NOT THE SAME AS EVERYTHING BEING MISSING.
  // A run that produced no item has its own failure (checkRunOutcome); calling
  // every line of the source an omission on top of that would bury it.
  if (!item) return [];
  const delimiter = inferDelimiter(opts.sourceText ?? "", opts.delimiterHint ?? null);
  // Judged against what the client sees, never against the creator's own notes.
  const visible = recipientVisible(item as Record<string, unknown>);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments ?? []) {
    const text = String(seg?.segmentText ?? "");
    if (!text) continue;
    for (const f of parseClaims(text, Number(seg.ordinal) || 0, { delimiter }).fragments) {
      const line = String(f?.text ?? "").trim();
      if (!line || seen.has(line)) continue;
      if (survives(visible, line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/** The one excerpt shown on the one card. Verbatim lines, in source order, one
 *  per line — no numbering, no headings, nothing written about them. */
export function omittedExcerpt(lines: string[]): string {
  return (lines ?? []).map((l) => String(l ?? "").trim()).filter(Boolean).join("\n");
}

/** The one run-level unit, or a reason it could not be decided.
 *
 *  FAIL CLOSED. This check is now the only thing standing between a source
 *  qualifier and silent loss, so "it threw, carry on" is not a safe default —
 *  it publishes a Sendset while reporting that everything passed. A detector
 *  failure is neither an omission nor an absence of one; it is an unanswered
 *  question, and the caller must stop rather than convert it into either.
 *
 *  It is a RESULT rather than a thrown error so the caller cannot accidentally
 *  swallow it in a catch that was written for something else. */
export type OmissionOutcome =
  | { ok: true; lines: string[]; text: string }
  | { ok: false; message: string };

export function buildOmission(
  segments: SourceSegment[], item: Record<string, unknown> | null | undefined,
  opts: { sourceText: string; delimiterHint?: string | null },
): OmissionOutcome {
  try {
    const lines = omittedSourceLines(segments, item, opts);
    return { ok: true, lines, text: omittedExcerpt(lines) };
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? "omission check failed" };
  }
}
