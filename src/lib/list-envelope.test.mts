// ADVERSARIAL TESTS for the repeated list/directory envelope strategy.
// The rule under test is structural: a repeated top-level marker, at one
// indentation, contiguous when numbered. No vocabulary of any kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectListRecords } from "./segmentation.ts";
import { recordEnvelopes } from "./attribution.ts";

const tile = (src: string, recs: { start: number; end: number }[]) => {
  // Envelopes must tile their region with no overlap and no gap.
  for (let i = 1; i < recs.length; i++) assert.equal(recs[i - 1].end, recs[i].start, `gap/overlap at ${i}`);
  assert.equal(recs[recs.length - 1].end, src.length, "last envelope must reach the end");
};

test("numbered records with multiline content AND internal blank lines", () => {
  const src = `Directory Title
Some intro prose.

1. First Entry — Somewhere
Address
1 A St

Phone
(503) 555-0001

2. Second Entry — Elsewhere
Address
2 B St

Phone
(503) 555-0002

3. Third Entry — Nowhere
Address
3 C St
`;
  const d = detectListRecords(src)!;
  assert.ok(d, "declined a plain numbered directory");
  assert.equal(d.kind, "numbered");
  assert.equal(d.records.length, 3, "blank lines inside a record must not split it");
  tile(src, d.records.slice(0, 3));
  // The preamble belongs to no record.
  assert.ok(d.records[0].start > src.indexOf("Some intro prose"), "preamble was swallowed into record 1");
  assert.match(d.labels[0], /^First Entry/);
});

test("bulleted repeated records", () => {
  const src = `- Alpha Co\nphone 1\n\n- Bravo Co\nphone 2\n\n- Cedar Co\nphone 3\n`;
  const d = detectListRecords(src)!;
  assert.equal(d.kind, "bulleted");
  assert.equal(d.records.length, 3);
});

test("a numbered SUBLIST inside a description does not open records", () => {
  const src = `1. First Entry
Our process:
   1. consult
   2. measure
   3. install
More prose here.

2. Second Entry
Our process:
   1. consult
   2. measure
   3. install

3. Third Entry
Done.
`;
  const d = detectListRecords(src)!;
  assert.equal(d.records.length, 3, `indented sublists created ${d.records.length} records`);
  assert.match(d.labels[1], /^Second Entry/);
});

test("MISSING ordinal breaks contiguity — decline rather than misbind", () => {
  const src = `1. First\nx\n\n2. Second\ny\n\n4. Fourth\nz\n\n5. Fifth\nw\n`;
  assert.equal(detectListRecords(src), null, "a gap in the sequence must not be guessed through");
});

test("DUPLICATE ordinal breaks contiguity", () => {
  const src = `1. First\nx\n\n2. Second\ny\n\n2. Second again\nz\n\n3. Third\nw\n`;
  assert.equal(detectListRecords(src), null);
});

test("a sequence that does not start at 1 is declined", () => {
  const src = `7. Seventh\nx\n\n8. Eighth\ny\n\n9. Ninth\nz\n`;
  assert.equal(detectListRecords(src), null, "a mid-list fragment is not a provable record set");
});

test("trailing prose after the last record stays with that record", () => {
  const src = `1. A\nx\n\n2. B\ny\n\n3. C\nz\n\nThanks for reading.\n`;
  const d = detectListRecords(src)!;
  assert.equal(d.records.length, 3);
  assert.equal(d.records[2].end, src.length);
  assert.ok(src.slice(d.records[2].start).includes("Thanks for reading"));
});

test("fewer than three markers is not a list", () => {
  assert.equal(detectListRecords(`1. Only\nx\n\n2. Two\ny\n`), null);
});

test("unstructured prose remains ATTRIBUTION_UNRESOLVED", () => {
  const src = `We visited several places this week. The first was pleasant.
The second had a longer wait. The third was closed for renovation.

Overall it was a useful trip and we learned a lot about the area.
`;
  assert.equal(detectListRecords(src), null);
  assert.equal(recordEnvelopes(src), null, "guessed envelopes for unstructured prose");
});

test("the tabular strategy still wins for delimited sources", () => {
  // A TSV whose cells contain bulleted lines must not be reinterpreted as a list.
  const src = `Alpha\tX\t"- $10/mo Studio\n- $20/mo One Bed"\nBravo\tY\t"- $30/mo Studio\n- $40/mo One Bed"\nCedar\tZ\t"- $50/mo Studio\n- $60/mo One Bed"\n`;
  const env = recordEnvelopes(src)!;
  assert.equal(env.length, 3, "list strategy hijacked a delimited table");
  assert.equal(env[0].name, "Alpha");
});
