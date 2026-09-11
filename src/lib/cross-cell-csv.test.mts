// A DETAIL STOPS AT THE CELL — pinned to the case that proved it matters.
//
// A real CSV of Marin contractors reached a draft with one detail carrying
// this, as a single value:
//
//   "Hourly consulting option: $225/hour for smaller scopes.",Design work can
//    begin within 2 weeks,Not applicable — design services,Accepting one new
//    kitchen project this fall,… Willow Creek Remodels,Petaluma,"620 Petaluma
//    Blvd N, …"
//
// — the closing quote of a multi-line field, then four more columns of that
// record, then the NEXT record. Four hundred and ninety-six characters of one
// contractor's row filed as another contractor's price.
//
// THE CSV WAS VALID. Quotes balanced; those embedded newlines are a legal
// multi-line quoted field. The chunker was clean too: it split the source at a
// record boundary and both halves came out quote-balanced. The model produced
// the run-on, and it produced it while ALSO parsing the same columns correctly
// into their own details — so the wrong value sat beside the right ones.
//
// Enforcement has caught this since f721b75 ("a hostname stops at the comma,
// and a detail stops at the cell"), which landed about fourteen hours after
// that run finalised. Nothing needed fixing when this was traced; what was
// missing was anything holding the guard to the shape that defeated it. These
// are the real rows, trimmed.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceChunkResult } from "./enforce-chunk.ts";

const HEADER = "Firm,City,Address,Specialty,Description,Estimate / Pricing,Timeline,Warranty,Availability";
/** Two real records. The first carries a multi-line quoted pricing field whose
 *  final line closes the quote and is followed by four more columns. */
const SOURCE = [
  HEADER,
  'Oak & Tile Interiors,San Rafael,"1535 4th St, San Rafael, CA 94901",Design and coordination,' +
    'Interior design studio handling space planning and finish selections,' +
    '"Fixed design fee: $12,000 for concept through construction selections',
  ' Hourly consulting option: $225/hour for smaller scopes.",' +
    'Design work can begin within 2 weeks,Not applicable — design services,' +
    'Accepting one new kitchen project this fall',
  'Willow Creek Remodels,Petaluma,"620 Petaluma Blvd N, Petaluma, CA 94952",Value kitchens,' +
    'Family-run remodeler serving Marin and Sonoma,Standard package starts around $42,000,' +
    'Usually 6–8 weeks of construction,1-year workmanship warranty,Site visits available this month',
].join("\n");

/** The run-on, taken FROM the source so it is genuinely a substring that
 *  crosses cells rather than an approximation of one. It starts inside the
 *  quoted pricing field, passes the closing quote and the record's remaining
 *  columns, and ends inside the NEXT record.
 *
 *  The record break becomes a space, which is what the model does with it and
 *  why `spansCells` matches whitespace-flexibly. Writing this fixture by hand
 *  put a comma there instead, and the guard correctly found nothing — the
 *  string did not exist in the source, so no boundary could be shown to have
 *  been crossed. */
const RUN_ON = SOURCE.slice(
  SOURCE.indexOf("$225/hour"),
  SOURCE.indexOf('"620 Petaluma Blvd N, Petaluma, CA 94952"') +
    '"620 Petaluma Blvd N, Petaluma, CA 94952"'.length,
).replace(/\n/g, " ");

/** A long value that genuinely lives in ONE cell. It must survive: stripping
 *  this would make the guard worse than the defect, because a real price note
 *  is exactly the kind of thing a client needs. */
const HONEST_LONG =
  "Family-run remodeler serving Marin and Sonoma";

const modelResult = () => ({
  sections: [{ title: "Kitchen Remodel Contractors", items: [
    { title: "Oak & Tile Interiors", details: [
      { label: "Fixed design fee", value: "$12,000 for concept through construction selections" },
      { label: "Hourly consulting option", value: RUN_ON },
      { label: "Timeline", value: "Design work can begin within 2 weeks" },
    ] },
    { title: "Willow Creek Remodels", details: [
      { label: "Description", value: HONEST_LONG },
      { label: "Standard package", value: "starts around $42,000" },
    ] },
  ] }],
});

function enforce(result: unknown) {
  return enforceChunkResult({
    segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
    result, runId: "t", destination: "packet", delimiterHint: ",",
    grouping: { intent: "auto", title: null } as never,
  });
}
const detailsOf = (out: ReturnType<typeof enforce>, title: string) => {
  const r = out.result as { sections?: Array<{ items?: Array<Record<string, unknown>> }> };
  const it = (r.sections ?? []).flatMap((s) => s.items ?? []).find((i) => i.title === title);
  return ((it?.details ?? []) as Array<{ label: string; value: string }>);
};

test("A VALUE THAT RUNS PAST ITS CELL DOES NOT REACH THE CLIENT", () => {
  const out = enforce(modelResult());
  const values = detailsOf(out, "Oak & Tile Interiors").map((d) => d.value);
  assert.ok(!values.some((v) => v.includes("Willow Creek Remodels")),
    "one contractor's row is still filed as another contractor's detail");
  assert.ok(!values.some((v) => v === RUN_ON), "the run-on survived enforcement");
  assert.ok(out.telemetry.crossCellRejected >= 1,
    "the removal was not counted, so nothing can notice it happening");
});

test("...AND THE PROFESSIONAL IS ASKED ABOUT IT, rather than it vanishing", () => {
  // Silent removal would trade a wrong price for a missing one. The held text
  // becomes a decision, with the source shown.
  const out = enforce(modelResult());
  const unit = (out.reviewUnits as Array<Record<string, unknown>>)
    .find((u) => u.kind === "cross-cell-detail");
  assert.ok(unit, "no review unit was raised for the removed value");
  assert.equal(unit!.title, "Oak & Tile Interiors", "the unit does not name the item it came from");
  assert.match(String(unit!.text), /225\/hour/, "the held excerpt is not the text that was removed");
});

test("THE DETAILS THAT WERE RIGHT ARE LEFT ALONE", () => {
  // The model emitted the run-on BESIDE correct details parsed from the same
  // columns. Removing the spill must not disturb them.
  const out = enforce(modelResult());
  const kept = detailsOf(out, "Oak & Tile Interiors");
  assert.ok(kept.some((d) => d.label === "Fixed design fee" &&
    d.value === "$12,000 for concept through construction selections"), "a correct detail was removed");
  assert.ok(kept.some((d) => d.label === "Timeline" &&
    d.value === "Design work can begin within 2 weeks"), "a correct detail was removed");
});

test("A LONG VALUE THAT SITS IN ONE CELL SURVIVES — the guard is not a length limit", () => {
  const out = enforce(modelResult());
  const kept = detailsOf(out, "Willow Creek Remodels").map((d) => d.value);
  assert.ok(kept.includes(HONEST_LONG),
    "a legitimate single-cell value was stripped as if it had spilled");
});

test("WITHOUT A DELIMITER THERE ARE NO CELLS, and nothing is stripped on suspicion", () => {
  // Pasted prose has no cell boundaries to cross. The guard must not invent
  // them: its whole precondition is a delimited source.
  const out = enforceChunkResult({
    segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
    result: modelResult(), runId: "t", destination: "packet", delimiterHint: null,
    grouping: { intent: "auto", title: null } as never,
  });
  const values = detailsOf(out as never, "Oak & Tile Interiors").map((d) => d.value);
  assert.ok(values.includes(RUN_ON),
    "a value was removed as cross-cell although the source declared no delimiter");
});
