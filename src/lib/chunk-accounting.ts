// OBSERVE-ONLY RECONCILIATION ACCOUNTING for one chunk.
//
// Composes the pieces the offline gate proved — claim parse, structural record
// attribution, precedence reconciliation — into the single value the chunk
// route stores. It computes and returns. It repairs nothing, moves nothing and
// is read by nothing.
import { parseClaims } from "./claim-parser.ts";
import { recordEnvelopes, attributeAll, bindByProvenance } from "./attribution.ts";
import { reconcile } from "./reconcile.ts";
import { keepsTogether, type Grouping } from "./grouping.ts";
import { declaredEnvelopes, partitionAcrossItems, emptyGroup, DECLARED_RECORD }
  from "./declared-record.ts";

export interface ChunkAccounting {
  v: 1;
  counts: {
    recognized: number; attributed: number; attributionUnresolved: number;
    accepted: number; repaired: number; contentUnresolved: number; sourceUnresolved: number;
    unaccounted: number;
  };
  /** Per record, so a later review state can name what it is holding. */
  records: { record: number; name: string; title: string | null;
             accepted: number; repaired: number; contentUnresolved: number;
             sourceUnresolved: number; orphaned: number }[];
  /** True when the source is not structurally a table, so ownership is unproven. */
  attributionAvailable: boolean;
}


export function buildChunkAccounting(opts: {
  segmentText: string; chunkOrdinal: number; sourceStart: number;
  sourceText: string | null; result: unknown;
  /** THE SAME DELIMITER ENFORCEMENT USED. The ledger is the record of what the
   *  contract did, so it has to read the source the same way — otherwise it
   *  reports claims enforcement never saw, which is worse than reporting none. */
  delimiterHint?: string | null;
  /** AND THE SAME RECORD COUNT, for exactly that reason. This was missing while
   *  enforcement already had it, so a keep_together run was tiled into thirty
   *  bullet records here and treated as one there: the ledger described a run
   *  that never happened. */
  grouping?: Grouping | null;
}): ChunkAccounting {
  const { segmentText, chunkOrdinal, sourceStart, sourceText, result, delimiterHint, grouping } = opts;
  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const items = [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");

  const declared = keepsTogether(grouping);
  const parsed = parseClaims(segmentText, chunkOrdinal, { delimiter: delimiterHint ?? null });
  const env = !sourceText ? null
    : declared ? declaredEnvelopes(sourceText, String(grouping?.title ?? ""))
    : recordEnvelopes(sourceText, delimiterHint ?? undefined);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);
  if (declared && env && !a.byRecord.has(DECLARED_RECORD)) a.byRecord.set(DECLARED_RECORD, emptyGroup());

  // The same association enforcement used: anchors under auto, the creator's
  // declaration under keep_together — and a record may hold several proposals.
  const boundItems: Map<number, Record<string, unknown>[]> = declared && env
    ? new Map([[DECLARED_RECORD, items]])
    : new Map([...(env && sourceText ? bindByProvenance(env, sourceText, items).bound
                                     : new Map<number, Record<string, unknown>>())]
        .map(([rec, it]) => [rec, [it as Record<string, unknown>]]));
  const records: ChunkAccounting["records"] = [];
  let accepted = 0, repaired = 0, contentUnresolved = 0, sourceUnresolved = 0, attributed = 0;

  for (const [rec, group] of a.byRecord) {
    attributed += group.claims.length + group.ambiguous.length;
    const name = env?.[rec]?.name ?? "";
    // Anchor binding, never the model-authored title.
    const recItems = boundItems.get(rec) ?? [];
    const groups = partitionAcrossItems(group, recItems);
    // ONE ROW PER RECORD, as before. Several proposals for one declared record
    // are several readings of the SAME record, so their outcomes sum into it
    // rather than inventing records the source does not have.
    const row = { record: rec, name, title: null as string | null,
      accepted: 0, repaired: 0, contentUnresolved: 0, sourceUnresolved: 0, orphaned: 0 };
    for (const [pi, item] of (recItems.length ? recItems : [null]).entries()) {
      const res = reconcile(groups[pi] ?? group, item);
      if (item && row.title === null) row.title = String(item.title ?? "");
      row.accepted += res.counts.accepted; row.repaired += res.counts.repaired;
      row.contentUnresolved += res.counts.unresolved;
      row.sourceUnresolved += res.counts.sourceUnresolved;
      row.orphaned += res.counts.orphaned;
    }
    accepted += row.accepted; repaired += row.repaired;
    contentUnresolved += row.contentUnresolved; sourceUnresolved += row.sourceUnresolved;
    records.push(row);
  }

  // Unattributed units are NOT dropped — they are the ATTRIBUTION_UNRESOLVED
  // state, which exists precisely so that a claim cannot vanish because nobody
  // could decide which record owned it.
  const attributionUnresolved = a.unattributedClaims.length + a.unattributedAmbiguous.length;
  const recognized = parsed.claims.length + parsed.ambiguous.length;

  return {
    v: 1,
    counts: {
      recognized, attributed, attributionUnresolved,
      accepted, repaired, contentUnresolved, sourceUnresolved,
      unaccounted: recognized - attributionUnresolved - accepted - repaired - contentUnresolved - sourceUnresolved,
    },
    records,
    attributionAvailable: env !== null,
  };
}
