// Ownership verification, replayed against the REAL incidents.
// Run: node --test src/lib/media-ownership.test.mts
//
// Stage 1's ledger proves nothing was LOST. These tests prove the harder thing:
// that a photo belonging to source record A cannot sit on record B's item
// without being caught. Theft is conservative — the totals still balance — so
// counting alone is blind to it. See docs/investigations/media-ownership-provenance.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, splitRange, detectSourceRecords, DEFAULT_BUDGET } from "./segmentation.ts";
import { verifyOwnership, mediaOccurrences, type ChunkRange, type ProducedItem } from "./media-ownership.ts";
import { CLIENT_SOURCE, DRAKE_SOURCE } from "./__fixtures__/incident-sources.ts";

/** The plan a run actually executed, as persisted: ordinal + exact source range. */
const plan = (ranges: Array<[number, number]>): ChunkRange[] =>
  ranges.map(([start, end], ordinal) => ({ ordinal, start, end }));

/** What the model produced: one item per chunk, holding that chunk's media.
 *  This is how both incidents actually behaved — the model attributed every
 *  photo it could see to the entity it could see. */
function itemsFromChunks(source: string, chunks: ChunkRange[], titles: string[]): ProducedItem[] {
  return chunks.map((c, i) => ({
    chunkOrdinal: c.ordinal,
    title: titles[i],
    photos: mediaOccurrences(source).filter((m) => m.at >= c.start && m.at < c.end).map((m) => m.url),
  }));
}

// ------------------------------------------------------------------
// The 2026-08-14 client incident, replayed exactly
// ------------------------------------------------------------------
// The seg-v3 blank-line fallback plan, from the persisted run.
const CLIENT_INCIDENT_PLAN = plan([[0, 2856], [2856, 5125], [5125, 7751], [7751, 9767], [9767, 9885]]);
const CLIENT_INCIDENT_TITLES = [
  "The Reserve at Fountaingrove", "Brookdale Chanate", "Brookdale Paulin Creek",
  "Primrose", "Primrose Photo 4",
];

test("the client incident is caught: every stranded photo names its true owner", () => {
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  const items = itemsFromChunks(CLIENT_SOURCE, CLIENT_INCIDENT_PLAN, CLIENT_INCIDENT_TITLES);
  const report = verifyOwnership({ source: CLIENT_SOURCE, records, chunks: CLIENT_INCIDENT_PLAN, producedItems: items });

  assert.equal(report.fullyBound, true, "every item binds to exactly one record");
  assert.deepEqual(report.bindings, [0, 1, 2, 3, 3], "chunk 4 is a continuation of Primrose, not a new entity");

  const wrong = report.findings.filter((f) => f.code === "media_on_wrong_record");
  assert.equal(wrong.length, 7, "Reserve 4-5, Chanate 6-7, Paulin Creek 6-8");

  // Not merely 'something is off' — each names the item it must move to.
  assert.ok(wrong.every((f) => f.proposedItemIndex !== undefined), "each wrong photo has ONE resolvable destination");
  const moves = wrong.map((f) => `${f.itemIndex}->${f.proposedItemIndex}`);
  assert.deepEqual(
    moves,
    ["1->0", "1->0", "2->1", "2->1", "3->2", "3->2", "3->2"],
    "each stranded photo moves back exactly one record",
  );
});

test("the fabricated 'Primrose Photo 4' item is caught as a continuation, not accepted", () => {
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  const items = itemsFromChunks(CLIENT_SOURCE, CLIENT_INCIDENT_PLAN, CLIENT_INCIDENT_TITLES);
  const report = verifyOwnership({ source: CLIENT_SOURCE, records, chunks: CLIENT_INCIDENT_PLAN, producedItems: items });

  const fab = report.findings.filter((f) => f.code === "continuation_fabrication");
  assert.equal(fab.length, 1);
  assert.equal(fab[0].itemIndex, 4);
  assert.equal(fab[0].itemTitle, "Primrose Photo 4");
  assert.equal(fab[0].proposedItemIndex, 3, "its content belongs to the Primrose item that already exists");
  assert.equal(fab[0].proposedItemTitle, "Primrose");
});

test("the client incident under seg-v4 produces NO findings (the fix actually fixes it)", () => {
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  const segs = segment(CLIENT_SOURCE, DEFAULT_BUDGET);
  const chunks = plan(segs.map((s) => [s.sourceStart, s.sourceEnd] as [number, number]));
  const items = itemsFromChunks(CLIENT_SOURCE, chunks, chunks.map((_, i) => `Community ${i}`));
  const report = verifyOwnership({ source: CLIENT_SOURCE, records, chunks, producedItems: items });

  assert.deepEqual(report.findings, [], "no false positives on a correct plan");
  assert.deepEqual(report.bindings, [0, 1, 2, 3], "one item per record");
});

// ------------------------------------------------------------------
// The 2026-08-07 Drake Terrace incident
// ------------------------------------------------------------------
test("the drake incident is caught, and its corrected form is clean", () => {
  const records = detectSourceRecords(DRAKE_SOURCE)!.records;
  // A mid-record cut inside Atria strands its tail onto AlmaVia's chunk.
  const cut = 2600; // inside record 0 (0-2854)
  const chunks = plan([[0, cut], [cut, 4769], [4769, DRAKE_SOURCE.length]]);
  const items = itemsFromChunks(DRAKE_SOURCE, chunks, ["Atria Tamalpais Creek", "AlmaVia of San Rafael", "Drake Terrace"]);
  const report = verifyOwnership({ source: DRAKE_SOURCE, records, chunks, producedItems: items });

  const wrong = report.findings.filter((f) => f.code === "media_on_wrong_record");
  assert.ok(wrong.length > 0, "Atria photos stranded on AlmaVia must be caught");
  assert.ok(wrong.every((f) => f.itemIndex === 1 && f.proposedItemIndex === 0), "all point back to Atria");

  // The same source, planned correctly, must be silent.
  const segs = segment(DRAKE_SOURCE, DEFAULT_BUDGET);
  const good = plan(segs.map((s) => [s.sourceStart, s.sourceEnd] as [number, number]));
  const clean = verifyOwnership({
    source: DRAKE_SOURCE, records, chunks: good,
    producedItems: itemsFromChunks(DRAKE_SOURCE, good, ["Atria", "AlmaVia", "Drake Terrace"]),
  });
  assert.deepEqual(clean.findings, []);
});

// ------------------------------------------------------------------
// Ownership correctness and fabrication prevention are SEPARATE guarantees
// ------------------------------------------------------------------
function oversizedRecord() {
  const photos = Array.from({ length: 40 }, (_, i) =>
    `Image ${i + 1}: https://res.cloudinary.com/dkmsj5vdx/image/upload/v178000${i}/Big${i + 1}_aaaaaa.jpg`).join("\n\n");
  const prose = "A large community with extensive grounds and a full programme of activities. ".repeat(40);
  return ["Big Community", "Santa Rosa", `"Type: MC\n Capacity: 200"`, `"Pricing\n Studio - $9,000/month"`, prose, `"${photos}\n"`].join("\t");
}

test("a media-only continuation cannot fabricate a second standalone item", () => {
  const source = oversizedRecord();
  const records = detectSourceRecords(source)!.records;
  const kids = splitRange(source, 0, source.length);
  const chunks = plan(kids.map((k) => [k.start, k.end] as [number, number]));
  assert.ok(chunks.length >= 2, "the record is forced across chunks");

  // The failure mode: every chunk returns an item of its own.
  const titles = chunks.map((_, i) => (i === 0 ? "Big Community" : `Big Photo ${i}`));
  const report = verifyOwnership({ source, records, chunks, producedItems: itemsFromChunks(source, chunks, titles) });

  assert.ok(report.bindings.every((b) => b === 0), "every chunk belongs to the ONE record");
  const fab = report.findings.filter((f) => f.code === "continuation_fabrication");
  assert.equal(fab.length, chunks.length - 1, "every non-first chunk's item is flagged");
  assert.ok(fab.every((f) => f.proposedItemIndex === 0), "all merge into the real item");

  // Ownership is INDEPENDENTLY satisfied here: no photo is on the wrong record.
  // A run can be ownership-correct and still fabricate — hence two guarantees.
  assert.deepEqual(report.findings.filter((f) => f.code === "media_on_wrong_record"), []);

  // The correct behaviour — continuation chunks return nothing — is silent.
  const okItems: ProducedItem[] = [{ chunkOrdinal: 0, title: "Big Community", photos: mediaOccurrences(source).map((m) => m.url) }];
  assert.deepEqual(verifyOwnership({ source, records, chunks, producedItems: okItems }).findings, []);
});

// ------------------------------------------------------------------
// Ambiguity must surface as review, never as a second guess
// ------------------------------------------------------------------
test("when a record has several legitimate items, no move is proposed", () => {
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  // Record 0 legitimately produced TWO items (a community and its care wing).
  const chunks = CLIENT_INCIDENT_PLAN.slice(0, 2);
  const media = mediaOccurrences(CLIENT_SOURCE);
  const items: ProducedItem[] = [
    { chunkOrdinal: 0, title: "The Reserve", photos: [] },
    { chunkOrdinal: 0, title: "The Reserve — Memory Care", photos: [] },
    { chunkOrdinal: 1, title: "Brookdale Chanate", photos: media.filter((m) => m.at >= 2856 && m.at < 5125).map((m) => m.url) },
  ];
  const report = verifyOwnership({ source: CLIENT_SOURCE, records, chunks, producedItems: items });

  // Chunk 0 begins one record but produced two items: unverifiable, not guessed.
  const unver = report.findings.filter((f) => f.code === "ownership_unverifiable");
  assert.equal(unver.length, 2, "both of chunk 0's items are unbindable");
  assert.ok(unver.every((f) => f.proposedItemIndex === undefined), "no destination is invented");
  assert.ok(report.findings.length > 0, "ambiguity still blocks — it is never silently accepted");
  assert.equal(report.fullyBound, false);
});

// ------------------------------------------------------------------
// Two defects found while reviewing 0014, fixed here
// ------------------------------------------------------------------
test("the same URL in two DIFFERENT records is ambiguous, not a confident accusation", () => {
  // Record 0 and record 1 both list P; item 2 (Charlie) holds it and is bound to
  // record 2, which does not. So the copy is provably misplaced, but the source
  // does not say WHICH of the two records it belongs to. The old code took
  // sourceRecords[0] and accused record 0 with full confidence.
  //
  // Note the deliberate asymmetry: an item bound to record 0 OR record 1 holding
  // P is left alone, because that placement cannot be shown to be wrong.
  const P = "https://cdn.example.com/shared.jpg";
  const source = `Alpha\tone\t${P}\nBravo\ttwo\t${P}\nCharlie\tthree\tx`;
  const records = detectSourceRecords(source)!.records;
  assert.equal(records.length, 3);
  const chunks = plan(records.map((r) => [r.start, r.end] as [number, number]));
  const items: ProducedItem[] = [
    { chunkOrdinal: 0, title: "Alpha", photos: [] },
    { chunkOrdinal: 1, title: "Bravo", photos: [] },
    { chunkOrdinal: 2, title: "Charlie", photos: [P] },
  ];
  const report = verifyOwnership({ source, records, chunks, producedItems: items });
  const amb = report.findings.filter((f) => f.code === "ownership_unverifiable" && f.url === P);
  assert.equal(amb.length, 1, "surfaced as unresolvable rather than silently accepted");
  assert.equal(amb[0].proposedItemIndex, undefined, "no destination is invented");
  assert.deepEqual(report.findings.filter((f) => f.code === "media_on_wrong_record"), [],
    "and NOT reported as a confident wrong-record move");

  // The asymmetry: the same photo on an item bound to one of the two candidate
  // records is NOT accused, because that placement cannot be shown to be wrong.
  const plausible = verifyOwnership({ source, records, chunks, producedItems: [
    { chunkOrdinal: 0, title: "Alpha", photos: [] },
    { chunkOrdinal: 1, title: "Bravo", photos: [P] },
    { chunkOrdinal: 2, title: "Charlie", photos: [] },
  ] });
  assert.deepEqual(plausible.findings, [], "a defensible placement is left alone");
});

test("an item holding one URL twice yields ONE finding, not two identical ones", () => {
  // The correct repair for a source that lists a photo twice puts two identical
  // rows on one item. That must not become two indistinguishable findings.
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  const chunks = CLIENT_INCIDENT_PLAN.slice(0, 2);
  const stranded = mediaOccurrences(CLIENT_SOURCE)
    .filter((m) => m.at >= 2856 && m.at < 3109)[0];
  assert.ok(stranded, "record 0 has media stranded in chunk 1");
  const items: ProducedItem[] = [
    { chunkOrdinal: 0, title: "The Reserve", photos: [] },
    { chunkOrdinal: 1, title: "Brookdale Chanate", photos: [stranded.url, stranded.url] },
  ];
  const report = verifyOwnership({ source: CLIENT_SOURCE, records, chunks, producedItems: items });
  const forUrl = report.findings.filter((f) => f.url === stranded.url);
  assert.equal(forUrl.length, 1, "deduped per (url, item)");
  assert.equal(forUrl[0].code, "media_on_wrong_record");
  assert.equal(forUrl[0].proposedItemIndex, 0);
});
