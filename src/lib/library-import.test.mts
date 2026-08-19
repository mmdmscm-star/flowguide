// Contracts the Library import lifecycle depends on, tested as pure logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePhase, pendingOrdinals, orderProposals, unsavedAtFinish,
  type ImportChunk,
} from "./library-import.ts";

const ch = (ordinal: number, sourceStart: number, status: string): ImportChunk =>
  ({ ordinal, sourceStart, status });

// ---------------------------------------------------------------------------
// Contract 4: closing and reopening mid-extraction resumes correctly
// ---------------------------------------------------------------------------
test("a run with outstanding chunks reopens as EXTRACTING", () => {
  assert.equal(derivePhase("active", [ch(0, 0, "completed"), ch(1, 500, "pending")]), "extracting");
  assert.equal(derivePhase("active", [ch(0, 0, "processing")]), "extracting");
});

test("a split parent is not outstanding work", () => {
  // Its children carry the work. Counting it would leave the run permanently
  // 'extracting' and the professional permanently unable to reach review.
  assert.equal(derivePhase("active", [ch(0, 0, "split"), ch(1, 0, "completed"), ch(2, 250, "completed")]), "review");
});

test("a fully processed run reopens as REVIEW", () => {
  assert.equal(derivePhase("active", [ch(0, 0, "completed"), ch(1, 500, "completed")]), "review");
});

test("a closed run is closed regardless of its chunks", () => {
  for (const s of ["finalized", "discarded", "error"]) {
    assert.equal(derivePhase(s, [ch(0, 0, "completed")]), "closed");
  }
});

test("a failed chunk keeps the run in extraction, not review", () => {
  // Reaching review with a failed chunk would silently present a partial import
  // as the whole thing.
  assert.equal(derivePhase("active", [ch(0, 0, "completed"), ch(1, 400, "failed")]), "extracting");
  assert.deepEqual(pendingOrdinals([ch(0, 0, "completed"), ch(1, 400, "failed")]), [1]);
});

// ---------------------------------------------------------------------------
// Contract 3: display order follows SOURCE order, even after a split
// ---------------------------------------------------------------------------
test("proposals are ordered by source position, not by ordinal", () => {
  // Chunk 1 was split; its children became ordinals 2 and 3 but their text sits
  // between chunk 0 and the end. Ordering by ordinal would drag them last.
  const chunks = [
    ch(0, 0, "completed"),
    ch(1, 100, "split"),
    ch(2, 100, "completed"),
    ch(3, 160, "completed"),
    ch(4, 220, "completed"),
  ];
  const proposals = [
    { ordinal: 4, idx: 0, tag: "e" },
    { ordinal: 2, idx: 1, tag: "c" },
    { ordinal: 0, idx: 0, tag: "a" },
    { ordinal: 3, idx: 0, tag: "d" },
    { ordinal: 2, idx: 0, tag: "b" },
  ];
  assert.deepEqual(orderProposals(proposals, chunks).map((p) => p.tag),
    ["a", "b", "c", "d", "e"]);
});

test("ordering by ordinal alone would have been wrong — proving the test bites", () => {
  const chunks = [ch(0, 0, "completed"), ch(1, 50, "split"), ch(2, 50, "completed")];
  const proposals = [{ ordinal: 2, idx: 0, tag: "middle" }, { ordinal: 0, idx: 0, tag: "first" }];
  const bySource = orderProposals(proposals, chunks).map((p) => p.tag);
  const byOrdinal = [...proposals].sort((a, b) => a.ordinal - b.ordinal).map((p) => p.tag);
  assert.deepEqual(bySource, ["first", "middle"]);
  assert.deepEqual(byOrdinal, ["first", "middle"]);   // same here...
  // ...but not when a split child precedes an earlier-ordinal chunk in the source
  const chunks2 = [ch(0, 300, "completed"), ch(1, 0, "completed")];
  const p2 = [{ ordinal: 0, idx: 0, tag: "late" }, { ordinal: 1, idx: 0, tag: "early" }];
  assert.deepEqual(orderProposals(p2, chunks2).map((p) => p.tag), ["early", "late"]);
  assert.notDeepEqual([...p2].sort((a, b) => a.ordinal - b.ordinal).map((p) => p.tag), ["early", "late"]);
});

test("a proposal whose chunk is unknown sorts last instead of throwing", () => {
  const out = orderProposals(
    [{ ordinal: 9, idx: 0, tag: "orphan" }, { ordinal: 0, idx: 0, tag: "known" }],
    [ch(0, 0, "completed")]);
  assert.deepEqual(out.map((p) => p.tag), ["known", "orphan"]);
});

test("ordering is stable and does not mutate its input", () => {
  const chunks = [ch(0, 0, "completed")];
  const input = [{ ordinal: 0, idx: 1 }, { ordinal: 0, idx: 0 }];
  const copy = [...input];
  orderProposals(input, chunks);
  assert.deepEqual(input, copy, "the caller's array must not be reordered in place");
});

// ---------------------------------------------------------------------------
// Contract 6: finish is not abandon
// ---------------------------------------------------------------------------
test("finishing with anything left needs an explicit acknowledgement", () => {
  assert.equal(unsavedAtFinish([{ selected: false }]).needsAcknowledgement, true);
  assert.equal(unsavedAtFinish([{ selected: true }]).needsAcknowledgement, true,
    "a SELECTED but unsaved proposal is the most dangerous case of all");
});

test("finishing an empty review needs no acknowledgement", () => {
  assert.equal(unsavedAtFinish([]).needsAcknowledgement, false);
});

test("the count distinguishes selected from merely present", () => {
  const u = unsavedAtFinish([{ selected: true }, { selected: false }, { selected: true }]);
  assert.equal(u.total, 3);
  assert.equal(u.selected, 2);
});
