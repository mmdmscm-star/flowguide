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
import { recomputeOwnership, resolveFindings, availableActions, blocksPublishing,
         type ItemProvenance, type RunProvenance } from "./ownership-recompute.ts";
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

// ------------------------------------------------------------------
// Deleting an item must not shift bindings into confident wrong proposals
// ------------------------------------------------------------------
test("deleting an item makes its chunk unverifiable, never mis-bound", () => {
  // A chunk that begins two records and emitted two items. Delete the FIRST.
  // Positional binding on survivors alone would match the remaining item to
  // record 0 — the deleted one's record — and confidently propose moving its
  // photos there. Emission indices make the gap visible instead.
  const P0 = "https://cdn.example.com/r0.jpg";
  const P1 = "https://cdn.example.com/r1.jpg";
  const source = `Alpha\tone\t${P0}\nBravo\ttwo\t${P1}\nCharlie\tthree\tx`;
  const records = detectSourceRecords(source)!.records;
  assert.equal(records.length, 3);

  // One chunk spanning records 0 and 1, which emitted two items.
  const chunks = [{ ordinal: 0, start: records[0].start, end: records[1].end },
                  { ordinal: 1, start: records[2].start, end: records[2].end }];
  const run2 = { id: "r", sourceHash: segmentHash(source), sourceLen: source.length,
                 segmenterVersion: SEGMENTER_VERSION, sourceOffsetBase: 0 };

  const intact: ItemProvenance[] = [
    { id: "a", title: "Alpha", originChunkOrdinal: 0, originEmitIndex: 0, photoUrls: [P0] },
    { id: "b", title: "Bravo", originChunkOrdinal: 0, originEmitIndex: 1, photoUrls: [P1] },
    { id: "c", title: "Charlie", originChunkOrdinal: 1, originEmitIndex: 0, photoUrls: [] },
  ];
  const clean = recomputeOwnership({ rawInput: source, run: run2, chunks, items: intact });
  assert.equal(clean.status, "ok");
  assert.deepEqual(resolveFindings(clean), [], "intact emission: correctly placed, nothing reported");

  // Now the professional deletes Alpha. Bravo survives with emitIndex 1 — a gap.
  const afterDelete = intact.filter((i) => i.id !== "a");
  const r = recomputeOwnership({ rawInput: source, run: run2, chunks, items: afterDelete });
  assert.equal(r.status, "ok");
  const found = resolveFindings(r);
  assert.deepEqual(found.filter((f) => f.code === "media_on_wrong_record"), [],
    "must NOT accuse Bravo of holding Alpha's photo");
  const unver = found.filter((f) => f.code === "ownership_unverifiable" && f.itemId === "b");
  assert.equal(unver.length, 1, "the gap is surfaced, not silently guessed through");
  assert.match(unver[0].detail, /missing items from its original output/);
});

// ------------------------------------------------------------------
// Resolution semantics: what may be offered, and what blocks
// ------------------------------------------------------------------
test("a URL in several source records offers NEITHER Move nor Keep, and does not block", () => {
  // The founder's requirement, pinned end to end: duplicate occurrences that
  // make ownership ambiguous must stay ambiguous. A Move would be a guess; a
  // url-level Keep would convert "we don't know" into "the user decided".
  const P = "https://cdn.example.com/shared.jpg";
  const source = `Alpha\tone\t${P}\nBravo\ttwo\t${P}\nCharlie\tthree\tx`;
  const records = detectSourceRecords(source)!.records;
  const chunks = records.map((r, ordinal) => ({ ordinal, start: r.start, end: r.end }));
  const r = recomputeOwnership({
    rawInput: source,
    run: { id: "r", sourceHash: segmentHash(source), sourceLen: source.length,
           segmenterVersion: SEGMENTER_VERSION, sourceOffsetBase: 0 },
    chunks,
    items: [
      { id: "a", title: "Alpha", originChunkOrdinal: 0, originEmitIndex: 0, photoUrls: [] },
      { id: "b", title: "Bravo", originChunkOrdinal: 1, originEmitIndex: 0, photoUrls: [] },
      { id: "c", title: "Charlie", originChunkOrdinal: 2, originEmitIndex: 0, photoUrls: [P] },
    ],
  });
  const found = resolveFindings(r);
  const amb = found.filter((f) => f.url === P);
  assert.equal(amb.length, 1);
  assert.equal(amb[0].code, "ownership_unverifiable");
  assert.deepEqual(availableActions(amb[0]), [], "no Move AND no Keep");
  assert.equal(blocksPublishing(amb[0]), false, "advisory, not a dead end");
  assert.equal(amb[0].proposedItemId, undefined, "no destination is even named");
});

test("a uniquely-owned misplaced photo offers Move + Keep and blocks", () => {
  const records = detectSourceRecords(CLIENT_SOURCE)!.records;
  const items = incidentItems();
  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items });
  const wrong = resolveFindings(r).filter((f) => f.code === "media_on_wrong_record");
  assert.ok(wrong.length > 0);
  for (const f of wrong) {
    assert.deepEqual(availableActions(f), ["move", "keep"], "unique owner => both actions");
    assert.equal(blocksPublishing(f), true);
  }
  assert.equal(records.length, 4);
});

test("fabrication is advisory: no actions, no block", () => {
  const r = recomputeOwnership({ rawInput: CLIENT_SOURCE, run: run(), chunks: plan, items: incidentItems() });
  const fab = resolveFindings(r).filter((f) => f.code === "continuation_fabrication");
  assert.equal(fab.length, 1);
  assert.deepEqual(availableActions(fab[0]), [], "its real fix is deleting the item, an editor action");
  assert.equal(blocksPublishing(fab[0]), false);
});
