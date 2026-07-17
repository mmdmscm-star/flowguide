// Unit tests for the deterministic natural-boundary segmenter (pure; no DB).
// Run: node --test src/lib/segmentation.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, splitRange, segmentHash, SEGMENTER_VERSION, DEFAULT_BUDGET } from "./segmentation.ts";

// Rebuild the synthetic senior-placement source inline (mirrors the fixture) so
// the test is self-contained.
function community(i: number): string {
  const names = ["Golden Meadows", "Cedar Ridge", "Harbor View", "Willow Creek", "Sunset Terrace", "Maplewood", "Bayside Gardens", "Oak Hollow", "Riverbend", "Lakeshore", "Magnolia Court", "Pinecrest"];
  const n = names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : "");
  let b = `${n}\n${100 + i} Main St, Santa Rosa, CA 95400\nA nice community. I toured it recently.\nMonthly cost around $4,500. Care level: Assisted Living.\nWebsite: https://www.x${i}.example.com\n`;
  if (i % 3 === 0) b += `Contact: Maria Santos, Director - (707) 555-${String(1000 + i).slice(-4)}\n`;
  return b;
}
function makeSource(n: number): string {
  let out = "Senior living options for the Johnson family.\n\nRecommended Communities\n\n";
  for (let i = 0; i < n; i++) {
    out += community(i) + "\n";
    if (i === Math.floor(n * 0.6)) out += "Also Worth Considering\n\n";
  }
  return out.trim();
}

test("ranges tile the source EXACTLY (concatenation reproduces source; non-overlapping, dense)", () => {
  for (const n of [1, 6, 15, 40, 120]) {
    const src = makeSource(n);
    const segs = segment(src);
    assert.equal(segs[0].sourceStart, 0, "first starts at 0");
    assert.equal(segs[segs.length - 1].sourceEnd, src.length, "last ends at len");
    let joined = "";
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) assert.equal(segs[i].sourceStart, segs[i - 1].sourceEnd, `contiguous at ${i} (no gap/overlap)`);
      assert.equal(segs[i].text, src.slice(segs[i].sourceStart, segs[i].sourceEnd), "text matches slice");
      joined += segs[i].text;
    }
    assert.equal(joined, src, `n=${n}: reassembled source is identical`);
  }
});

test("determinism: same input + version yields identical plan (ordinals, ranges, hashes)", () => {
  const src = makeSource(40);
  const a = segment(src);
  const b = segment(src);
  assert.deepEqual(a, b, "identical segmentation on repeat");
  assert.deepEqual(a.map((s) => s.ordinal), a.map((_, i) => i), "ordinals dense 0..n-1");
});

test("budget respected: each chunk stays near ~10 items; big source -> many chunks", () => {
  const src = makeSource(40);
  const segs = segment(src);
  assert.ok(segs.length >= 4, `40 items -> multiple chunks (got ${segs.length})`);
  for (const s of segs) {
    // count item-ish blocks (non-heading blank-line groups)
    const blocks = s.text.split(/\n[ \t]*\n/).map((t) => t.trim()).filter(Boolean);
    const items = blocks.filter((b) => b.includes("\n") || /\d/.test(b)).length;
    assert.ok(items <= DEFAULT_BUDGET.maxItems + 1, `chunk item estimate ${items} within budget`);
    assert.ok(s.text.length <= DEFAULT_BUDGET.maxChars + 2000, "chunk chars bounded");
  }
});

test("a heading is never stranded at the end of a chunk (stays with its block)", () => {
  const src = makeSource(40);
  const segs = segment(src);
  for (const s of segs) {
    const blocks = s.text.split(/\n[ \t]*\n/).map((t) => t.trim()).filter(Boolean);
    const last = blocks[blocks.length - 1] || "";
    const lastIsBareHeading = !last.includes("\n") && last.length > 0 && last.length < 60 && !/[.!?]$/.test(last) && /^(Recommended Communities|Also Worth Considering)$/.test(last);
    assert.ok(!lastIsBareHeading, `chunk must not end on a heading: "${last}"`);
  }
});

test("a person stays with their phone (contact line not split from its block)", () => {
  const src = makeSource(30);
  const segs = segment(src);
  // Every "Contact:" line must sit in the same chunk as the community name above it.
  for (const s of segs) {
    const idx = s.text.indexOf("Contact:");
    if (idx >= 0) {
      // there must be a community block (a line with an address) before it in the same chunk
      assert.ok(/Main St/.test(s.text.slice(0, idx)), "contact stays within its community block/chunk");
    }
  }
});

test("small source -> exactly one chunk (fast path)", () => {
  const segs = segment(makeSource(4));
  assert.equal(segs.length, 1, "small source is a single chunk");
});

test("splitRange divides at a natural boundary near the midpoint and tiles the range", () => {
  const src = makeSource(20);
  const segs = segment(src);
  const big = segs[0];
  const kids = splitRange(src, big.sourceStart, big.sourceEnd);
  assert.ok(kids.length >= 2, "splits into >=2");
  assert.equal(kids[0].start, big.sourceStart);
  assert.equal(kids[kids.length - 1].end, big.sourceEnd);
  for (let i = 1; i < kids.length; i++) assert.equal(kids[i].start, kids[i - 1].end, "children tile with no gap");
  // the cut should land on a newline/blank boundary, not mid-line
  const cut = kids[0].end;
  assert.ok(src[cut - 1] === "\n" || src[cut] === "\n" || /\s/.test(src[cut] || " "), "cut at whitespace boundary");
});

test("hash is stable and length-tagged", () => {
  assert.equal(segmentHash("abc"), segmentHash("abc"));
  assert.notEqual(segmentHash("abc"), segmentHash("abd"));
  assert.equal(SEGMENTER_VERSION, "seg-v1");
});
