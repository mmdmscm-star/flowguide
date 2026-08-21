// RECORD ATTRIBUTION — from source structure, not from model judgment.
//
// A claim cannot be allowed to disappear because nobody could decide which
// record it belonged to. Where the source structurally PROVES ownership, that
// proof is used, and it is available before the model runs.
//
// This does NOT invent a record parser. seg-v4 already scans the source with
// RFC4180 quote state and returns records that tile it in order
// (`detectSourceRecords`), which is the same envelope the chunk planner uses.
// Re-deriving boundaries here would create a second definition of "a record"
// that could disagree with the one ingestion actually chunked on.
import { detectSourceRecords } from "./segmentation";
import type { Claim, Fragment, AmbiguousUnit } from "./claim-parser.ts";

export interface Envelope {
  index: number;
  start: number;
  end: number;
  /** First field of the row — for a spreadsheet paste this is the record's own
   *  name, which is what lets an envelope be matched to a proposal by identity
   *  rather than by position. */
  name: string;
}

export function recordEnvelopes(source: string, delimiterHint?: string): Envelope[] | null {
  const d = detectSourceRecords(source);
  if (!d) return null;                       // not structurally a table: ownership is not proven
  void delimiterHint;
  return d.records.map((r, index) => {
    const row = source.slice(r.start, r.end);
    const first = row.split(d.delimiter)[0] ?? "";
    return { index, start: r.start, end: r.end, name: first.replace(/^"+|"+$/g, "").trim() };
  });
}

export type Attributed<T> = { item: T; record: number | null };

/** Attach each claim/fragment to the envelope whose span contains it.
 *  `base` is the chunk's source_start, so segment offsets become absolute. */
export function attribute<T extends { offset: number }>(
  things: T[], envelopes: Envelope[] | null, base: number,
): Attributed<T>[] {
  return things.map((item) => {
    if (!envelopes) return { item, record: null };
    const abs = base + item.offset;
    const e = envelopes.find((x) => abs >= x.start && abs < x.end);
    return { item, record: e ? e.index : null };
  });
}

export interface AttributionResult {
  byRecord: Map<number, { claims: Claim[]; ambiguous: AmbiguousUnit[]; fragments: Fragment[] }>;
  /** Claims that could not be attributed to any record envelope. They are NOT
   *  dropped — they are counted and reported as ATTRIBUTION_UNRESOLVED. */
  unattributedClaims: Claim[];
  unattributedAmbiguous: AmbiguousUnit[];
  unattributedFragments: Fragment[];
}

export function attributeAll(
  claims: Claim[], ambiguous: AmbiguousUnit[], fragments: Fragment[],
  envelopes: Envelope[] | null, base: number,
): AttributionResult {
  const byRecord = new Map<number, { claims: Claim[]; ambiguous: AmbiguousUnit[]; fragments: Fragment[] }>();
  const unattributedClaims: Claim[] = [];
  const unattributedAmbiguous: AmbiguousUnit[] = [];
  const unattributedFragments: Fragment[] = [];
  const bucket = (i: number) => {
    if (!byRecord.has(i)) byRecord.set(i, { claims: [], ambiguous: [], fragments: [] });
    return byRecord.get(i)!;
  };
  for (const { item, record } of attribute(claims, envelopes, base))
    record === null ? unattributedClaims.push(item) : bucket(record).claims.push(item);
  for (const { item, record } of attribute(ambiguous, envelopes, base))
    record === null ? unattributedAmbiguous.push(item) : bucket(record).ambiguous.push(item);
  for (const { item, record } of attribute(fragments, envelopes, base))
    record === null ? unattributedFragments.push(item) : bucket(record).fragments.push(item);
  return { byRecord, unattributedClaims, unattributedAmbiguous, unattributedFragments };
}

/** Which record envelopes does this chunk's source range overlap, in order? */
export function envelopesInRange(envelopes: Envelope[], start: number, end: number): Envelope[] {
  return envelopes.filter((e) => e.start < end && e.end > start);
}

/** BIND PROPOSALS TO SOURCE RECORDS BY PROVENANCE, NEVER BY TITLE.
 *
 *  The model authors the title and is entitled to vary it: "Enso Village" and
 *  "Ensō Village" are the same community, and a diacritic broke reconciliation
 *  when binding went through the title. Matching on model-authored text makes
 *  the layer's correctness depend on the model's word choice, which is the thing
 *  the whole contract exists to stop relying on.
 *
 *  Structure decides instead: the records a chunk covers are ordered by source
 *  offset, the items the model returned for that chunk are ordered as emitted,
 *  and the i-th item is the i-th record. Where the counts disagree the surplus
 *  on either side is left UNBOUND rather than guessed — an unbound record's
 *  claims become ATTRIBUTION_UNRESOLVED, which is a named state, not a loss. */
export function bindItemsToRecords<T>(
  envelopes: Envelope[], chunkStart: number, chunkEnd: number, items: T[],
): { bound: Map<number, T>; unboundRecords: number[]; unboundItems: number } {
  const covered = envelopesInRange(envelopes, chunkStart, chunkEnd);
  const bound = new Map<number, T>();
  const n = Math.min(covered.length, items.length);
  for (let i = 0; i < n; i++) bound.set(covered[i].index, items[i]);
  return {
    bound,
    unboundRecords: covered.slice(n).map((e) => e.index),
    unboundItems: Math.max(0, items.length - covered.length),
  };
}
