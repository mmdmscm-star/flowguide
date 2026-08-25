// THE WHOLE-SOURCE FALLBACK — an unowned fact is still a fact.
//
// Record-level governance can only speak for items it can ATTRIBUTE to a source
// record, and records were provable in only four of sixteen ordinary inputs. For
// the rest the contract had nothing to say, so a fact the model dropped left no
// trace anywhere.
//
// This answers a strictly weaker question that needs no owner: did the fact
// survive ANYWHERE in the draft? It never places anything, because choosing a
// destination without provable ownership is the silent decision the contract
// exists to prevent.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceChunkResult } from "./enforce-chunk.ts";

const SOURCE = `SHORTLIST

Riverbend Studio
$1,800/day. 3,000 sq ft, blackout capable, in-house grip.
riverbend.example.com | Booking: Nia Patel 646-555-0188

Fifth Street Stage
$2,400/day. Bigger, has a cyc wall.
`;

const item = (over: Record<string, unknown> = {}) => ({
  title: "Riverbend Studio",
  description: "3,000 sq ft, blackout capable, in-house grip.",
  details: [{ label: "Day rate", value: "$1,800/day" }],
  links: [], photos: [],
  contacts: [{ name: "Nia Patel", role: "Booking", phone: "646-555-0188" }],
  ...over,
});

const run = (items: Record<string, unknown>[]) => enforceChunkResult({
  segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
  result: { items }, destination: "packet",
});
const tel = (o: ReturnType<typeof run>) => o.telemetry as unknown as Record<string, number>;

test("PREMISE: this source has no provable records, so nothing is governed", () => {
  assert.equal(tel(run([item()])).itemsGoverned, 0,
    "the source gained record structure — this fixture no longer tests the fallback");
});

test("A DROPPED FACT BECOMES VISIBLE instead of vanishing", () => {
  const out = run([item()]);            // links empty: the URL was not carried
  const t = tel(out);
  assert.equal(t.wholeSourceChecked, 2, "expected the URL and the phone to be checked");
  assert.equal(t.wholeSourceMissing, 1);
  const surfaced = out.unresolved.filter((u) => u.record === -1);
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0].text, "riverbend.example.com");
  assert.equal(surfaced[0].kind, "source-unresolved");
});

test("provenance survives even where ownership does not", () => {
  const u = run([item()]).unresolved.find((x) => x.record === -1)!;
  assert.equal(typeof u.offset, "number");
  assert.equal(SOURCE.slice(u.offset!, u.offset! + 21), "riverbend.example.com",
    "the recorded offset does not point at the fact");
});

test("IT NEVER BLOCKS — an unowned fact is a note, not a question", () => {
  // source-unresolved is OBSERVED_ONLY, so it must produce no review unit and
  // therefore cannot stop a publish. Record structure being unavailable is not
  // the professional's problem to answer for.
  assert.deepEqual(run([item()]).reviewUnits, []);
});

test("AND IT NEVER PLACES ANYTHING", () => {
  const out = run([item()]);
  const after = (out.result as { items: Record<string, unknown>[] }).items[0];
  assert.deepEqual(after.links, [], "the fallback invented a destination for the fact");
  assert.equal(after.title, "Riverbend Studio");
});

test("a fact that DID survive is accounted for, not surfaced", () => {
  const out = run([item({ links: [{ url: "riverbend.example.com", label: "Website" }] })]);
  const t = tel(out);
  assert.equal(t.wholeSourceChecked, 2);
  assert.equal(t.wholeSourcePresent, 2);
  assert.equal(t.wholeSourceMissing, 0);
  assert.deepEqual(out.unresolved.filter((u) => u.record === -1), []);
});

test("canonical presence: reformatting is not disappearance", () => {
  // The scheme supplied, the phone re-punctuated. Both are the SAME fact.
  const out = run([item({
    links: [{ url: "https://riverbend.example.com/", label: "Website" }],
    contacts: [{ name: "Nia Patel", phone: "(646) 555-0188" }],
  })]);
  assert.equal(tel(out).wholeSourceMissing, 0, "a reformatted fact was reported missing");
});

test("PRECISION: reshaped prose is NOT treated as a missing fact", () => {
  // Nine of ten apparent omissions on the corpus were `labelled` claims where a
  // whole line became one claim and the content survived reshaped. Governing
  // only url/phone/email is what keeps those nine out of the results.
  const prose = "Mon 9:00 — Kickoff with the exec team, 90 min, conference room B\n" +
                "Tue 13:00 — Systems walkthrough with IT, 2 hrs, remote\n";
  const out = enforceChunkResult({
    segmentText: prose, chunkOrdinal: 0, sourceStart: 0, sourceText: prose,
    result: { items: [{ title: "Kickoff", description: "Exec team, 90 minutes, room B" }] },
    destination: "packet",
  });
  assert.equal(tel(out).wholeSourceMissing, 0, "a reshaped prose line was surfaced as a lost fact");
  assert.deepEqual(out.unresolved.filter((u) => u.record === -1), []);
});

test("one fact written twice is reported once", () => {
  const twice = SOURCE + "\nAlso: riverbend.example.com\n";
  const out = enforceChunkResult({
    segmentText: twice, chunkOrdinal: 0, sourceStart: 0, sourceText: twice,
    result: { items: [item()] }, destination: "packet",
  });
  assert.equal(out.unresolved.filter((u) => u.record === -1 && u.text.includes("riverbend")).length, 1);
});

test("the fallback is off when enforcement is off", () => {
  const prev = process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "0";
  try {
    const out = run([item()]);
    assert.deepEqual(out.unresolved, []);
    assert.equal(tel(out).wholeSourceChecked ?? 0, 0);
  } finally { process.env.FLOWGUIDE_ENFORCE_CONTRACT = prev; }
});
