// The 0016 acceptance fixture, proven WITHOUT a database.
// Run: node --test src/lib/ownership-gate-fixture.test.mts
//
// verify-ownership-gate.mts asserts that a misplaced photo is found, offered a
// Move, and cleared by resolving it. Every one of those assertions passes
// trivially if the fixture stops being misplaced — a script that finds nothing
// reports success just as loudly as one that finds and fixes everything.
//
// So the fixture is pinned here, against the same pure recompute the route
// uses. If someone edits the source string and the misplacement evaporates,
// this fails in the unit suite rather than the acceptance run silently becoming
// a no-op that nobody re-reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSourceRecords, segmentHash, SEGMENTER_VERSION } from "./segmentation.ts";
import { recomputeOwnership, resolveFindings, availableActions, blocksPublishing,
         type ItemProvenance } from "./ownership-recompute.ts";
import { GATE_SOURCE, GATE_TITLES, PHOTO_A, PHOTO_B } from "./__fixtures__/ownership-gate-fixture.ts";

const detected = detectSourceRecords(GATE_SOURCE);

const run = {
  id: "run-1",
  sourceHash: segmentHash(GATE_SOURCE),
  sourceLen: GATE_SOURCE.length,
  segmenterVersion: SEGMENTER_VERSION,
  sourceOffsetBase: 0,
};

const chunks = () => detected!.records.map((r, ordinal) => ({ ordinal, start: r.start, end: r.end }));

/** The two items the script inserts, with photo placement as the parameter. */
function items(misplace: boolean): ItemProvenance[] {
  return GATE_TITLES.map((title, i) => ({
    id: `item-${i}`,
    title,
    originChunkOrdinal: i,
    originEmitIndex: 0,
    photoUrls:
      i === 0 ? (misplace ? [] : [PHOTO_A])
              : (misplace ? [PHOTO_A, PHOTO_B] : [PHOTO_B]),
  }));
}

test("the fixture is tabular, or the whole acceptance run is vacuous", () => {
  // recomputeOwnership DECLINES on prose. A fixture that stopped being detected
  // as records would make the script find nothing and call it clean.
  assert.ok(detected, "the detector must find record structure");
  assert.equal(detected!.records.length, 2);
});

test("misplaced: exactly one blocking finding, proposing the item the source names", () => {
  const r = recomputeOwnership({ rawInput: GATE_SOURCE, run, chunks: chunks(), items: items(true) });
  assert.equal(r.status, "ok", `recompute declined: ${JSON.stringify(r)}`);

  const found = resolveFindings(r);
  const blocking = found.filter(blocksPublishing);
  assert.equal(blocking.length, 1, `expected one blocking finding, got ${JSON.stringify(found)}`);

  const f = blocking[0];
  assert.equal(f.code, "media_on_wrong_record");
  assert.equal(f.url, PHOTO_A, "the misplaced photo is Alpha's");
  assert.equal(f.itemId, "item-1", "found on Bravo, where it does not belong");
  assert.equal(f.proposedItemId, "item-0", "and proposed back to Alpha");

  // The script presses both buttons; both must actually be on offer.
  assert.deepEqual(availableActions(f), ["move", "keep"]);
});

test("the control packet is genuinely clean, not merely unchecked", () => {
  // If this DECLINED instead of passing, the script's "clean packet publishes"
  // assertion would still pass — for the wrong reason, and it would stop
  // proving that a clean packet never consults the decisions table.
  const r = recomputeOwnership({ rawInput: GATE_SOURCE, run, chunks: chunks(), items: items(false) });
  assert.equal(r.status, "ok", "the control must be CHECKED, not declined");
  assert.deepEqual(resolveFindings(r), [], "and have nothing to report");
});

test("resolving by Move makes the finding stop being true", () => {
  // Move is not a state change on the finding; it is a change to the world the
  // finding described. Recompute after the move must be silent on its own.
  const moved = items(true);
  moved[1].photoUrls = moved[1].photoUrls.filter((u) => u !== PHOTO_A);
  moved[0].photoUrls = [...moved[0].photoUrls, PHOTO_A];

  const r = recomputeOwnership({ rawInput: GATE_SOURCE, run, chunks: chunks(), items: moved });
  assert.equal(r.status, "ok");
  assert.deepEqual(resolveFindings(r), [], "no bookkeeping needed — it simply is not true any more");
});
