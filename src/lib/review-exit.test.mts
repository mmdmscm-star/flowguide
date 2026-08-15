// Run: node --test src/lib/review-exit.test.mts
//
// Pins the sentence to discard_ingestion_run's ACTUAL predicate (0012):
//   entry_point='organize' AND origin_ingestion_run_id=run AND status='draft'
//   AND sections=0 AND items=0 AND blocks=0  ->  the packet is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeReviewExit, discardWouldDeletePacket } from "./review-exit.ts";

const EMPTY_ORIGIN_DRAFT = { entryPoint: "organize", isOriginRun: true, isDraft: true, isEmpty: true };

test("an empty origin-organize draft is deleted, and the sentence says so", () => {
  assert.equal(discardWouldDeletePacket(EMPTY_ORIGIN_DRAFT), true);
  const s = describeReviewExit(EMPTY_ORIGIN_DRAFT);
  assert.match(s, /empty packet will be removed/);
  assert.doesNotMatch(s, /stays/, "must not promise survival when the packet is deleted");
});

test("every single condition failing flips it to PRESERVED", () => {
  // Each of the four is load-bearing in the SQL; none may be dropped here.
  for (const [field, value] of [["entryPoint", "append"], ["isOriginRun", false], ["isDraft", false], ["isEmpty", false]] as const) {
    const d = { ...EMPTY_ORIGIN_DRAFT, [field]: value };
    assert.equal(discardWouldDeletePacket(d), false, `${field}=${value} must preserve the packet`);
    assert.match(describeReviewExit(d), /Everything you can see stays/, `${field}=${value}`);
  }
});

test("the media-accounting case — a packet with content — always keeps it", () => {
  // The real incident shape: items landed, some photos did not.
  const withContent = { entryPoint: "organize", isOriginRun: true, isDraft: true, isEmpty: false };
  assert.match(describeReviewExit(withContent), /Everything you can see stays/);
});

test("every phrasing names the affordance that exists", () => {
  for (const isEmpty of [true, false]) {
    assert.match(describeReviewExit({ ...EMPTY_ORIGIN_DRAFT, isEmpty }), /Discard/);
  }
});
