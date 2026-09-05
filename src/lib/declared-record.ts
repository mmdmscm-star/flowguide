// THE RECORD THE CREATOR DECLARED.
//
// Automatic attribution answers "which source record does this proposal come
// from?" by matching anchors — an email, a URL hostname, a phone number unique
// to one record. A photographed pricing sheet has none of those, so under
// `keep_together` the answer was previously "no records at all": env was null,
// bindByProvenance was skipped, byRecord stayed empty, and enforceItem never
// ran. Production proved it — itemsGoverned: 0 on all six chunks of the Spring
// Lake run, stripped: 0, and not one review unit.
//
// That was a hole, not a design. The creator declaring "this source is ONE
// thing" is not the absence of provenance; it IS provenance, supplied by the
// person who owns the document instead of inferred from its punctuation. So it
// supplies the record association directly, and every proposal for that record
// is governed exactly as a bound proposal is under auto.
//
// NOTHING HERE WEAKENS bindByProvenance. It is not called, not modified, and
// not consulted: anchor matching remains the only answer for automatic
// attribution, and this module is unreachable unless a creator said otherwise.

import type { Envelope } from "./attribution.ts";
import type { Claim, Fragment, AmbiguousUnit } from "./claim-parser.ts";
import { locate, survives } from "./placement.ts";

/** One declared record, so its index is fixed rather than allocated. */
export const DECLARED_RECORD = 0;

export interface ClaimGroup {
  claims: Claim[];
  ambiguous: AmbiguousUnit[];
  fragments: Fragment[];
}

export const emptyGroup = (): ClaimGroup => ({ claims: [], ambiguous: [], fragments: [] });

/**
 * The whole source, as one envelope.
 *
 * `name` is the creator's own title rather than a first field read off the
 * text, because that is what the declaration consists of. Every claim in every
 * chunk of the run falls inside it, which is the point: under keep_together
 * there is nowhere else a fact could belong.
 */
export function declaredEnvelopes(sourceText: string, name: string): Envelope[] {
  return [{ index: DECLARED_RECORD, start: 0, end: String(sourceText ?? "").length, name: String(name ?? "") }];
}

/**
 * Split ONE record's source units across the several items proposed for it.
 *
 * THE MODEL IS TOLD TO RETURN ONE ITEM AND SOMETIMES RETURNS MORE. Governing
 * only the first would be the silent choice this contract exists to refuse, and
 * handing every item the same claims would be worse than that: a claim resolves
 * to ACCEPTED or REPAIRED, and enforceItem materializes both — so the same fact
 * would be written into every proposal, and the run-level collapse would fold N
 * copies into the packet.
 *
 * So each source unit is assigned to exactly ONE proposal, by the same presence
 * test the reconciler itself uses:
 *
 *   * a claim goes to the first proposal that already contains its value, so a
 *     fact the model placed correctly is ACCEPTED where it sits;
 *   * a claim no proposal contains goes to the first, where it is REPAIRED —
 *     one restoration, not N;
 *   * a fragment goes to the proposal whose content it survives in, and
 *     otherwise to the first, so it is counted orphaned once;
 *   * an ambiguous unit goes to the first. It never materializes anywhere — it
 *     resolves to SOURCE_UNRESOLVED — so it is a question to ask once, and
 *     asking it per proposal would make the review queue a function of how
 *     badly the model misread the instruction.
 *
 * A SINGLE PROPOSAL IS THE IDENTITY CASE. With one item the partition returns
 * the group unchanged, which is why automatic attribution — always exactly one
 * item per bound record — cannot observe that this function exists.
 */
export function partitionAcrossItems(
  group: ClaimGroup, items: Record<string, unknown>[],
): ClaimGroup[] {
  if (items.length <= 1) return [group];

  const out = items.map(() => emptyGroup());
  const firstWith = (holds: (it: Record<string, unknown>) => boolean) => {
    const i = items.findIndex(holds);
    return i >= 0 ? i : 0;
  };

  for (const c of group.claims)
    out[firstWith((it) => locate(it, c.value).length > 0)].claims.push(c);
  for (const f of group.fragments)
    out[firstWith((it) => survives(it, f.text))].fragments.push(f);
  for (const u of group.ambiguous) out[0].ambiguous.push(u);

  return out;
}
