// The data-loading half of ownership. Run: node --test src/lib/ownership-service.test.mts
//
// ownership-recompute.test.mts already pins the RULES. What is only decidable
// here is what happens when the database does not cooperate: a table that is not
// there yet, a run row that outlived its items, a query that simply fails.
//
// One direction of failure is dangerous and the rest are not. Losing photos, or
// items, or a source makes findings DISAPPEAR — the check goes quiet, publishing
// proceeds, and the professional is no worse off than before this feature
// existed. Losing the OVERRIDES makes findings REAPPEAR: a Keep that was already
// recorded stops being seen, a resolved packet looks unresolved, and the person
// who did the work is blocked by their own resolution sitting unread in a table.
// That asymmetry is the whole subject of this file.
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
  assert.equal(o.overridesReadable, true);
  assert.deepEqual(o.declines, []);
  assert.equal(o.blocking.length, 7, "seven misplaced photos, same as the pure recompute finds");
  assert.ok(o.blocking.every((f) => f.code === "media_on_wrong_record"));
  assert.ok(o.blocking.every((f) => f.itemId && f.url), "each names the row and the photo an RPC would act on");
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
test("an unreadable decisions table withdraws the block instead of discarding every Keep", async () => {
  // The live shape of this on the day 0016 ships: the code is deployed, the
  // migration is not yet applied, and the table does not exist. Reading no rows
  // and calling that "no Keeps" would block every affected packet, and the one
  // action that clears the block writes to the table that is missing.
  const clean = await loadPacketOwnership(PACKET, fakeDb(incidentTables()));
  const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), {
    item_media_decisions: 'relation "public.item_media_decisions" does not exist',
  }));

  assert.equal(o.overridesReadable, false);
  assert.deepEqual(o.blocking, [], "nothing may block while the overrides are unknown");
  assert.deepEqual(o.findings, clean.findings,
    "but every finding is still reported — the signal is withheld from the GATE, not thrown away");
  assert.equal(o.findings.filter((f) => f.code === "media_on_wrong_record").length, 7);
  assert.equal(o.declines.length, 1, "and the reason is recorded rather than inferred from silence");
  assert.equal(o.declines[0].reason, "provenance_unreadable");
  assert.match(o.declines[0].detail, /item_media_decisions/);
});

test("a failure to read decisions is distinguishable from having read zero of them", async () => {
  const clean = await loadPacketOwnership(PACKET, fakeDb(incidentTables()));
  const broken = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { item_media_decisions: "boom" }));

  // Both saw an empty override set. Only one of them KNOWS it.
  assert.equal(clean.overridesReadable, true);
  assert.equal(broken.overridesReadable, false);
  assert.equal(clean.blocking.length, 7);
  assert.equal(broken.blocking.length, 0);
});

// ---------------------------------------------------------------------------
// Every other read fails open, and says so.
// ---------------------------------------------------------------------------
test("every other failed read reports nothing and blocks nothing, with a reason", async () => {
  for (const table of ["packets", "sections", "items", "item_photos", "ingestion_runs", "ingestion_chunks"]) {
    const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { [table]: `${table} unavailable` }));
    assert.deepEqual(o.blocking, [], `${table}: a failed read must never block`);
    assert.deepEqual(o.findings, [], `${table}: nothing was proven, so nothing is claimed`);
    assert.equal(o.checkedAnyRun, false, `${table}: must not report itself as checked`);
    assert.equal(o.declines.length, 1, `${table}: the failure has to be visible`);
    assert.equal(o.declines[0].reason, "provenance_unreadable");
    assert.match(o.declines[0].detail, new RegExp(table));
  }
});

test("unreadable photos never pass as an item with no photos", async () => {
  // The quiet version of this bug: an item whose photo rows failed to load looks
  // identical to an item holding none, and every misplaced photo in the packet
  // is pronounced clean.
  const o = await loadPacketOwnership(PACKET, fakeDb(incidentTables(), { item_photos: "timeout" }));
  assert.equal(o.checkedAnyRun, false);
  assert.equal(o.declines[0].reason, "provenance_unreadable");
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
