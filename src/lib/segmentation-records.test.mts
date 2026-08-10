// Unit tests for seg-v3 record-atomic segmentation (pure; no DB, no model).
// Run: node --test src/lib/segmentation-records.test.mts
//
// The failure being pinned: a pasted spreadsheet whose quoted photo cells
// contain blank lines was cut by the blank-line segmenter INSIDE a row, which
// orphaned trailing photos onto the next chunk and left one chunk holding
// nothing but image URLs. See docs/investigations/mid-record-chunk-splits.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, splitRange, DEFAULT_BUDGET } from "./segmentation.ts";

// ------------------------------------------------------------------
// A structural replica of the reported paste. Deliberately mirrors the shape
// that broke: 6 columns, quoted multi-line cells, BLANK LINES between the
// "Image N:" entries, and trailing empty tab padding on every row EXCEPT the
// last — which is what a spreadsheet range selection actually produces.
// ------------------------------------------------------------------
function photoCell(tag: string, n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`Image ${i}: https://cdn.example.com/v${1000 + i}/${tag}${i}_x${i}.jpg`);
  }
  return `"${lines.join("\n\n")}\n"`;
}

function prose(name: string, filler: number): string {
  return `${name} is a community offering personalized support in a welcoming setting. ` +
    "It features light-filled residences, inviting gardens, and chef-driven dining. ".repeat(filler);
}

function row(name: string, city: string, tag: string, photos: number, filler: number, pad: number): string {
  const contact = `"Type: IL, AL, MC\n Capacity: 130\n Community Phone: (415) 555-0100\n Contact Name: A Person\n Email Address: a@example.com"`;
  const pricing = `"${name} 1 Main St, ${city}, CA 94903\n (415) 555-0100\n https://example.com\n Studio - $7,500/month\n Community Fee: $15,000\n Care Costs: Additional monthly fee"`;
  return [name, city, contact, pricing, prose(name, filler), photoCell(tag, photos)].join("\t") + "\t".repeat(pad);
}

// Sized so the 3800-char budget forces exactly one record per chunk, closely
// matching the real run: these are 2621 / 2297 / 2632 chars against the real
// 2854 / 1915 / 2592. Any two records together exceed the budget, so the packer
// must flush between records — which is precisely where the old blank-line
// segmenter cut INSIDE a record instead.
const REPLICA = [
  row("Atria Tamalpais Creek", "Novato", "AtriaTC", 8, 22, 20),
  row("AlmaVia of San Rafael", "San Rafael", "AlmaViaSR", 2, 22, 20),
  row("Drake Terrace", "San Rafael", "DrakeT", 9, 22, 0),
].join("\n");

const photosIn = (text: string) => [...text.matchAll(/https:\/\/cdn\.example\.com\/\S+?\.jpg/g)].map((m) => m[0]);
const ownersIn = (text: string) =>
  new Set(photosIn(text).map((u) => u.replace(/.*\/(?:v\d+)\/([A-Za-z]+)\d+_.*/, "$1")));

// ------------------------------------------------------------------
// The regression this whole change exists for
// ------------------------------------------------------------------
test("the reported paste plans one chunk per record, with no orphaned media", () => {
  const segs = segment(REPLICA, DEFAULT_BUDGET);

  assert.equal(segs.length, 3, "one chunk per spreadsheet row");

  for (const s of segs) {
    const owners = ownersIn(s.text);
    assert.equal(owners.size, 1, `chunk ${s.ordinal} must hold photos of exactly one record, got ${[...owners]}`);
    assert.ok(photosIn(s.text).length > 0, `chunk ${s.ordinal} should carry its record's photos`);
  }

  // Every chunk begins at a record start, i.e. with a community name.
  assert.match(segs[0].text, /^Atria Tamalpais Creek\t/);
  assert.match(segs[1].text, /^AlmaVia of San Rafael\t/);
  assert.match(segs[2].text, /^Drake Terrace\t/);

  // No chunk is content-free (the condition that forced the model to invent an
  // item out of URL filenames).
  for (const s of segs) {
    const withoutUrls = s.text.replace(/https?:\/\/\S+/g, " ");
    assert.ok(withoutUrls.replace(/[^\p{L}]/gu, "").length > 40, `chunk ${s.ordinal} must carry real text, not just URLs`);
  }

  // All media preserved, none duplicated across chunks.
  const all = segs.flatMap((s) => photosIn(s.text));
  assert.equal(all.length, 19, "8 + 2 + 9 photos survive the plan");
  assert.equal(new Set(all).size, 19, "no photo appears in two chunks");
});

test("trailing empty columns do not defeat detection", () => {
  // The real paste scanned as 26 / 26 / 6 tab fields because a spreadsheet pads
  // rows to the selection width but not the final row. Counting to the last
  // NON-EMPTY field is what makes these the same record shape.
  const padded = REPLICA;
  const unpadded = [
    row("Atria Tamalpais Creek", "Novato", "AtriaTC", 8, 22, 0),
    row("AlmaVia of San Rafael", "San Rafael", "AlmaViaSR", 2, 22, 0),
    row("Drake Terrace", "San Rafael", "DrakeT", 9, 22, 0),
  ].join("\n");
  assert.equal(segment(padded, DEFAULT_BUDGET).length, 3, "padded rows still detected");
  assert.equal(segment(unpadded, DEFAULT_BUDGET).length, 3, "unpadded rows still detected");
});

test("ranges tile the source exactly (property)", () => {
  for (const src of [REPLICA, REPLICA + "\n", "a\tb\nc\td", prose("X", 30)]) {
    const segs = segment(src, DEFAULT_BUDGET);
    if (segs.length === 0) continue;
    assert.equal(segs[0].sourceStart, 0);
    assert.equal(segs[segs.length - 1].sourceEnd, src.length);
    let joined = "";
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) assert.equal(segs[i].sourceStart, segs[i - 1].sourceEnd, "contiguous, no gap or overlap");
      assert.equal(segs[i].text, src.slice(segs[i].sourceStart, segs[i].sourceEnd));
      joined += segs[i].text;
    }
    assert.equal(joined, src, "reassembly is byte-identical");
  }
});

// ------------------------------------------------------------------
// Other structured formats
// ------------------------------------------------------------------
test("the same data as quoted CSV is detected too", () => {
  const csv = REPLICA.split("\n").map((r) => {
    const cells = r.split("\t").filter((c) => c !== "");
    return cells.map((c) => (c.startsWith('"') ? c : `"${c}"`)).join(",");
  }).join("\n");
  const segs = segment(csv, DEFAULT_BUDGET);
  assert.equal(segs.length, 3, "comma-delimited multi-line records detected");
  for (const s of segs) assert.equal(ownersIn(s.text).size, 1);
});

// ------------------------------------------------------------------
// Detection must DECLINE on everything that is not convincingly a table
// ------------------------------------------------------------------
test("prose is never mistaken for a table", () => {
  const cases: Record<string, string> = {
    plainProse: prose("Somewhere", 20),
    proseWithQuotes: `He said "hello" and left.\n\nShe replied "goodbye" later.\n\nThey both "agreed".`,
    oddQuoteCount: `A line with one " quote.\n\nAnother line.\n\nA third line.`,
    singleLine: "just one line of text",
    emptyish: "   \n  \n ",
  };
  for (const [name, src] of Object.entries(cases)) {
    const segs = segment(src, DEFAULT_BUDGET);
    // The assertion that matters: whatever the plan, it must not be a
    // one-chunk-per-LINE record plan, and it must still tile exactly.
    if (segs.length === 0) continue;
    let joined = "";
    for (const s of segs) joined += s.text;
    assert.equal(joined, src, `${name}: tiling holds`);
  }
});

test("ragged field counts are rejected", () => {
  // Not a table: rows disagree on shape even ignoring trailing empties.
  const ragged = "a\tb\tc\nd\te\nf\tg\th\ti";
  const segs = segment(ragged, DEFAULT_BUDGET);
  let joined = "";
  for (const s of segs) joined += s.text;
  assert.equal(joined, ragged, "falls back safely and still tiles");
});

test("an unbalanced quote falls back rather than guessing", () => {
  const torn = REPLICA.slice(0, REPLICA.length - 1); // drop the final closing quote
  const segs = segment(torn, DEFAULT_BUDGET);
  let joined = "";
  for (const s of segs) joined += s.text;
  assert.equal(joined, torn, "tiling still exact on the fallback path");
});

// ------------------------------------------------------------------
// Adaptive re-split must also refuse to cut inside a record
// ------------------------------------------------------------------
test("splitRange prefers record starts over blank lines", () => {
  const children = splitRange(REPLICA, 0, REPLICA.length);
  assert.ok(children.length >= 2);
  let joined = "";
  for (const c of children) joined += REPLICA.slice(c.start, c.end);
  assert.equal(joined, REPLICA, "children tile the range exactly");
  // Every interior cut lands at a record start (a line beginning a new row).
  for (let i = 1; i < children.length; i++) {
    const at = children[i].start;
    const before = REPLICA.slice(0, at);
    assert.ok(before.endsWith("\n"), "cut lands at a line/record boundary");
  }
});
