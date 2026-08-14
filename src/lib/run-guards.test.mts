// Run: node --test src/lib/run-guards.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRunOutcome, usableTextLength } from "./run-guards.ts";

const REAL = "Brookdale Chanate, Santa Rosa. Assisted living, $5,200/month, tour booked Tuesday.";

test("a new-packet import that produced nothing is a failure, not a quiet success", () => {
  const f = checkRunOutcome({ entryPoint: "organize", source: REAL, itemsCreated: 0 });
  assert.ok(f, "every chunk can report success while the run produced nothing");
  assert.equal(f!.code, "run_produced_nothing");
  assert.match(f!.summary, /without creating anything/, "states the problem");
  assert.doesNotMatch(f!.summary, /Discard/, "the way out belongs to review-exit.ts, so the two never stack");
});

test("an append run may validly add zero NEW items", () => {
  // Attaching photos or contacts to entries that already exist is a correct
  // outcome. Demanding a new item here is the exact pressure that produced
  // `Primrose Photo 4`.
  for (const entryPoint of ["append", "section_append"]) {
    assert.equal(checkRunOutcome({ entryPoint, source: REAL, itemsCreated: 0 }), null, entryPoint);
  }
});

test("a source with nothing structurable is not held to a phantom standard", () => {
  const mediaOnly = "https://res.cloudinary.com/x/image/upload/v1/A_b.jpg\nhttps://res.cloudinary.com/x/image/upload/v1/B_c.jpg";
  assert.equal(checkRunOutcome({ entryPoint: "organize", source: mediaOnly, itemsCreated: 0 }), null);
  assert.equal(checkRunOutcome({ entryPoint: "organize", source: "   \n\n  ", itemsCreated: 0 }), null);
  assert.ok(usableTextLength(mediaOnly) < 40, "URLs are not structurable text");
});

test("a successful run is silent", () => {
  assert.equal(checkRunOutcome({ entryPoint: "organize", source: REAL, itemsCreated: 3 }), null);
});
