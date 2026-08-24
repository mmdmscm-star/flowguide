// The contents index is NAVIGATION over the FlowGuide, not a second way of
// presenting it. These pin the properties that make that true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/components/section-contents.tsx", "utf8");
const group = readFileSync("src/components/section-group.tsx", "utf8");
const card = readFileSync("src/components/item-card.tsx", "utf8");
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("no index for a single item", () => {
  assert.match(code, /items\.length < 2\) return null/);
});

test("it lists titles in packet order and says nothing ABOUT them", () => {
  assert.match(code, /items\.map\(\(item, i\)/, "not rendering items in given order");
  assert.doesNotMatch(code, /sort\(|reverse\(/, "the index reorders the packet");
  // The moment it summarises, it becomes a second account of the packet that
  // can disagree with the card.
  for (const field of [/item\.description/, /item\.details/, /item\.address/, /item\.contacts/, /item\.links/, /item\.photos/]) {
    assert.doesNotMatch(code, field, `the index reads item content beyond the title: ${field}`);
  }
});

test("real anchors, so back and keyboard behaviour come for free", () => {
  assert.match(code, /href=\{`#item-\$\{item\.id\}`\}/);
  assert.doesNotMatch(code, /onClick|scrollIntoView|preventDefault/,
    "hijacks navigation instead of using an anchor");
});

test("the anchor target is a wrapper — ItemCard itself is untouched", () => {
  assert.match(group, /id=\{`item-\$\{item\.id\}`\}/);
  assert.match(group, /scroll-mt-/, "a jumped-to card sits flush against the viewport top");
  assert.doesNotMatch(card, /scroll-mt-|id=\{`item-/, "the card was modified");
});

test("it is a labelled landmark", () => {
  assert.match(code, /<nav\s/);
  assert.match(code, /aria-label=/);
  // An ordered list, because position in the packet is meaningful.
  assert.match(code, /<ol/);
  // The row number is decoration for a screen reader; the list already numbers.
  assert.match(code, /aria-hidden/);
});

test("one line per row, so the index cannot grow with title length", () => {
  assert.match(code, /truncate/);
});

test("scope: no collapsing, sticky, filtering or comparison", () => {
  for (const banned of [/sticky/, /collapse|expand/i, /filter/i, /compare/i, /useState/]) {
    assert.doesNotMatch(code, banned, `scope broadened: ${banned}`);
  }
});
