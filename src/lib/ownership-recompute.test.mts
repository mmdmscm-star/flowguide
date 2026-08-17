// Recomputation against the CURRENT packet. Run: node --test src/lib/ownership-recompute.test.mts
//
// Two properties matter here and they pull against each other:
//   1. a genuine ownership error must still be caught after manual edits;
//   2. the checker must REFUSE to answer when it cannot prove the source it is
//      reasoning about is the one the offsets were measured against.
// A wrong accusation against a packet the professional already fixed is worse
// than no check at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, segmentHash, detectSourceRecords, SEGMENTER_VERSION, DEFAULT_BUDGET } from "./segmentation.ts";
import { mediaOccurrences } from "./media-ownership.ts";
import { recomputeOwnership, resolveFindings, type ItemProvenance, type RunProvenance } from "./ownership-recompute.ts";
import { CLIENT_SOURCE } from "./__fixtures__/incident-sources.ts";

const CHUNKS = [[0, 2856], [2856, 5125], [5125, 7751], [7751, 9767], [9767, 9885]] as Array<[number, number]>;
const plan = CHUNKS.map(([start, end], ordinal) => ({ ordinal, start, end }));

const run = (over: Partial<RunProvenance> = {}): RunProvenance => ({
  id: "run-1",
  sourceHash: segmentHash(CLIENT_SOURCE),
  sourceLen: CLIENT_SOURCE.length,
  segmenterVersion: SEGMENTER_VERSION,
  sourceOffsetBase: 0,
  ...over,
});

/** The incident as it would sit in the DB: one item per chunk, holding that
 *  chunk's photos, with 0014 provenance recorded. */
function incidentItems(): ItemProvenance[] {
  const titles = ["The Reserve at Fountaingrove", "Brookdale Chanate", "Brookdale Paulin Creek", "Primrose", "Primrose Photo 4"];
  const media = mediaOccurrences(CLIENT_SOURCE);
  return plan.map((c, i) => ({
    id: `item-${i}`,
    title: titles[i],
    originChunkOrdinal: c.ordinal,
    originEmitIndex: 0,
    photoUrls: media.filter((m) => m.at >= c.start && m.at < c.end).map((m) => m.url),
  }));
}

test("the incident is still caught after the fact, and names real item ids", () => {
  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items: incidentItems() });
  assert.equal(r.status, "ok");
  const found = resolveFindings(r);
  const wrong = found.filter((f) => f.code === "media_on_wrong_record");
  assert.equal(wrong.length, 7);
  assert.ok(wrong.every((f) => f.itemId && f.proposedItemId), "every one names a real source and destination row");
  assert.deepEqual([...new Set(wrong.map((f) => `${f.itemId}->${f.proposedItemId}`))],
    ["item-1->item-0", "item-2->item-1", "item-3->item-2"]);
  assert.equal(found.filter((f) => f.code === "continuation_fabrication")[0]?.proposedItemId, "item-3");
});

test("MOVING the photo makes the finding disappear — no resolution bookkeeping", () => {
  // The professional drags the two stranded photos back onto The Reserve. The
  // finding is not "resolved", it simply stops being true.
  const items = incidentItems();
  const strandedOnChanate = items[1].photoUrls.filter((u) => {
    const at = mediaOccurrences(CLIENT_SOURCE).find((m) => m.url === u)!.at;
    return at < 3109; // still inside record 0
  });
  assert.equal(strandedOnChanate.length, 2, "two of Reserve's photos landed on Chanate");
  items[1].photoUrls = items[1].photoUrls.filter((u) => !strandedOnChanate.includes(u));
  items[0].photoUrls = [...items[0].photoUrls, ...strandedOnChanate];

  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items });
  const wrong = resolveFindings(r).filter((f) => f.code === "media_on_wrong_record");
  assert.equal(wrong.filter((f) => f.itemId === "item-1").length, 0, "Chanate is clean now");
  assert.equal(wrong.length, 5, "the other five are untouched and still reported");
});

test("a RENAMED item is still bound — titles are never load-bearing", () => {
  const items = incidentItems();
  items[1].title = "Brookdale Chanate — Memory Care (renamed by hand)";
  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items });
  assert.equal(r.status, "ok");
  assert.equal(resolveFindings(r).filter((f) => f.code === "media_on_wrong_record").length, 7);
});

test("REORDERED items still bind by emission index, not sort order", () => {
  // /api/reorder rewrites sort_order freely. Shuffling the row order must not
  // change a single conclusion — this is what origin_emit_index buys.
  const shuffled = [...incidentItems()].reverse();
  const a = resolveFindings(recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items: incidentItems() }));
  const b = resolveFindings(recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items: shuffled }));
  assert.deepEqual(b, a, "row order is irrelevant");
});

test("the corrected packet recomputes clean", () => {
  const segs = segment(CLIENT_SOURCE, DEFAULT_BUDGET);
  const chunks = segs.map((s) => ({ ordinal: s.ordinal, start: s.sourceStart, end: s.sourceEnd }));
  const media = mediaOccurrences(CLIENT_SOURCE);
  const items: ItemProvenance[] = chunks.map((c, i) => ({
    id: `ok-${i}`, title: `Community ${i}`,
    originChunkOrdinal: c.ordinal, originEmitIndex: 0,
    photoUrls: media.filter((m) => m.at >= c.start && m.at < c.end).map((m) => m.url),
  }));
  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks, items });
  assert.equal(r.status, "ok");
  assert.deepEqual(resolveFindings(r), [], "no false accusations on a correct packet");
});

// ------------------------------------------------------------------
// Refusing to answer. Each of these MUST decline rather than guess.
// ------------------------------------------------------------------
test("a replaced source is detected and DECLINED, never guessed at", () => {
  // /api/packets/[id]/structure replaces raw_input wholesale. The 0014 trigger
  // nulls the base, but even if a base survived, the hash must catch it.
  const replaced = "Something else entirely, pasted over the original source text.";
  const r = recomputeOwnership({ rawInput: replaced, run: run(), chunks: plan, items: incidentItems() });
  assert.equal(r.status, "declined");
  assert.equal(r.status === "declined" && r.reason, "source_moved");
});

test("a single edited character is enough to decline", () => {
  const tampered = CLIENT_SOURCE.slice(0, 500) + "X" + CLIENT_SOURCE.slice(501);
  assert.equal(tampered.length, CLIENT_SOURCE.length, "same length, so only the hash can catch it");
  const r = recomputeOwnership({ rawInput: tampered, run: run(), chunks: plan, items: incidentItems() });
  assert.equal(r.status === "declined" && r.reason, "source_moved");
});

test("every missing precondition declines with its own reason", () => {
  const cases: Array<[string, ReturnType<typeof recomputeOwnership>, string]> = [
    ["no items carry provenance",
      recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items: [] }), "no_provenance"],
    ["pre-0014 run, or base voided by the trigger",
      recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run({ sourceOffsetBase: null }), chunks: plan, items: incidentItems() }), "no_offset_base"],
    ["planned by a different segmenter",
      recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run({ segmenterVersion: "seg-v3" }), chunks: plan, items: incidentItems() }), "segmenter_changed"],
    ["an item records a run but no chunk",
      recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan,
        items: incidentItems().map((i, n) => n === 2 ? { ...i, originChunkOrdinal: null } : i) }), "incomplete_provenance"],
  ];
  for (const [why, r, reason] of cases) {
    assert.equal(r.status, "declined", why);
    assert.equal(r.status === "declined" && r.reason, reason, why);
    assert.deepEqual(resolveFindings(r), [], `${why}: declining yields NO findings`);
  }
});

test("prose declines rather than pretending records exist", () => {
  const prose = "I toured three places this week and liked the second one best. "
    + "The photos are at https://res.cloudinary.com/x/image/upload/v1/A_a.jpg and it was lovely.";
  assert.equal(detectSourceRecords(prose), null, "no record structure");
  const r = recomputeOwnership({
    rawInput: prose,
    run: run({ sourceHash: segmentHash(prose), sourceLen: prose.length }),
    chunks: [{ ordinal: 0, start: 0, end: prose.length }],
    items: [{ id: "p1", title: "A place", originChunkOrdinal: 0, originEmitIndex: 0, photoUrls: [] }],
  });
  assert.equal(r.status === "declined" && r.reason, "source_not_tabular");
});

test("an APPEND run is located by its base, not assumed to start at 0", () => {
  const prior = "Earlier notes about something unrelated.";
  const delim = "\n\n--- Added ---\n\n";
  const rawInput = prior + delim + CLIENT_SOURCE;
  const base = (prior + delim).length;

  const ok = recomputeOwnership({ rawInput, run: run({ sourceOffsetBase: base }), chunks: plan, items: incidentItems() });
  assert.equal(ok.status, "ok", "the run's source is found at its base");
  assert.equal(resolveFindings(ok).filter((f) => f.code === "media_on_wrong_record").length, 7);

  // Assuming 0 would slice the wrong window and must not silently "work".
  const wrong = recomputeOwnership({ rawInput, run: run({ sourceOffsetBase: 0 }), chunks: plan, items: incidentItems() });
  assert.equal(wrong.status === "declined" && wrong.reason, "source_moved");
});
