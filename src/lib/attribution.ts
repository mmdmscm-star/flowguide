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
import type { Claim, Fragment } from "./claim-parser.ts";

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
  byRecord: Map<number, { claims: Claim[]; fragments: Fragment[] }>;
  /** Claims that could not be attributed to any record envelope. They are NOT
   *  dropped — they are counted and reported as ATTRIBUTION_UNRESOLVED. */
  unattributedClaims: Claim[];
  unattributedFragments: Fragment[];
}

export function attributeAll(
  claims: Claim[], fragments: Fragment[], envelopes: Envelope[] | null, base: number,
): AttributionResult {
  const byRecord = new Map<number, { claims: Claim[]; fragments: Fragment[] }>();
  const unattributedClaims: Claim[] = [];
  const unattributedFragments: Fragment[] = [];
  const bucket = (i: number) => {
    if (!byRecord.has(i)) byRecord.set(i, { claims: [], fragments: [] });
    return byRecord.get(i)!;
  };
  for (const { item, record } of attribute(claims, envelopes, base))
    record === null ? unattributedClaims.push(item) : bucket(record).claims.push(item);
  for (const { item, record } of attribute(fragments, envelopes, base))
    record === null ? unattributedFragments.push(item) : bucket(record).fragments.push(item);
  return { byRecord, unattributedClaims, unattributedFragments };
}
