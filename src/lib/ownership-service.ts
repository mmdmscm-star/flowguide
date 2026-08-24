// Load everything ownership recomputation needs, for one packet, from live rows.
//
// The pure decision logic lives in ownership-recompute.ts. This is the thin
// data-loading half, kept separate so the rules stay testable without a database.
//
// A packet may have several runs — one organize plus any number of appends — so
// findings are the union across all of them, each recomputed independently
// against its own source slice.
//
// ---------------------------------------------------------------------------
// THE DISTINCTION THIS MODULE EXISTS TO PRESERVE
//
//   A legitimate inability to prove ownership may be nonblocking.
//   A technical failure to PERFORM the check must never masquerade as a clean one.
//
// These are different kinds of not-knowing and they must never collapse into
// each other:
//
//   DECLINED    — the check ran, and the answer is "ownership is not established
//                 here": no provenance, a voided offset base, a replaced source,
//                 prose with no records, incomplete correspondence. Nothing is
//                 broken; there is simply nothing to prove. Nonblocking, logged.
//
//   UNAVAILABLE — the check did NOT run. A query failed, a table was missing, a
//                 timeout fired. This says nothing whatever about the packet.
//                 Treating it as "no findings" converts an outage into a clean
//                 bill of health and publishes on a check that never happened.
//
// Unavailable is therefore neither a pass nor an accusation. It is retryable,
// and every caller must surface it as such.
// ---------------------------------------------------------------------------

import { isCreatorUploaded } from "./creator-media.ts";
import { createServerClient } from "./supabase.ts";
import {
  recomputeOwnership, resolveFindings, blocksPublishing,
  type ItemProvenance, type RunProvenance, type ResolvedFinding, type DeclineReason,
} from "./ownership-recompute.ts";
import type { ChunkRange } from "./media-ownership.ts";

type Db = ReturnType<typeof createServerClient>;

/** Why a run could not be checked, when the checking itself worked. Widens the
 *  pure layer's vocabulary with the one condition only the data layer can see. */
export type PacketDeclineReason =
  | DeclineReason
  | "run_row_missing"          // items cite a run whose row is gone
  | "no_ingestion_provenance"; // nothing here came from an import at all

/** Which read failed. Named so an operator reading a log knows where to look,
 *  and so "the migration is not applied" stays distinguishable from "the
 *  database was briefly unreachable" without parsing driver messages. */
export type UnavailableSource =
  | "packets" | "sections" | "items" | "item_photos"
  | "item_media_decisions" | "ingestion_runs" | "ingestion_chunks";

/** The composite key overrides are looked up by. NUL cannot occur in a uuid or
 *  a url, so it is the one separator neither half can forge. Written as an
 *  ESCAPE, never as a literal byte — a raw NUL in the source makes this file
 *  binary to git, with no diffs and no reviewable history. */
const keyOf = (itemId: string, url: string) => `${itemId}\u0000${url}`;

/** A photo the professional deliberately kept where it is, carried with enough
 *  context to show and undo it long after the decision was made. */
export interface KeptPhoto {
  itemId: string;
  itemTitle: string;
  url: string;
}

export interface PacketOwnership {
  findings: ResolvedFinding[];
  /** Findings that stop publishing. Always a subset of `findings`. */
  blocking: ResolvedFinding[];
  /** Deliberate Keeps on record for this packet. Empty is a real answer; when
   *  verification is unavailable this is not populated at all. */
  kept: KeptPhoto[];
  /** Why a run could not be checked, where the check itself succeeded. Logged,
   *  not shown — there is nothing the professional could do about it — but a
   *  packet that stopped being checked must not look identical to a clean one. */
  declines: Array<{ runId: string | null; reason: PacketDeclineReason; detail: string }>;
  /** True when at least one run was actually verified. */
  checkedAnyRun: boolean;
  /**
   * NON-NULL means the check did not run. Not a pass and not an accusation: the
   * caller must refuse to publish AND refuse to blame, and say try again.
   */
  unavailable: { source: UnavailableSource; detail: string } | null;
}

const EMPTY: PacketOwnership = {
  findings: [], blocking: [], kept: [], declines: [], checkedAnyRun: false, unavailable: null,
};

/** The check did not run. Nothing in here is a statement about the packet. */
function unavailable(source: UnavailableSource, detail: string): PacketOwnership {
  return { ...EMPTY, unavailable: { source, detail } };
}

/**
 * Recompute ownership for a packet from scratch.
 *
 * Runs are enumerated from `items.origin_run_id`, NEVER from run status.
 * `discard_ingestion_run` leaves origin_run_id, the chunk offsets and the hashes
 * intact, so filtering on status='finalized' would silently exempt exactly the
 * incident case: mis-attributed content applied by a run that was later
 * discarded.
 */
export async function loadPacketOwnership(packetId: string, db?: Db): Promise<PacketOwnership> {
  const supabase = db ?? createServerClient();

  const { data: packet, error: packetErr } = await supabase
    .from("packets").select("raw_input").eq("id", packetId).maybeSingle();
  if (packetErr) return unavailable("packets", packetErr.message);
  const rawInput = (packet as { raw_input?: string } | null)?.raw_input ?? "";

  const { data: sections, error: sectionErr } = await supabase
    .from("sections").select("id").eq("packet_id", packetId);
  if (sectionErr) return unavailable("sections", sectionErr.message);
  const sectionIds = (sections ?? []).map((s: { id: string }) => s.id);
  if (sectionIds.length === 0) return EMPTY;

  const { data: itemRows, error: itemErr } = await supabase
    .from("items")
    .select("id, title, origin_run_id, origin_chunk_ordinal, origin_emit_index")
    .in("section_id", sectionIds);
  if (itemErr) return unavailable("items", itemErr.message);
  const items = (itemRows ?? []) as Array<{
    id: string; title: string;
    origin_run_id: string | null; origin_chunk_ordinal: number | null; origin_emit_index: number | null;
  }>;
  if (items.length === 0) return EMPTY;

  const itemIds = items.map((i) => i.id);
  const titleOf = new Map(items.map((i) => [i.id, i.title]));

  const { data: photoRows, error: photoErr } = await supabase
    .from("item_photos").select("item_id, url").in("item_id", itemIds);
  // Comparing an item's real contents against an empty list would pronounce
  // every misplaced photo in the packet clean.
  if (photoErr) return unavailable("item_photos", photoErr.message);
  const photosByItem = new Map<string, string[]>();
  const uploadedByItem = new Map<string, string[]>();
  for (const p of (photoRows ?? []) as Array<{ item_id: string; url: string }>) {
    photosByItem.set(p.item_id, [...(photosByItem.get(p.item_id) ?? []), p.url]);
    if (isCreatorUploaded(p.url)) {
      uploadedByItem.set(p.item_id, [...(uploadedByItem.get(p.item_id) ?? []), p.url]);
    }
  }

  const out: PacketOwnership = {
    findings: [], blocking: [], kept: [], declines: [], checkedAnyRun: false, unavailable: null,
  };

  const runIds = [...new Set(items.map((i) => i.origin_run_id).filter((r): r is string => !!r))];
  if (runIds.length === 0) {
    // NOT "clean". An all-manual or all-Library packet has no ingestion claim to
    // check, which is a different fact from having been checked and found
    // correct. Returning a bare empty result would let "no applicable check"
    // read downstream as "verified" — the same collapse the decline/unavailable
    // split exists to prevent, one level further out. Recorded so a packet that
    // was never subject to the check is distinguishable in a log from one that
    // passed it.
    out.declines.push({
      runId: null, reason: "no_ingestion_provenance",
      detail: "no item in this packet came from an import, so ownership is not defined for it",
    });
    return out;
  }

  const { data: runRows, error: runErr } = await supabase
    .from("ingestion_runs")
    .select("id, source_hash, source_len, segmenter_version, source_offset_base")
    .in("id", runIds);
  if (runErr) return unavailable("ingestion_runs", runErr.message);

  const { data: chunkRows, error: chunkErr } = await supabase
    .from("ingestion_chunks")
    .select("run_id, ordinal, source_start, source_end, status")
    .in("run_id", runIds);
  if (chunkErr) return unavailable("ingestion_chunks", chunkErr.message);

  const runs = (runRows ?? []) as Array<{
    id: string; source_hash: string; source_len: number;
    segmenter_version: string; source_offset_base: number | null;
  }>;

  // Items can outlive their run row. Skipping them silently would report the
  // packet as checked while a whole run's worth of items were never looked at.
  const present = new Set(runs.map((r) => r.id));
  for (const missing of runIds.filter((r) => !present.has(r))) {
    out.declines.push({
      runId: missing, reason: "run_row_missing",
      detail: "items cite this run but its row no longer exists, so its source cannot be proven",
    });
  }

  // Every finding, before overrides are consulted at all.
  const raw: ResolvedFinding[] = [];
  for (const r of runs) {
    const run: RunProvenance = {
      id: r.id,
      sourceHash: r.source_hash,
      sourceLen: r.source_len,
      segmenterVersion: r.segmenter_version,
      sourceOffsetBase: r.source_offset_base,
    };
    // Leaf chunks only, in source order — the same set finalize applied.
    const chunks: ChunkRange[] = ((chunkRows ?? []) as Array<{
      run_id: string; ordinal: number; source_start: number; source_end: number; status: string;
    }>)
      .filter((c) => c.run_id === r.id && c.status !== "split")
      .sort((a, b) => a.source_start - b.source_start)
      .map((c) => ({ ordinal: c.ordinal, start: c.source_start, end: c.source_end }));

    const mine: ItemProvenance[] = items
      .filter((i) => i.origin_run_id === r.id)
      .map((i) => ({
        id: i.id,
        title: i.title,
        originChunkOrdinal: i.origin_chunk_ordinal,
        originEmitIndex: i.origin_emit_index,
        photoUrls: photosByItem.get(i.id) ?? [],
        creatorUploadedUrls: uploadedByItem.get(i.id) ?? [],
      }));

    const result = recomputeOwnership({ rawInput, run, chunks, items: mine });
    if (result.status === "declined") {
      out.declines.push({ runId: r.id, reason: result.reason, detail: result.detail });
      continue;
    }
    out.checkedAnyRun = true;
    raw.push(...resolveFindings(result));
  }

  // ---- Overrides, read LAST and only when they could change an answer.
  //
  // A decision can only ever SUPPRESS a blocking finding. With none to suppress,
  // the table's contents cannot affect the outcome — so reading it is not part
  // of performing the check, and failing to read it is not a failure to check.
  //
  // This is not a softening of the rule at the top of the file. It is that rule
  // applied precisely: the read is load-bearing only when there is something for
  // it to bear. A packet with nothing wrong is unaffected by the state of this
  // table; a packet with a real finding still refuses to resolve itself against
  // data it could not read.
  const couldBeSuppressed = raw.some(blocksPublishing);
  if (!couldBeSuppressed) {
    out.findings = raw;
    out.blocking = [];
    return out;
  }

  const { data: decisionRows, error: decisionErr } = await supabase
    .from("item_media_decisions").select("item_id, url").in("item_id", itemIds);
  // The one read whose loss pushes TOWARD blocking. Guessing "no Keeps" accuses
  // a professional who already resolved this, with their resolution sitting
  // unread in the table; guessing "all Kept" publishes on unread data. Neither
  // guess is available, so the check is unavailable.
  if (decisionErr) return unavailable("item_media_decisions", decisionErr.message);

  const decisions = (decisionRows ?? []) as Array<{ item_id: string; url: string }>;
  const kept = new Set(decisions.map((d) => keyOf(d.item_id, d.url)));
  out.kept = decisions
    .filter((d) => titleOf.has(d.item_id))
    .map((d) => ({ itemId: d.item_id, itemTitle: titleOf.get(d.item_id)!, url: d.url }));

  for (const f of raw) {
    // An override suppresses ONLY a proven wrong-record finding for exactly that
    // item and url. It can never suppress an ambiguous one, because ambiguous
    // findings offer no Keep and so never produce a decision row.
    if (blocksPublishing(f) && f.url && kept.has(keyOf(f.itemId, f.url))) continue;
    out.findings.push(f);
  }
  out.blocking = out.findings.filter(blocksPublishing);
  return out;
}
