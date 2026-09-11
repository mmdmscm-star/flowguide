// A LABEL IS NEVER NARROWER THAN ITS LONGEST WORD.
//
// The atomic detail row anchors a short value right, so a run of them reads as
// a column. It used to do that by making the value immovable —
// `flex-shrink-0 whitespace-nowrap` — on the stated reasoning that "the label
// absorbs every bit of the pressure by wrapping". The label does wrap. It does
// not wrap between WORDS: it carried `overflow-wrap: anywhere` and `min-w-0`,
// and those two together remove every floor an element has.
//
// `overflow-wrap: anywhere` lowers min-content width to a single character —
// that is the only thing separating it from `break-word`, which allows the same
// emergency breaks without affecting intrinsic size. `min-w-0` then removes the
// flex default (`min-width: auto`, which resolves to min-content). So on a
// narrow phone a 17-character value beside a one-word label squeezed that label
// to 31px and printed it down the card one letter per line.
//
// THE TWO HALVES ONLY WORK TOGETHER, which is why both are pinned here. A label
// with a floor beside a value that cannot yield is not a fix — it is the same
// squeeze with `overflow-hidden` over it, so the VALUE gets clipped instead.
// Measured on all four demos at 320/360/390/512: labels broken 5 → 0, nothing
// clipped at any width, and at 360 and above the rendering is unchanged down to
// the line count.
//
// This is a source test because the property is a layout one and jsdom has no
// layout engine — there is no width to measure in a unit test. What it pins is
// the mechanism, and the reasoning above is the part that must not be lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CARD = readFileSync(join(ROOT, "src/components/item-card.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

/** The atomic branch: from its guard to the block row that follows it. */
function atomicRow() {
  const from = CARD.indexOf("if (atomic)");
  assert.ok(from > 0, "the atomic row is gone");
  const to = CARD.indexOf("return (", CARD.indexOf("}", CARD.indexOf("</div>", from)));
  const slice = CARD.slice(from, to > from ? to : from + 1600);
  assert.ok(slice.includes("detail.label") && slice.includes("detail.value"),
    "the slice missed the row's two columns; this test is reading the wrong code");
  return slice;
}

test("THE LABEL KEEPS A FLOOR — its longest word", () => {
  const row = atomicRow();
  const label = row.slice(row.indexOf("detail.label") - 400, row.indexOf("detail.label"));
  assert.doesNotMatch(label, /overflow-wrap:anywhere/,
    "the label can break inside a word again, which lowers its min-content width to one character");
  assert.doesNotMatch(label, /\bmin-w-0\b/,
    "the label lost its flex floor, so it can be squeezed below its longest word");
  assert.match(label, /break-words/,
    "the label cannot break at all now — a long single word will overflow instead");
});

test("…AND THE VALUE CAN YIELD, or the floor just moves the damage", () => {
  const row = atomicRow();
  const value = row.slice(row.indexOf("detail.value") - 400, row.indexOf("detail.value"));
  assert.doesNotMatch(value, /whitespace-nowrap/,
    "the value cannot wrap, so a label with a floor clips the value instead of fixing anything");
  assert.doesNotMatch(value, /flex-shrink-0/,
    "the value cannot shrink, so the row overflows its own container");
  assert.match(value, /overflow-wrap:anywhere/,
    "an unbreakable token can no longer yield, so a long URL will be clipped");
});

test("the column survives — this was never about removing it", () => {
  const row = atomicRow();
  assert.match(row, /items-start/,
    "values no longer align to the first line, so a run of them stops reading as a column");
  assert.match(row, /text-right/, "the value stopped being right-aligned");
});

test("THE CLASSIFIER IS UNCHANGED — this was not a threshold change", () => {
  // Moving SHORT_VALUE_MAX_CHARS would have moved the cliff rather than
  // removing it, and would have re-sorted rows between two layouts for reasons
  // that have nothing to do with what the value is.
  assert.match(CARD, /SHORT_VALUE_MAX_CHARS = 20/,
    "the atomic threshold moved; the label-width fix does not need it to");
  assert.match(CARD, /const isAtomicValue = \(value: string\) =>/,
    "the value-shape classifier is gone");
});
