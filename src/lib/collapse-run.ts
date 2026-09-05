import { collapseToOneItem, type CollapsibleItem, type CollapsedItem } from "./collapse-item.ts";
import { keepsTogether, type Grouping } from "./grouping.ts";

// KEEP_TOGETHER IS A FACT ABOUT THE RUN, NOT ABOUT A CHUNK.
//
// The one-item instruction reaches the model per chunk, because that is the
// only place a model is called. But a 26-row pricing sheet becomes five chunks
// — 1,077 characters, split on the segmenter's six-item budget — so five
// obedient chunks each return one item, and finalize_ingestion_run inserts
// every item of every chunk unconditionally. Its only recombination is
// section-level, via is_continuation, and its own comment says "never by
// title". Five items named "Spring Lake Village" is what the professional
// would have got.
//
// So the run's proposals are folded ONCE, here, immediately before finalize.
// This is the last application-layer moment where every chunk's result is
// visible together and nothing has been written to the packet yet.
//
// WHY REWRITING RESULTS IS SAFE HERE. finalize_ingestion_run checks coverage on
// status, source_start and source_end against source_len — it never reads
// `result` to decide whether the run is complete, only to insert rows
// afterwards. There are no triggers on ingestion_chunks. So the offsets, the
// hashes, the statuses and the completeness proof are all untouched by this.
//
// WHAT IS LOST, and it was an accepted trade rather than an oversight: after
// this runs, the stored per-chunk results are the collapsed shape rather than
// the raw model proposals. Enforcement has already run over the originals, and
// fact_ledger and review_units — the integrity record — are not touched here.

/** The minimum of the Supabase client this needs, so a test can supply one. */
export interface CollapseDb {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        order(col: string, opts: { ascending: boolean }): Promise<{
          data: ChunkRow[] | null; error: { message: string } | null }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): {
        eq(col2: string, val2: unknown): Promise<{ error: { message: string } | null }>;
      };
    };
  };
}

export interface ChunkRow {
  ordinal: number;
  status: string;
  source_start: number;
  result: unknown;
  /** The segment the model was actually given. Carried out with the fold so the
   *  omission check can parse exactly what enforcement parsed, rather than
   *  re-reading the whole source and getting a different answer. */
  segment_text?: string | null;
}

export type CollapseOutcome =
  /** Not a keep_together run, or nothing to fold. Nothing was written. */
  | { kind: "skipped"; reason: string }
  | { kind: "collapsed"; chunksFolded: number; itemsFolded: number;
      /** The one item this run would publish, and the run's segments in source
       *  order. Returned rather than re-read: this is the last point where the
       *  assembled item exists in memory, and the omission check must ask its
       *  question about THIS object. */
      item: CollapsedItem; segments: { ordinal: number; segmentText: string }[] }
  | { kind: "error"; message: string };

const sectionsOf = (result: unknown): { title?: unknown; description?: unknown; items?: unknown }[] => {
  const r = (result ?? {}) as { sections?: unknown };
  return Array.isArray(r.sections) ? r.sections as { items?: unknown }[] : [];
};

/**
 * Fold every proposal in a keep_together run into one item.
 *
 * PARTIAL RUNS ARE NEVER TOUCHED. If any leaf is not completed the run is not
 * ready to finalize either, and rewriting half a run's results would destroy
 * proposals the remaining chunks have not yet produced their share of.
 */
export async function collapseRunToOneItem(
  db: CollapseDb, runId: string, grouping: Grouping | null | undefined,
): Promise<CollapseOutcome> {
  // AUTO NEVER ENTERS. Not "enters and does nothing" — the historical path does
  // not read or write a single chunk result.
  if (!keepsTogether(grouping)) return { kind: "skipped", reason: "not_keep_together" };

  const { data, error } = await db
    .from("ingestion_chunks")
    .select("ordinal, status, source_start, result, segment_text")
    .eq("run_id", runId)
    .order("source_start", { ascending: true });
  if (error) return { kind: "error", message: error.message };

  // Leaves only: a split parent's own result is superseded by its children,
  // and finalize skips it for the same reason.
  const leaves = (data ?? []).filter((c) => c.status !== "split");
  if (!leaves.length) return { kind: "skipped", reason: "no_leaves" };
  if (leaves.some((c) => c.status !== "completed")) {
    return { kind: "skipped", reason: "run_incomplete" };
  }

  // Source order, then the order the chunk proposed them in.
  const items: CollapsibleItem[] = [];
  for (const leaf of leaves) {
    for (const sec of sectionsOf(leaf.result)) {
      for (const it of (Array.isArray(sec.items) ? sec.items : [])) {
        // A chunk that returned several items despite the prompt is simply more
        // input. Rejecting it would discard facts the source really carries.
        items.push((it ?? {}) as CollapsibleItem);
      }
    }
  }
  if (!items.length) return { kind: "skipped", reason: "no_items" };

  const collapsed = collapseToOneItem(items, String(grouping!.title));

  // The first leaf carries the whole run's one item. Its section keeps whatever
  // the model called it — keep_together names the ITEM, and inventing a section
  // title here would be this code writing copy.
  const firstSection = sectionsOf(leaves[0].result)[0];
  const head = {
    sections: [{
      title: String(firstSection?.title ?? "") || "Section",
      description: String(firstSection?.description ?? ""),
      items: [collapsed],
    }],
  };

  const write = async (ordinal: number, result: unknown) => {
    const { error: e } = await db
      .from("ingestion_chunks")
      .update({ result })
      .eq("run_id", runId)
      .eq("ordinal", ordinal);
    return e;
  };

  const headErr = await write(leaves[0].ordinal, head);
  if (headErr) return { kind: "error", message: headErr.message };

  // The rest contribute nothing further; their content is already in the head.
  // Emptied rather than deleted, so coverage still tiles the whole source.
  for (const leaf of leaves.slice(1)) {
    const e = await write(leaf.ordinal, { sections: [] });
    if (e) return { kind: "error", message: e.message };
  }

  return {
    kind: "collapsed", chunksFolded: leaves.length, itemsFolded: items.length,
    item: collapsed,
    segments: leaves.map((l) => ({ ordinal: l.ordinal, segmentText: String(l.segment_text ?? "") })),
  };
}
