// The data-loading half of ownership. Run: node --test src/lib/ownership-service.test.mts
//
// ownership-recompute.test.mts already pins the RULES. What is only decidable
// here is what happens when the database does not cooperate: a table that is not
// there yet, a run row that outlived its items, a query that simply fails.
//
// The distinction under test is between two kinds of not-knowing:
//
//   DECLINED    — the check RAN and ownership is not establishable here. Real
//                 answer, nonblocking, logged.
//   UNAVAILABLE — the check DID NOT RUN. Says nothing about the packet, so it
//                 can be neither a pass nor an accusation.
//
// Collapsing the second into the first is the bug this file exists to prevent:
// it turns an outage into a clean bill of health and publishes on a check that
// never happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentHash, detectSourceRecords, SEGMENTER_VERSION } from "./segmentation.ts";
import { mediaOccurrences } from "./media-ownership.ts";
import { loadPacketOwnership } from "./ownership-service.ts";
import { CLIENT_SOURCE } from "./__fixtures__/incident-sources.ts";

// ---------------------------------------------------------------------------
// A Supabase stand-in. Only the four call shapes ownership-service actually
// uses: .select(), .eq(), .in(), .maybeSingle(), and awaiting the builder.
// Errors are injected per TABLE, which is the granularity every failure this
// file cares about actually has.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, failing: Record<string, string> = {}) {
  const calls: string[] = [];
  const db = {
    calls,
    from(table: string) {
      calls.push(table);
      const error = failing[table] ? { message: failing[table] } : null;
      let rows: Row[] = error ? [] : [...(tables[table] ?? [])];
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return api; },
        in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return api; },
        maybeSingle: () => Promise.resolve({ data: error ? null : (rows[0] ?? null), error }),
        // Awaiting the builder is how the non-single queries resolve.
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
          Promise.resolve({ data: error ? null : rows, error }).then(ok, no),
      };
      return api;
    },
  };
  // The service's Db type is the real client; this deliberately supplies only
  // the surface it uses, which is the point of injecting it.
  return db as unknown as Parameters<typeof loadPacketOwnership>[1];
}

const PACKET = "packet-1";
const RUN = "run-1";
const CHUNKS = [[0, 2856], [2856, 5125], [5125, 7751], [7751, 9767], [9767, 9885]] as Array<[number, number]>;
const TITLES = ["The Reserve at Fountaingrove", "Brookdale Chanate", "Brookdale Paulin Creek", "Primrose", "Primrose Photo 4"];

/** The incident exactly as it sat in the database: one item per chunk, each
 *  holding the photos its chunk contained, with 0014 provenance recorded. */
function incidentTables(): Record<string, Row[]> {
  const media = mediaOccurrences(CLIENT_SOURCE);
  const photos: Row[] = [];
  const items: Row[] = CHUNKS.map(([start, end], i) => {
    for (const m of media.filter((m) => m.at >= start && m.at < end)) {
      photos.push({ item_id: `item-${i}`, url: m.url });
    }
    return {
      id: `item-${i}`, section_id: "sec-1", title: TITLES[i],
      origin_run_id: RUN, origin_chunk_ordinal: i, origin_emit_index: 0,
    };
  });
  return {
    packets: [{ id: PACKET, raw_input: CLIENT_SOURCE }],
    sections: [{ id: "sec-1", packet_id: PACKET }],
    items,
    item_photos: photos,
    item_media_decisions: [],
    ingestion_runs: [{
      id: RUN, source_hash: segmentHash(CLIENT_SOURCE), source_len: CLIENT_SOURCE.length,
      segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
    }],
    ingestion_chunks: CHUNKS.map(([source_start, source_end], ordinal) => ({
      run_id: RUN, ordinal, source_start, source_end, status: "completed",
    })),
  };
}

// ---------------------------------------------------------------------------
// The happy path, end to end through the loader rather than the pure rules.
// ---------------------------------------------------------------------------
test("the incident loads from live rows and blocks publishing", async () => {
  const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables()));
  assert.equal(o.checkedAnyRun, true);
  assert.equal(o.unavailable, null);
  assert.deepEqual(o.declines, []);
  assert.deepEqual(o.kept, []);
  assert.equal(o.blocking.length, 7, "seven misplaced photos, same as the pure recompute finds");
  assert.ok(o.blocking.every((f) => f.code === "media_on_wrong_record"));
  assert.ok(o.blocking.every((f) => f.itemId && f.url), "each names the row and the photo an RPC would act on");
});

test("kept photos are returned with the titles needed to show and undo them", async () => {
  // Reversibility lives on this field. A Keep suppresses its own finding, so
  // nothing derived from findings can ever surface it again — the decision rows
  // themselves are the only durable handle on it.
  const tables = incidentTables();
  const target = (await loadPacketOwnership(PACKET, fakeDb(tables))).blocking[0];
  tables.item_media_decisions = [{ item_id: target.itemId, url: target.url }];

  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.equal(o.kept.length, 1);
  assert.equal(o.kept[0].itemId, target.itemId);
  assert.equal(o.kept[0].url, target.url);
  assert.ok(o.kept[0].itemTitle, "a bare id is not something a professional can recognise");
  assert.equal(o.findings.filter((f) => f.itemId === target.itemId && f.url === target.url).length, 0,
    "and the finding it settles is gone");
});

test("a Keep suppresses exactly its own photo and nothing else", async () => {
  const base = await loadPacketOwnership(PACKET, fakeDb(incidentTables()));
  const target = base.blocking[0];

  const tables = incidentTables();
  tables.item_media_decisions = [{ item_id: target.itemId, url: target.url }];
  const after = await loadPacketOwnership(PACKET, fakeDb(tables));

  assert.equal(after.blocking.length, base.blocking.length - 1);
  assert.equal(after.blocking.filter((f) => f.itemId === target.itemId && f.url === target.url).length, 0);
  // Same url on a DIFFERENT item, or a different url on the same item, is a
  // different decision and must survive untouched.
  for (const f of base.blocking.slice(1)) {
    assert.ok(after.blocking.some((g) => g.itemId === f.itemId && g.url === f.url),
      `${f.itemId}/${f.url} must still be reported`);
  }
});

test("a Keep recorded for one item does not travel to the same url elsewhere", async () => {
  const tables = incidentTables();
  const target = (await loadPacketOwnership(PACKET, fakeDb(tables))).blocking[0];
  // A decision keyed to an item that does not hold this url at all.
  tables.item_media_decisions = [{ item_id: "item-4", url: target.url }];
  const after = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.equal(after.blocking.length, 7, "a decision on the wrong item suppresses nothing");
});

// ---------------------------------------------------------------------------
// The asymmetry. This is the reason the file exists.
// ---------------------------------------------------------------------------
test("an unreadable decisions table is reported as unavailable", async () => {
  // The live shape of this on the day 0016 ships: the code is deployed, the
  // migration is not, and the table does not exist.
  //
  // Both guesses are wrong and in opposite directions. "No Keeps" accuses a
  // professional who already resolved this, with their resolution sitting
  // unread in the table. "All Kept" publishes on data nobody could read. So the
  // answer is neither: the check did not run.
  const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), {
    item_media_decisions: 'relation "public.item_media_decisions" does not exist',
  }));

  assert.ok(o.unavailable, "a failed decisions read must be reported as unavailable");
  assert.equal(o.unavailable.source, "item_media_decisions");
  assert.deepEqual(o.blocking, [], "an unavailable check cannot block");
  assert.deepEqual(o.findings, [], "and cannot report findings it did not finish deriving");
  assert.deepEqual(o.kept, [], "and must not imply there are no Keeps");
});

test("a failed decisions read is never mistaken for having read zero of them", async () => {
  const clean = await loadPacketOwnership(PACKET, fakeDb(incidentTables()));
  const broken = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { item_media_decisions: "boom" }));

  // Both saw an empty override set. One of them KNOWS it; the other must not
  // be allowed to claim it.
  assert.equal(clean.unavailable, null);
  assert.equal(clean.blocking.length, 7, "a real empty set still blocks");
  assert.ok(broken.unavailable, "an unread set does not");
  assert.deepEqual(broken.blocking, []);
});

// ---------------------------------------------------------------------------
// The read is only performed when it could change an answer.
// ---------------------------------------------------------------------------
test("a clean packet does not consult decisions at all, so it cannot be held hostage by them", async () => {
  // Overrides can only SUPPRESS a blocking finding. With none to suppress, the
  // table cannot affect the outcome — so a packet with nothing wrong publishes
  // normally whether or not 0016 has been applied. This is the rule applied
  // precisely, not relaxed: the read is load-bearing only when it bears
  // something.
  const tables = incidentTables();
  tables.item_photos = [];                       // no photos, so no misplacement
  const db = fakeDb(tables, { item_media_decisions: "table missing" });
  const o = await loadPacketOwnership(PACKET, db);

  assert.equal(o.unavailable, null, "an unread table that could not matter is not a failure");
  assert.deepEqual(o.blocking, []);
  assert.equal((db as unknown as { calls: string[] }).calls.includes("item_media_decisions"), false,
    "and it is not even queried");
});

test("a packet WITH a blocking finding refuses to resolve itself against unread decisions", async () => {
  const db = fakeDb(incidentTables(), { item_media_decisions: "table missing" });
  const o = await loadPacketOwnership(PACKET, db);
  assert.equal((db as unknown as { calls: string[] }).calls.includes("item_media_decisions"), true,
    "here the read IS load-bearing, so it is performed");
  assert.ok(o.unavailable, "and its failure is fatal to the check");
});

// ---------------------------------------------------------------------------
// Any failed read is unavailable, and names itself.
// ---------------------------------------------------------------------------
test("every failed read is unavailable, and never a decline", async () => {
  // A decline is an ANSWER. Filing an outage as one would put "we looked and
  // found nothing to prove" in the log for a check that never ran, and the
  // publish gate treats declines as safe to proceed past.
  for (const table of ["packets", "sections", "items", "item_photos", "ingestion_runs", "ingestion_chunks"]) {
    const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { [table]: `${table} is down` }));
    assert.ok(o.unavailable, `${table}: a failed read must be unavailable`);
    assert.equal(o.unavailable.source, table, `${table}: must name which read failed`);
    assert.match(o.unavailable.detail, new RegExp(table));
    assert.deepEqual(o.blocking, [], `${table}: must never block`);
    assert.deepEqual(o.findings, [], `${table}: nothing was proven, so nothing is claimed`);
    assert.deepEqual(o.declines, [], `${table}: an outage is not a decline`);
    assert.equal(o.checkedAnyRun, false, `${table}: must not report itself as checked`);
  }
});

test("unreadable photos never pass as an item with no photos", async () => {
  // The quiet version of this bug: an item whose photo rows failed to load looks
  // identical to an item holding none, and every misplaced photo in the packet
  // is pronounced clean.
  const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { item_photos: "timeout" }));
  assert.equal(o.checkedAnyRun, false);
  assert.equal(o.unavailable?.source, "item_photos");
  assert.deepEqual(o.blocking, []);
});

// ---------------------------------------------------------------------------
// A decline is the other kind of not-knowing, and stays nonblocking.
// ---------------------------------------------------------------------------
test("a legitimate decline is an answer: reported, nonblocking, and NOT unavailable", async () => {
  const tables = incidentTables();
  (tables.ingestion_runs[0] as Row).source_hash = "a-different-source-entirely";
  const o = await loadPacketOwnership(PACKET, fakeDb(tables));

  assert.equal(o.unavailable, null, "the check ran; it simply could not establish ownership");
  assert.equal(o.declines.length, 1);
  assert.equal(o.declines[0].reason, "source_moved");
  assert.deepEqual(o.blocking, [], "a decline never blocks");
});

// ---------------------------------------------------------------------------
// Runs enumerated from items, not from run status.
// ---------------------------------------------------------------------------
test("items citing a run whose row is gone are declined, not silently skipped", async () => {
  const tables = incidentTables();
  tables.ingestion_runs = [];   // the row is gone; origin_run_id still points at it
  const o = await loadPacketOwnership(PACKET, fakeDb(tables));

  assert.equal(o.checkedAnyRun, false, "nothing was verified");
  assert.deepEqual(o.blocking, [], "and an unverifiable run cannot block");
  assert.equal(o.declines.length, 1);
  assert.equal(o.declines[0].reason, "run_row_missing");
  assert.equal(o.declines[0].runId, RUN, "the decline names WHICH run went missing");
});

test("a discarded run is still checked — discard leaves the photos behind", async () => {
  // The incident case exactly: content applied by a run that was later
  // discarded. Nothing here reads run status, so there is no status to exempt it.
  const tables = incidentTables();
  (tables.ingestion_runs[0] as Row).status = "discarded";
  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.equal(o.blocking.length, 7, "a discarded run's misplacements still block");
});

test("findings are the union across runs, each proven against its own slice", async () => {
  const tables = incidentTables();
  // A second run whose source was replaced out from under it. It must decline on
  // its own terms without taking the first run's real findings down with it.
  tables.ingestion_runs.push({
    id: "run-2", source_hash: "hash-of-something-else", source_len: 40,
    segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
  });
  tables.items.push({
    id: "item-9", section_id: "sec-1", title: "Appended",
    origin_run_id: "run-2", origin_chunk_ordinal: 0, origin_emit_index: 0,
  });
  tables.ingestion_chunks.push({ run_id: "run-2", ordinal: 0, source_start: 0, source_end: 40, status: "completed" });

  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.equal(o.checkedAnyRun, true, "run-1 was still verified");
  assert.equal(o.blocking.length, 7, "run-1's findings survive run-2's decline");
  assert.equal(o.declines.length, 1);
  assert.equal(o.declines[0].runId, "run-2");
  assert.equal(o.declines[0].reason, "source_moved");
});

// ---------------------------------------------------------------------------
// Ambiguity stays ambiguous, at the loader level too.
// ---------------------------------------------------------------------------
test("an ambiguous finding is reported, never blocks, and no Keep can silence it", async () => {
  const P = "https://cdn.example.com/shared.jpg";
  const source = `Alpha\tone\t${P}\nBravo\ttwo\t${P}\nCharlie\tthree\tx`;
  const records = detectSourceRecords(source)!.records;

  const tables: Record<string, Row[]> = {
    packets: [{ id: PACKET, raw_input: source }],
    sections: [{ id: "sec-1", packet_id: PACKET }],
    items: ["Alpha", "Bravo", "Charlie"].map((title, i) => ({
      id: `item-${i}`, section_id: "sec-1", title,
      origin_run_id: RUN, origin_chunk_ordinal: i, origin_emit_index: 0,
    })),
    item_photos: [{ item_id: "item-2", url: P }],
    // A Keep the application would never write. Even if one existed, it must not
    // convert "the source never said" into "the professional decided".
    item_media_decisions: [{ item_id: "item-2", url: P }],
    ingestion_runs: [{
      id: RUN, source_hash: segmentHash(source), source_len: source.length,
      segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
    }],
    ingestion_chunks: records.map((r, ordinal) => ({
      run_id: RUN, ordinal, source_start: r.start, source_end: r.end, status: "completed",
    })),
  };

  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  const amb = o.findings.filter((f) => f.url === P);
  assert.equal(amb.length, 1);
  assert.equal(amb[0].code, "ownership_unverifiable");
  assert.deepEqual(o.blocking, [], "ambiguity has to stay visible, so it cannot block");
  assert.equal(o.findings.length, 1, "and the stray Keep suppressed nothing");
});

// ---------------------------------------------------------------------------
// Cheap exits, and the one query that must not run before them.
// ---------------------------------------------------------------------------
test("a packet with no sections or no items short-circuits without touching runs", async () => {
  for (const empty of ["sections", "items"]) {
    const tables = incidentTables();
    tables[empty] = [];
    const db = fakeDb(tables);
    const o = await loadPacketOwnership(PACKET, db);
    assert.deepEqual(o.findings, []);
    assert.deepEqual(o.blocking, []);
    assert.deepEqual(o.declines, [], "an empty packet is clean, not undecidable");
    assert.equal((db as unknown as { calls: string[] }).calls.includes("ingestion_runs"), false,
      `${empty}: no reason to enumerate runs`);
  }
});

test("items with no provenance at all are clean rather than undecidable", async () => {
  // Hand-built packets, and everything imported before 0014.
  const tables = incidentTables();
  tables.items = tables.items.map((i) => ({ ...i, origin_run_id: null }));
  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.deepEqual(o.findings, []);
  assert.deepEqual(o.blocking, []);
  assert.equal(o.checkedAnyRun, false);
});

// ---------------------------------------------------------------------------
// MIXED-ORIGIN PACKETS — the Library precondition.
//
// A Library insertion carries no ingestion provenance, and it must not. But
// "no provenance" has to be local to that ITEM. If one provenance-free item
// made the whole packet undecidable, then adding a single Library or manual
// item would silently switch OFF ownership verification for the imported items
// beside it — turning a feature into a bypass, and doing it invisibly.
//
// recomputeOwnership DOES decline a run on `incomplete_provenance`. The question
// this pins is whether a null-origin item can ever reach that check. It cannot:
// loadPacketOwnership partitions items by origin_run_id first, so an item with
// no run is never a member of any run's slice.
// ---------------------------------------------------------------------------
test("a manual or Library item does not disable checking for the imported items beside it", async () => {
  const tables = incidentTables();

  // Three provenance-free items, as a Library insertion or manual add produces:
  // a run, chunk ordinal and emit index that are all null.
  for (const n of [0, 1, 2]) {
    tables.items.push({
      id: `library-${n}`, section_id: "sec-1", title: `Inserted from Library ${n}`,
      origin_run_id: null, origin_chunk_ordinal: null, origin_emit_index: null,
    });
    tables.item_photos.push({ item_id: `library-${n}`, url: `https://cdn.example.invalid/lib-${n}.jpg` });
  }

  const o = await loadPacketOwnership(PACKET, fakeDb(tables));

  assert.equal(o.checkedAnyRun, true, "the imported run must still be CHECKED");
  assert.equal(o.unavailable, null);
  assert.deepEqual(o.declines, [], "a provenance-free item is not a decline");
  assert.equal(o.blocking.length, 7,
    "all seven real findings must survive — the same count as the packet without the inserted items");
  assert.ok(o.blocking.every((f) => !f.itemId.startsWith("library-")),
    "and none of them may accuse an item that has no source to be wrong against");
});

test("a Library item's photos are never judged against a source that never mentioned them", async () => {
  // The inverse risk: a provenance-free item holding photos must not be reported
  // as holding them on the "wrong record", because no record ever claimed it.
  const tables = incidentTables();
  const someSourceUrl = (tables.item_photos[0] as { url: string }).url;

  tables.items.push({
    id: "library-x", section_id: "sec-1", title: "Inserted from Library",
    origin_run_id: null, origin_chunk_ordinal: null, origin_emit_index: null,
  });
  // Deliberately the SAME url the source lists for an imported item.
  tables.item_photos.push({ item_id: "library-x", url: someSourceUrl });

  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.equal(o.checkedAnyRun, true);
  assert.equal(o.findings.filter((f) => f.itemId === "library-x").length, 0,
    "an item with no provenance can be neither right nor wrong about ownership");
  assert.equal(o.blocking.length, 7, "and it changes nothing about the real findings");
});

test("a packet of ONLY provenance-free items is clean, not undecidable", async () => {
  // The all-Library packet: nothing to prove, nothing to accuse, publishes.
  const tables = incidentTables();
  tables.items = tables.items.map((i) => ({ ...i, origin_run_id: null, origin_chunk_ordinal: null, origin_emit_index: null }));
  const o = await loadPacketOwnership(PACKET, fakeDb(tables));
  assert.deepEqual(o.findings, []);
  assert.deepEqual(o.blocking, []);
  assert.deepEqual(o.declines, []);
  assert.equal(o.unavailable, null);
});
