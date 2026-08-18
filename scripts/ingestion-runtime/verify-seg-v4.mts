// seg-v4 production-runtime proof, against the incident that caused it.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-seg-v4.mts
//
// The confirm flag is enforced by lib.mts: this harness writes to whatever
// database .env.local points at, and must never be picked up by a test glob.
//
// Requires the dev server running and serving THIS branch, and .env.local
// pointing at the target database (lib.mts loads it and refuses to run without
// the explicit confirm). CONSUMES REAL MODEL CREDITS — roughly one call per
// record, four for this fixture.
//
// WHY A RUNTIME PROOF AND NOT MORE UNIT TESTS. segmentation.test.mts already
// pins detectSourceRecords against this source. What it cannot show is that the
// RUN uses it: that the plan persisted to ingestion_chunks is the record-aligned
// one, that finalize writes complete provenance for what the model actually
// emitted, that source_offset_base locates the slice the hashes were measured
// against, and that ownership recomputation therefore comes back ANSWERED rather
// than declining. Those are properties of the pipeline, not of a function.
//
// THE FIXTURE IS THE INCIDENT. CLIENT_SOURCE is packet 209679e2 of 2026-08-14,
// PII-sanitized at identical byte lengths so the budget-driven boundaries are
// preserved: four TSV records separated by cosmetic "----" rows. Under seg-v3
// the detector saw field counts [6,1], declined, and fell back to blank-line
// blocks — every record was cut, 8 of 24 photo occurrences were orphaned, and a
// 118-char photo-only tail chunk was left from which the model fabricated a
// fifth item, "Primrose Photo 4".
//
// Every assertion below is that failure, stated as its negation.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svc, check, summary, errText } from "./lib.mts";
import { detectSourceRecords, segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
import { mediaOccurrences } from "../../src/lib/media-ownership.ts";
import { CLIENT_SOURCE } from "../../src/lib/__fixtures__/incident-sources.ts";

// e2e.mts calls setFaults({}) at MODULE SCOPE, writing to the path in
// FLOWGUIDE_TEST_FAULT_FILE — so an unset variable makes the import itself
// throw on writeFileSync(undefined). Defaulted here and imported dynamically so
// the value is in place first. NO faults are injected: this proof is entirely
// about the clean path, and an empty spec is inert even if the dev server reads
// the same file.
process.env.FLOWGUIDE_TEST_FAULT_FILE ??= join(tmpdir(), `flowguide-segv4-${process.pid}.json`);

const { organize, packetContent, report, UID, TAG, api } = await import("./e2e.mts");

const SOURCE = CLIENT_SOURCE;

// Ground truth, derived from the source alone and independent of the run.
const detected = detectSourceRecords(SOURCE);
if (!detected) {
  console.error("FATAL: the detector declined on the incident fixture. That IS the seg-v3 bug.");
  process.exit(1);
}
const RECORDS = detected.records;
const MEDIA = mediaOccurrences(SOURCE);

console.log(`\nseg-v4 runtime proof — ${SEGMENTER_VERSION}`);
console.log(`fixture: ${SOURCE.length} chars, ${RECORDS.length} records, ${MEDIA.length} media occurrences\n`);

let packetId: string | null = null;

/**
 * Source-vs-stored, per URL. The ledger is OCCURRENCE-aware: a url the author
 * listed twice is expected twice, so a model that emits it once reads as
 * media_missing. That distinction is invisible without this table, and the rows
 * are gone the moment cleanup runs.
 */
async function dumpMediaAccounting(pid: string, runId: string) {
  const { data: runRow } = await svc.from("ingestion_runs")
    .select("status, review").eq("id", runId).maybeSingle();
  console.log("\n  --- run state ---");
  console.log("  status:", (runRow as { status?: string } | null)?.status);
  console.log("  review:", JSON.stringify((runRow as { review?: unknown } | null)?.review));

  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", pid);
  const { data: its } = await svc.from("items").select("id, title")
    .in("section_id", (secs ?? []).map((x: { id: string }) => x.id));
  const { data: phs } = await svc.from("item_photos").select("item_id, url")
    .in("item_id", (its ?? []).map((x: { id: string }) => x.id));

  const storedCounts = new Map<string, number>();
  for (const ph of (phs ?? []) as Array<{ url: string }>) {
    storedCounts.set(ph.url, (storedCounts.get(ph.url) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  for (const m of MEDIA) sourceCounts.set(m.url, (sourceCounts.get(m.url) ?? 0) + 1);

  console.log("  --- media accounting (source occurrences vs stored rows) ---");
  let clean = true;
  for (const [url, expected] of sourceCounts) {
    const got = storedCounts.get(url) ?? 0;
    if (got === expected) continue;
    clean = false;
    const rec = RECORDS.findIndex((r) => {
      const at = MEDIA.find((m) => m.url === url)!.at;
      return at >= r.start && at < r.end;
    });
    console.log(`    ${got < expected ? "MISSING  " : "DUPLICATED"} source=${expected} stored=${got}` +
      `  record=${rec}  ${url.slice(-46)}`);
  }
  if (clean) console.log("    every url matches its source occurrence count");
  console.log(`  items: ${JSON.stringify((its ?? []).map((i: { title: string }) => i.title))}`);
}

try {
  // =========================================================================
  // 1. The real import: real route, real model, real persistence.
  // =========================================================================
  const run = await organize("seg-v4-incident", SOURCE);
  packetId = run.packetId;
  check("the import finalized", run.outcome === "finalized",
    `outcome=${run.outcome} ${JSON.stringify(run.driveInfo ?? {}).slice(0, 200)}`);
  report(run.m);
  if (!packetId || !run.runId) throw new Error("no packet/run to inspect");

  // =========================================================================
  // 2. What the RUN recorded — the plan as persisted, not as recomputed.
  // =========================================================================
  const { data: runRow } = await svc.from("ingestion_runs")
    .select("id, status, entry_point, source_hash, source_len, segmenter_version, source_offset_base")
    .eq("id", run.runId).single();
  const r = runRow as {
    status: string; entry_point: string; source_hash: string; source_len: number;
    segmenter_version: string; source_offset_base: number | null;
  };

  check("the run is recorded as seg-v4", r.segmenter_version === SEGMENTER_VERSION,
    `recorded ${r.segmenter_version}, build is ${SEGMENTER_VERSION}`);

  // source_offset_base is what lets ownership locate this run's slice inside a
  // packet whose raw_input may hold several runs' text. Proven the way
  // recomputeOwnership proves it: re-slice and re-hash.
  const { data: pkt } = await svc.from("packets").select("raw_input").eq("id", packetId).single();
  const rawInput = (pkt as { raw_input: string }).raw_input;
  const base = r.source_offset_base;
  const slice = base === null ? "" : rawInput.slice(base, base + r.source_len);
  check("source_offset_base locates the exact slice the hashes were measured against",
    base !== null && slice.length === r.source_len && segmentHash(slice) === r.source_hash,
    `base=${base} len=${r.source_len} sliceLen=${slice.length} hashMatch=${segmentHash(slice) === r.source_hash}`);

  const { data: chunkRows } = await svc.from("ingestion_chunks")
    .select("ordinal, source_start, source_end, status, is_continuation")
    .eq("run_id", run.runId).order("source_start");
  const leaves = ((chunkRows ?? []) as Array<{
    ordinal: number; source_start: number; source_end: number; status: string; is_continuation: boolean;
  }>).filter((c) => c.status !== "split");

  check("leaf chunks tile the whole source with no gap or overlap",
    leaves.length > 0
      && leaves[0].source_start === 0
      && leaves[leaves.length - 1].source_end === r.source_len
      && leaves.every((c, i) => i === 0 || c.source_start === leaves[i - 1].source_end),
    JSON.stringify(leaves.map((c) => [c.source_start, c.source_end])));

  // ---- THE CENTRAL CLAIM ---------------------------------------------------
  // seg-v3 cut every one of these four records. A boundary strictly inside a
  // record is the defect, stated directly.
  const boundaries = [...new Set(leaves.flatMap((c) => [c.source_start, c.source_end]))];
  const cut = RECORDS.filter((rec) => boundaries.some((b) => b > rec.start && b < rec.end));
  check("NO chunk boundary falls inside a source record",
    cut.length === 0,
    `${cut.length} record(s) cut: ${JSON.stringify(cut.map((c) => [c.start, c.end]))}`);

  check("the structured records survived the separator rows",
    RECORDS.length === 4, `detector found ${RECORDS.length} records, expected 4`);

  // ---- media stays with its record ----------------------------------------
  const recordOf = (at: number) => RECORDS.findIndex((rec) => at >= rec.start && at < rec.end);
  const chunkOf = (at: number) => leaves.find((c) => at >= c.source_start && at < c.source_end);

  const orphaned = MEDIA.filter((m) => recordOf(m.at) === -1);
  check("every media occurrence sits inside a source record",
    orphaned.length === 0, `${orphaned.length} orphaned of ${MEDIA.length}`);

  const strandedFromRecord = MEDIA.filter((m) => {
    const rec = RECORDS[recordOf(m.at)];
    const c = chunkOf(m.at);
    return !rec || !c || !(c.source_start <= rec.start && c.source_end >= rec.end);
  });
  check("every media occurrence's chunk contains that media's WHOLE record",
    strandedFromRecord.length === 0,
    `${strandedFromRecord.length} of ${MEDIA.length} media separated from their record`);

  // ---- no media-only tail ---------------------------------------------------
  // The 118-char photo-only chunk is what the model turned into a fifth item.
  const mediaOnly = leaves.filter((c) => {
    const holdsMedia = MEDIA.some((m) => m.at >= c.source_start && m.at < c.source_end);
    const holdsRecordStart = RECORDS.some((rec) => rec.start >= c.source_start && rec.start < c.source_end);
    return holdsMedia && !holdsRecordStart;
  });
  check("no chunk carries media without the record that owns it",
    mediaOnly.length === 0,
    `${mediaOnly.length} media-only chunk(s): ${JSON.stringify(mediaOnly.map((c) => [c.source_start, c.source_end]))}`);

  // =========================================================================
  // 3. What the MODEL emitted, and what finalize recorded about it.
  // =========================================================================
  const content = await packetContent(packetId);
  const items = content.items as Array<{ id: string; title: string; section_id: string }>;

  check("one item per source record — nothing fabricated, nothing lost",
    items.length === RECORDS.length,
    `${items.length} items for ${RECORDS.length} records: ${JSON.stringify(items.map((i) => i.title))}`);

  // The incident's fabricated item was named after a photo cell. Named directly,
  // because "4 items" alone would pass if the model dropped a real community and
  // invented one.
  const photoish = items.filter((i) => /\bphoto\s*\d*\b/i.test(i.title));
  check("no item is named after a photo cell",
    photoish.length === 0, JSON.stringify(photoish.map((i) => i.title)));

  const { data: provRows } = await svc.from("items")
    .select("id, title, origin_run_id, origin_chunk_ordinal, origin_emit_index")
    .in("id", items.map((i) => i.id));
  const prov = (provRows ?? []) as Array<{
    id: string; title: string; origin_run_id: string | null;
    origin_chunk_ordinal: number | null; origin_emit_index: number | null;
  }>;

  check("every item records the run that made it",
    prov.length === items.length && prov.every((p) => p.origin_run_id === run.runId),
    JSON.stringify(prov.map((p) => [p.title, p.origin_run_id])));

  check("every item records a chunk ordinal and an emit index",
    prov.every((p) => p.origin_chunk_ordinal !== null && p.origin_emit_index !== null),
    JSON.stringify(prov.filter((p) => p.origin_chunk_ordinal === null || p.origin_emit_index === null)
      .map((p) => p.title)));

  // Positional binding in 0016 requires a chunk's surviving emit indices to be
  // exactly 0..n-1. Proving it here means the binding is sound at birth rather
  // than only after an edit.
  const byChunk = new Map<number, number[]>();
  for (const p of prov) {
    const k = p.origin_chunk_ordinal!;
    byChunk.set(k, [...(byChunk.get(k) ?? []), p.origin_emit_index!]);
  }
  const dense = [...byChunk.entries()].every(([, idx]) =>
    [...idx].sort((a, b) => a - b).every((v, i) => v === i));
  check("emit indices are dense 0..n-1 within every chunk",
    dense, JSON.stringify([...byChunk.entries()]));

  // =========================================================================
  // 4. Ownership: ANSWERED, and clean.
  // =========================================================================
  const own = await api(`/api/packets/${packetId}/ownership`);
  check("ownership recomputation is available, not unavailable",
    own.status === 200, `status ${own.status} ${JSON.stringify(own.data).slice(0, 200)}`);
  check("ownership was actually CHECKED, not declined",
    own.data?.checked === true,
    `checked=${own.data?.checked} — a decline here means the run cannot be proven against its source`);
  check("a clean import produces NO ownership findings",
    (own.data?.findings ?? []).length === 0,
    JSON.stringify(own.data?.findings));
  check("and therefore nothing blocking",
    own.data?.blockingCount === 0, `blockingCount=${own.data?.blockingCount}`);

  // =========================================================================
  // 5. The packet is publishable.
  // =========================================================================
  const pub = await api(`/api/packets/${packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });

  // A publish refusal has to name WHICH gate refused. "ownership_unresolved" is
  // this proof's business; "import_needs_review" is the media ledger, a separate
  // subsystem — reporting them as the same failure would blame segmentation for
  // an accounting result.
  check("publishing is not blocked by OWNERSHIP",
    pub.data?.error !== "ownership_unresolved",
    JSON.stringify(pub.data).slice(0, 240));
  check("the packet publishes", pub.status === 200,
    `status ${pub.status} ${JSON.stringify(pub.data).slice(0, 240)}`);

  // Whatever the outcome, show the accounting. On a needs_review the per-URL
  // comparison is the entire diagnosis, and gathering it AFTER cleanup is
  // impossible.
  if (pub.status !== 200) await dumpMediaAccounting(packetId, run.runId);

  summary("seg-v4 runtime proof");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  // ---------------------------------------------------------------- cleanup
  if (packetId) await svc.from("packets").delete().eq("id", packetId);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);

  // Checked by ID and by tag, not by user_id — querying by a just-deleted user
  // returns nothing whether or not the rows survived.
  const { data: leftPacket } = packetId
    ? await svc.from("packets").select("id").eq("id", packetId)
    : { data: [] };
  const { data: leftUser } = await svc.from("users").select("id").eq("id", UID);
  const { data: leftTagged } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const stray = (leftPacket ?? []).length + (leftUser ?? []).length + (leftTagged ?? []).length;
  console.log(`\ncleanup: ${(leftPacket ?? []).length} packets, ${(leftUser ?? []).length} users, ` +
    `${(leftTagged ?? []).length} tagged users remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
