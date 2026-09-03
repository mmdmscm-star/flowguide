// Regression tests against the TWO REAL ingestion incidents (PII sanitized).
// Run: node --test src/lib/segmentation-incidents.test.mts
//
// These pin the failure that reached a live client packet: a chunk boundary
// falling inside a source record, orphaning that record's trailing media onto
// the next chunk. See docs/investigations/client-photo-ownership-incident.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, splitRange, detectSourceRecords, DEFAULT_BUDGET, SEGMENTER_VERSION } from "./segmentation.ts";
import { CLIENT_SOURCE, DRAKE_SOURCE } from "./__fixtures__/incident-sources.ts";

const MEDIA = /https:\/\/res\.cloudinary\.com\/\S+?\.jpg/g;
const mediaOffsets = (s: string) => [...s.matchAll(MEDIA)].map((m) => ({ url: m[0], at: m.index! }));

/** The invariant: a chunk may hold ONE record (whole or part), or several WHOLE
 *  records — but never a part of one record together with another record. */
function partialRecordViolations(source: string, budget = DEFAULT_BUDGET) {
  const det = detectSourceRecords(source);
  if (!det) return null;
  const segs = segment(source, budget);
  const bad: string[] = [];
  for (const c of segs) {
    const overlapping = det.records.filter((r) => r.start < c.sourceEnd && r.end > c.sourceStart);
    if (overlapping.length <= 1) continue;
    const allWhole = overlapping.every((r) => r.start >= c.sourceStart && r.end <= c.sourceEnd);
    if (!allWhole) bad.push(`chunk ${c.ordinal} [${c.sourceStart},${c.sourceEnd}) straddles ${overlapping.length} records`);
  }
  return bad;
}

/** Every media occurrence must sit in a chunk that also holds its own record. */
function separatedMedia(source: string) {
  const det = detectSourceRecords(source)!;
  const segs = segment(source, DEFAULT_BUDGET);
  const chunkOf = (off: number) => segs.findIndex((s) => off >= s.sourceStart && off < s.sourceEnd);
  const recordOf = (off: number) => det.records.findIndex((r) => off >= r.start && off < r.end);
  const out: string[] = [];
  for (const m of mediaOffsets(source)) {
    const rec = det.records[recordOf(m.at)];
    const mediaChunk = chunkOf(m.at);
    const recordHeadChunk = chunkOf(rec.start);
    if (mediaChunk !== recordHeadChunk) out.push(`${m.url.slice(-28)} in chunk ${mediaChunk}, record starts in ${recordHeadChunk}`);
  }
  return out;
}

test("segmenter version is pinned to seg-v4", () => {
  assert.equal(SEGMENTER_VERSION, "seg-v4");
});

// ------------------------------------------------------------------
// The 2026-08-14 client incident
// ------------------------------------------------------------------
test("client source: cosmetic '----' rows no longer defeat detection", () => {
  const det = detectSourceRecords(CLIENT_SOURCE);
  assert.ok(det, "seg-v3 declined here; seg-v4 must accept");
  assert.equal(det!.delimiter, "\t");
  assert.equal(det!.fields, 6);
  assert.equal(det!.records.length, 4, "four communities");
  assert.equal(det!.separatorRows, 4, "four '----' rows tolerated as separators");
});

test("client source: one chunk per community, no photo separated", () => {
  const segs = segment(CLIENT_SOURCE, DEFAULT_BUDGET);
  assert.equal(segs.length, 4, "the incident produced 5 chunks; records give 4");
  assert.deepEqual(partialRecordViolations(CLIENT_SOURCE), []);
  assert.deepEqual(separatedMedia(CLIENT_SOURCE), [], "8 of 24 were separated in the incident");
});

test("client source: no content-free tail chunk can exist", () => {
  // Chunk 4 of the incident was 118 chars containing one URL and the word
  // "Image" — the model had to invent "Primrose Photo 4" from the filename.
  for (const s of segment(CLIENT_SOURCE, DEFAULT_BUDGET)) {
    const letters = s.text.replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}]/gu, "").length;
    assert.ok(letters > 40, `chunk ${s.ordinal} must carry real text, not just URLs (got ${letters})`);
  }
});

test("client source: all 24 media occurrences survive the plan", () => {
  const all = segment(CLIENT_SOURCE, DEFAULT_BUDGET).flatMap((s) => mediaOffsets(s.text).map((m) => m.url));
  assert.equal(all.length, 24, "24 occurrences (23 unique — one is listed twice in the source)");
  assert.equal(new Set(all).size, 23);
});

// ------------------------------------------------------------------
// The 2026-08-07 Drake Terrace incident
// ------------------------------------------------------------------
test("drake source: three records, one chunk each, no photo separated", () => {
  const det = detectSourceRecords(DRAKE_SOURCE);
  assert.ok(det);
  assert.equal(det!.records.length, 3);
  assert.equal(segment(DRAKE_SOURCE, DEFAULT_BUDGET).length, 3);
  assert.deepEqual(partialRecordViolations(DRAKE_SOURCE), []);
  assert.deepEqual(separatedMedia(DRAKE_SOURCE), []);
});

test("drake source: all 19 photos survive, none duplicated across chunks", () => {
  const all = segment(DRAKE_SOURCE, DEFAULT_BUDGET).flatMap((s) => mediaOffsets(s.text).map((m) => m.url));
  assert.equal(all.length, 19);
  assert.equal(new Set(all).size, 19);
});

// ------------------------------------------------------------------
// The append marker: OUR shapes only
// ------------------------------------------------------------------
test("only Sendset's own generated append marker counts as a separator", () => {
  const row = (label: string) => `A\tB\tC\n${label}\nD\tE\tF\nG\tH\tI`;
  // Both shapes we emit: bare (finalize/SQL) and timestamped (append routes).
  for (const marker of ["--- Added ---", "--- Added Jun 30, 2026, 6:57 PM ---", "--- Added Jul 13, 2026, 7:24 PM ---", "----", "===="]) {
    const det = detectSourceRecords(row(marker));
    assert.ok(det, `${marker} should be tolerated as a separator`);
    assert.equal(det!.records.length, 3, `${marker}: three data rows`);
  }
  // User text that merely looks similar must NOT be swallowed as system noise.
  for (const userText of ["--- Added photos from tour ---", "--- Added notes ---", "--- Notes ---"]) {
    const det = detectSourceRecords(row(userText));
    assert.equal(det, null, `${userText} is user content, not a separator — detection must decline`);
  }
});

// ------------------------------------------------------------------
// One oversized record that MUST span chunks, with a media-only tail
// ------------------------------------------------------------------
function oversizedRecord() {
  const photos = Array.from({ length: 40 }, (_, i) =>
    `Image ${i + 1}: https://res.cloudinary.com/dkmsj5vdx/image/upload/v178000${i}/Big${i + 1}_aaaaaa.jpg`).join("\n\n");
  const prose = "A large community with extensive grounds and a full programme of activities. ".repeat(40);
  const rec = ["Big Community", "Santa Rosa", `"Type: MC\n Capacity: 200"`, `"Pricing\n Studio - $9,000/month"`, prose, `"${photos}\n"`].join("\t");
  return { source: rec, photos: 40 };
}

test("an oversized single record spans chunks WITHOUT breaking ownership", () => {
  const { source, photos } = oversizedRecord();
  const det = detectSourceRecords(source);
  assert.ok(det, "a single record is trivially aligned");
  assert.equal(det!.records.length, 1);
  assert.ok(source.length > DEFAULT_BUDGET.maxChars * 1.6, "fixture must exceed the pre-split threshold");

  // Splitting is forced. Every child must stay INSIDE the one record, so every
  // photo still belongs to the record its chunk belongs to — ownership holds.
  const children = splitRange(source, 0, source.length);
  assert.ok(children.length >= 2, "an oversized record is split");
  const r = det!.records[0];
  for (const c of children) {
    assert.ok(c.start >= r.start && c.end <= r.end, "child stays within the single record");
  }
  let joined = "";
  for (const c of children) joined += source.slice(c.start, c.end);
  assert.equal(joined, source, "children tile the record exactly");

  const all = children.flatMap((c) => mediaOffsets(source.slice(c.start, c.end)));
  assert.equal(all.length, photos, "no media lost across the split");
});

test("a media-only continuation tail is identifiable as the SAME record", () => {
  // This is the precondition for the no-fabrication guarantee: the tail must be
  // recognisable as a continuation of a record that already has an item, rather
  // than as a new entity. Ownership correctness and fabrication prevention are
  // separate guarantees — this proves the structural fact the second one needs.
  const { source } = oversizedRecord();
  const det = detectSourceRecords(source)!;
  const children = splitRange(source, 0, source.length);
  const recordOfChunk = (c: { start: number; end: number }) =>
    det.records.findIndex((r) => r.start < c.end && r.end > c.start);

  const owners = children.map(recordOfChunk);
  assert.deepEqual([...new Set(owners)], [0], "every chunk belongs to record 0");

  const tail = children[children.length - 1];
  const tailText = source.slice(tail.start, tail.end);
  assert.ok(mediaOffsets(tailText).length > 0, "the tail carries media");
  assert.notEqual(children.indexOf(tail), 0, "the tail is a NON-FIRST chunk of its record");
  // => the pipeline can tell this tail continues record 0 and must not create a
  //    second standalone item for it.
});
