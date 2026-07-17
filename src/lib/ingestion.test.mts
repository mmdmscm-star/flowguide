// Unit tests for the deterministic is_continuation flag (from segmentation.ts)
// that finalize uses to recombine a heading group split across chunks — WITHOUT
// relying on the AI's displayed section titles. buildRunChunks/buildSplitChildren
// in ingestion.ts assign exactly `isContinuation(sourceStart, text)` per chunk,
// so testing that composition here proves the behavior (ingestion.ts itself uses
// extensionless app imports that node --test can't load directly).
// Run: node --test src/lib/ingestion.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, splitRange, isContinuation, firstBlockIsHeading } from "./segmentation.ts";

function community(i: number): string {
  return `Community ${i}\n${100 + i} Main St, Santa Rosa, CA 95400\nA nice place I toured recently. Assisted living, around $4,500/mo.\nWebsite: https://www.c${i}.example.com`;
}
function oneHeading(n: number): string {
  let s = "Recommended Communities\n\n";
  for (let i = 0; i < n; i++) s += community(i) + "\n\n";
  return s.trim();
}
function twoHeadings(n: number): string {
  let s = "Recommended Communities\n\n";
  for (let i = 0; i < n; i++) s += community(i) + "\n\n";
  s += "Also Worth Considering\n\n";
  for (let i = 0; i < n; i++) s += community(1000 + i) + "\n\n";
  return s.trim();
}
// mirrors ingestion.buildRunChunks' flag assignment
const flags = (src: string) => segment(src).map((s) => isContinuation(s.sourceStart, s.text));

test("long single-heading list spanning chunks: only chunk 0 starts the group; rest are continuations", () => {
  const src = oneHeading(30);
  const segs = segment(src);
  assert.ok(segs.length >= 3, `several chunks (got ${segs.length})`);
  const f = flags(src);
  assert.equal(f[0], false, "first chunk starts the group");
  for (let i = 1; i < f.length; i++) assert.equal(f[i], true, `chunk ${i} is a continuation (spillover)`);
  // => finalize merges chunks 1..n into chunk 0's section by the flag, never by title.
});

test("continuation rules: start-of-source and heading-led chunks are NOT continuations", () => {
  // start of source is never a continuation
  assert.equal(isContinuation(0, "Community 5\n123 Main St\n..."), false);
  // a chunk that BEGINS with a heading starts a new section, so not a continuation
  assert.equal(firstBlockIsHeading("Also Worth Considering\n\nCommunity 5\n123 Main St"), true);
  assert.equal(isContinuation(500, "Also Worth Considering\n\nCommunity 5\n123 Main St"), false);
  // a chunk that begins mid-list (a content block, offset > 0) IS a continuation
  assert.equal(firstBlockIsHeading("Community 5\n123 Main St\nAssisted living"), false);
  assert.equal(isContinuation(500, "Community 5\n123 Main St\nAssisted living"), true);
});

test("twoHeadings: source still tiles and a new heading appears as its own section boundary", () => {
  // The second heading may sit mid-chunk; finalize handles that (only the FIRST
  // section of a continuation chunk merges, a new-heading section stays separate).
  const src = twoHeadings(15);
  const segs = segment(src);
  let joined = "";
  for (const s of segs) joined += s.text;
  assert.equal(joined, src, "source reassembles exactly");
  assert.ok(src.includes("Also Worth Considering"), "second heading preserved in source");
});

test("determinism: same source yields the same continuation flags", () => {
  assert.deepEqual(flags(oneHeading(20)), flags(oneHeading(20)));
});

test("split children carry continuation flags: a mid-list split yields continuations", () => {
  const src = oneHeading(20);
  const segs = segment(src);
  const c = segs.find((x) => isContinuation(x.sourceStart, x.text))!;
  const kids = splitRange(src, c.sourceStart, c.sourceEnd);
  assert.ok(kids.length >= 2);
  for (const k of kids) {
    const text = src.slice(k.start, k.end);
    assert.equal(isContinuation(k.start, text), true, "mid-list split children are continuations (no heading)");
  }
  assert.equal(kids[0].start, c.sourceStart);
  assert.equal(kids[kids.length - 1].end, c.sourceEnd);
});
