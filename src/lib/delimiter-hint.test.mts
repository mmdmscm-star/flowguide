// THE HINTED PATH — a delimiter the professional declared by choosing a file.
//
// The inference detector has to work out from the text alone whether a comma is
// a column separator or a comma, and the guards that make that safe are exactly
// why an ordinary one-line-per-row CSV is invisible to it: every record is one
// line. When someone picks a .csv the delimiter is a fact, so those guards have
// nothing left to protect against.
//
// The two properties that matter most here are NEGATIVE: unhinted sources must
// segment exactly as before (so no segmenter version is owed), and a hint must
// never override a better answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectDelimitedRecords, detectSourceRecords } from "./segmentation.ts";
import { recordEnvelopes } from "./attribution.ts";
import { delimiterForFile } from "./text-file-import.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const CSV =
  'Name,Day rate,Capacity,Catering,Contact,Phone\n' +
  'The Foundry,"$4,200",120,"In-house, from $58/head",Dana Reyes,206-555-0118\n' +
  'Harborlight Loft,"$5,600",90,"External, approved list",Sam Okonjo,206-555-0164\n' +
  'Union Hall,"$2,900",220,"External, no restrictions",,';

const TSV =
  "Name\tAddress\tDay rate\tCapacity\tContact\n" +
  "The Foundry\t41 Mill St\t$4,200\t120\tDana Reyes 206-555-0118\n" +
  "Harborlight Loft\t9 Pier Rd\t$5,600\t90\tSam Okonjo 206-555-0164\n" +
  "Union Hall\t12 Canal St\t$2,900\t220\t";

const PROSE =
  "Looked at Glenview Academy first — $18,400 tuition, strong music program, 22 min drive.\n" +
  "Then Hartwell School, $21,000, smaller classes.\n" +
  "Also Beacon Prep at $16,900, furthest away at 40 min.\n";

const BULLETS =
  "Places I looked at:\n\n" +
  "- Brightwater Apartments — 2br from $2,450/mo, has parking, brightwater.example.com\n" +
  "- Kestrel Court — cheaper, $2,100, but no in-unit laundry\n" +
  "- Alder Row — $2,800, newest of the three, gym + roof deck\n";

test("AN ORDINARY CSV IS RECOGNISED — the case inference cannot reach", () => {
  assert.equal(detectSourceRecords(CSV), null, "inference should still decline; that is the premise");
  const d = detectDelimitedRecords(CSV, ",");
  assert.ok(d, "the declared delimiter did not produce records");
  assert.equal(d!.records.length, 4, "header plus three rows");
  assert.equal(d!.fields, 6);
});

test("a blank trailing cell does not disqualify a row", () => {
  // Union Hall has no contact and no phone. That is an ordinary export, not a
  // broken table: the row still carries the table's delimiter slots.
  const d = detectDelimitedRecords(TSV, "\t");
  assert.ok(d, "a row with an empty last column was rejected");
  assert.equal(d!.records.length, 4);
});

test("PROSE IS STILL PROSE, even when a delimiter is declared", () => {
  // The guard that matters: a .csv containing sentences must not be forced into
  // a table. Rows here have different widths, so the shape is not a table.
  assert.equal(detectDelimitedRecords(PROSE, ","), null);
  assert.equal(recordEnvelopes(PROSE, ","), null);
});

test("a torn paste declines rather than guessing", () => {
  assert.equal(detectDelimitedRecords('a,b\n"unterminated,c\n', ","), null);
});

test("a row WIDER than the table declines — misalignment is not a short row", () => {
  const misaligned = "A,B,C\n1,2,3\n1,2,3,4\n";
  assert.equal(detectDelimitedRecords(misaligned, ","), null);
});

test("only the two delimiters a file extension can declare are honoured", () => {
  assert.equal(detectDelimitedRecords("a;b;c\n1;2;3\n", ";"), null);
  assert.equal(detectDelimitedRecords("a|b|c\n1|2|3\n", "|"), null);
});

test("THE HINT IS ADDITIVE ONLY — a better answer always wins", () => {
  // A bulleted list saved as .csv is still a bulleted list. The list strategy
  // reads it faithfully; a comma scan would not.
  const unhinted = recordEnvelopes(BULLETS);
  const hinted = recordEnvelopes(BULLETS, ",");
  assert.equal(unhinted?.length, 3, "premise: the list strategy finds three");
  assert.deepEqual(hinted?.map((e) => e.name), unhinted?.map((e) => e.name),
    "the hint overrode a strategy that had already succeeded");
});

test("and it only ever ADDS where nothing was provable", () => {
  assert.equal(recordEnvelopes(CSV), null);
  assert.equal((recordEnvelopes(CSV, ",") ?? []).length, 4);
});

test("NO SEGMENTER VERSION IS OWED — segment() never consults the hint", () => {
  // This is the property that keeps every existing run's chunk plan valid. If
  // segment() ever reads the hinted detector, chunk boundaries become
  // hint-dependent and SEGMENTER_VERSION must be bumped.
  const seg = codeOf("src/lib/segmentation.ts");
  const segmentFn = seg.slice(seg.indexOf("export function segment("));
  assert.doesNotMatch(segmentFn, /detectDelimitedRecords/,
    "segment() now depends on the hint — bump SEGMENTER_VERSION or revert");
  // And the inference detector must be untouched by the hinted path.
  const inference = seg.slice(seg.indexOf("export function detectSourceRecords("),
                              seg.indexOf("export function detectDelimitedRecords("));
  assert.doesNotMatch(inference, /delimiterHint|width/,
    "the inference detector started reading hint-only state");
});

test("a file extension declares the delimiter; nothing else does", () => {
  assert.equal(delimiterForFile("venues.csv"), ",");
  assert.equal(delimiterForFile("VENUES.CSV"), ",");
  assert.equal(delimiterForFile("data.tsv"), "\t");
  for (const n of ["notes.txt", "notes.md", "notes.markdown", "noextension"]) {
    assert.equal(delimiterForFile(n), null, `${n} should declare nothing`);
  }
});

test("the route accepts only a declared delimiter, never an arbitrary one", () => {
  const route = codeOf("src/app/api/ingest/organize/route.ts");
  assert.match(route, /rawHint === "\\t" \|\| rawHint === ","/,
    "the organize route trusts an arbitrary delimiter from the request body");
  assert.match(route, /p_delimiter_hint: delimiterHint/, "the hint is not persisted");
});

test("the hint is carried to BOTH readers, from the run row", () => {
  // Enforcement and ownership recompute both re-derive records. Reaching
  // different answers is the failure the stored hint exists to prevent.
  assert.match(codeOf("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts"),
    /delimiterHint: \(run\.delimiter_hint/, "enforcement does not receive the persisted hint");
  assert.match(codeOf("src/lib/ownership-recompute.ts"),
    /run\.delimiterHint \? detectDelimitedRecords/, "ownership cannot reproduce the import's decision");
});
