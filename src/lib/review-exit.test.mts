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

// The zero-item case, made intentional.
//
// finalize clears packets.origin_ingestion_run_id on the assumption the run
// succeeded, which would leave a held run's empty packet un-deletable and strand
// the professional in an empty draft. The finalize route restores the marker for
// exactly this shape, so discard removes the empty packet as 0012 intends — and
// the sentence promises that only when the restore actually happened.
test("a held, empty, self-created organize draft is the one case that gets removed", () => {
  const held = { entryPoint: "organize", isOriginRun: true, isDraft: true, isEmpty: true };
  assert.equal(discardWouldDeletePacket(held), true);
  assert.match(describeReviewExit(held), /empty packet will be removed/);

  // The marker is NOT restored when the packet has content, so the professional
  // keeps everything and the sentence says so.
  const withContent = { ...held, isEmpty: false };
  assert.equal(discardWouldDeletePacket(withContent), false);
  assert.match(describeReviewExit(withContent), /Everything you can see stays/);

  // An append run never created the packet, so it can never remove it.
  assert.equal(discardWouldDeletePacket({ ...held, entryPoint: "append" }), false);

  // If this run did not create the packet, nothing is restored and nothing goes.
  assert.equal(discardWouldDeletePacket({ ...held, isOriginRun: false }), false);
});
