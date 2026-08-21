// OBSERVE-ONLY RECONCILIATION ACCOUNTING for one chunk.
//
// Composes the pieces the offline gate proved — claim parse, structural record
// attribution, precedence reconciliation — into the single value the chunk
// route stores. It computes and returns. It repairs nothing, moves nothing and
// is read by nothing.
import { parseClaims } from "./claim-parser.ts";
import { recordEnvelopes, attributeAll } from "./attribution.ts";
import { reconcile } from "./reconcile.ts";

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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function buildChunkAccounting(opts: {
  segmentText: string; chunkOrdinal: number; sourceStart: number;
  sourceText: string | null; result: unknown;
}): ChunkAccounting {
  const { segmentText, chunkOrdinal, sourceStart, sourceText, result } = opts;
  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const items = [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");

  const parsed = parseClaims(segmentText, chunkOrdinal);
  const env = sourceText ? recordEnvelopes(sourceText) : null;
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);

  const records: ChunkAccounting["records"] = [];
  let accepted = 0, repaired = 0, contentUnresolved = 0, sourceUnresolved = 0, attributed = 0;

  for (const [rec, group] of a.byRecord) {
    attributed += group.claims.length + group.ambiguous.length;
    const name = env?.[rec]?.name ?? "";
    const item = items.find((it) => {
      const t = norm(String(it.title ?? ""));
      return t && name && (t.startsWith(norm(name).slice(0, 12)) || norm(name).startsWith(t.slice(0, 12)));
    }) ?? null;
    const res = reconcile({ claims: group.claims, ambiguous: group.ambiguous, fragments: group.fragments }, item);
    accepted += res.counts.accepted; repaired += res.counts.repaired;
    contentUnresolved += res.counts.unresolved; sourceUnresolved += res.counts.sourceUnresolved;
    records.push({ record: rec, name, title: item ? String(item.title ?? "") : null,
      accepted: res.counts.accepted, repaired: res.counts.repaired,
      contentUnresolved: res.counts.unresolved, sourceUnresolved: res.counts.sourceUnresolved,
      orphaned: res.counts.orphaned });
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
