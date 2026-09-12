// THE EXAMPLES ARE REAL, AND THE PAGE CANNOT LIE ABOUT THEM.
//
// The homepage's whole strategy is now recognition: four finished Sendsets,
// second on the page, before any explanation of what a Sendset is. That only
// works if they open. A card advertising a demo that has been renamed, or
// unregistered, or never existed, is worse than no card — it is the one thing
// a visitor is invited to click.
//
// So the cards read everything but their one line of copy out of the demo they
// link to, and this file holds the seams that a diff cannot see: that every
// featured slug is a demo the registry actually serves, that the order is the
// one that was chosen, and that nothing about the contents is typed in by hand
// where it could drift.
//
// The before/after is the same claim in a stronger form. The left panel is Day
// A's rows; the right is a photograph of the Sendset those rows render as. The
// page says they are the same information. They are the same OBJECT, and that
// is what is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DEMOS } from "./public-demos.ts";
import { monthOneDemo } from "./demo-month-one.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = readFileSync(join(ROOT, "src/app/page.tsx"), "utf8");
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

/** The slugs the page features, in the order it features them. */
const featured = [...CODE.matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);

test("EVERY FEATURED SENDSET IS ONE THE SITE ACTUALLY SERVES", () => {
  assert.equal(featured.length, 4, `expected four featured demos, found ${featured.join(", ")}`);
  const served = new Set(PUBLIC_DEMOS.map((d) => d.slug));
  for (const slug of featured)
    assert.ok(served.has(slug),
      `the homepage links to /p/${slug}, which the registry does not serve — that link is a 404`);
});

test("…IN THE ORDER THAT WAS CHOSEN", () => {
  // Business first, so a stranger meets Sendset as a serious tool before it
  // shows them a menu; then hospitality, then the personal one the before/after
  // is built from, then a small business publishing its own prices.
  assert.deepEqual(featured, ["demo", "harbor-house", "month-one", "red-awning"],
    "the featured order changed; the first card is what a stranger judges this by");
});

test("THE CARDS READ THE SENDSET, they do not describe it from memory", () => {
  // A card's heading, its contents and its photograph come from the fixture.
  // The only hand-written thing is one line of copy per card — which is why
  // that line is the only string here that could ever be wrong.
  for (const [what, re] of [
    ["the heading", /\{demo\.clientTitle\}/],
    ["the business", /\{demo\.professional\.businessName\}/],
    ["the contents", /\{names\.join\(" · "\)\}/],
    ["the photograph", /src=\{photo\}/],
  ] as Array<[string, RegExp]>)
    assert.match(CODE, re, `${what} is no longer read out of the demo`);
  // Nothing about a demo is typed into this page.
  for (const demo of PUBLIC_DEMOS)
    assert.ok(!CODE.includes(demo.clientTitle!),
      `"${demo.clientTitle}" is written into the homepage; it should come from the fixture`);
});

test("A CARD THAT PROMISES A NEW TAB OPENS ONE", () => {
  assert.match(PAGE, /All four are real and open in a new tab/,
    "the promise above the cards changed");
  // One <Link> in the map, so one target covers all four.
  const from = CODE.indexOf("FEATURED.map");
  assert.ok(from > 0, "the card loop moved; this test is reading the wrong code");
  const card = CODE.slice(from, CODE.indexOf("</Link>", from));
  assert.match(card, /target="_blank"/, "the cards promise a new tab and do not open one");
  assert.match(card, /rel="noopener"/, "a new-tab link without noopener");
});

test("THE BEFORE/AFTER IS THE SAME OBJECT, not two that agree", () => {
  // The left panel is built from the fixture at render time…
  assert.match(CODE, /monthOneDemo\.sections\.find\(\(s\) => s\.title === "Day A"\)/,
    "the spreadsheet panel no longer reads Day A out of the Sendset");
  assert.match(CODE, /DAY_A\.items\.map/, "the rows are no longer the Sendset's items");
  assert.match(CODE, /DAY_A_COLUMNS/, "the columns are hand-written rather than the detail labels");
  // …and the right panel is a photograph of /p/month-one, which renders it.
  assert.match(readFileSync(join(ROOT, "scripts/marketing/capture.mjs"), "utf8"),
    /\$\{ORIGIN\}\/p\/month-one/, "the after panel is no longer captured from the live Sendset");
  // THE CLAIM THE PAGE MAKES ABOUT THEM, AND THE ONE IT MUST NOT.
  //
  // The after panel is a crop of ONE exercise card, so the page may say the two
  // panels come from the same Sendset — they do — but not that they show the
  // same list. It used to read "Same four exercises, same sets, same reps, same
  // starting weights", which describes two panels displaying four rows each,
  // and only the left one does.
  // COMMENTS STRIPPED, THEN FLATTENED. A comment explaining what the old copy
  // said would otherwise trip the negative assertion below — the guard is about
  // what a visitor reads, not about what the file explains to the next reader.
  const prose = CODE.replace(/\s+/g, " ");
  assert.match(prose, /read out of the same Sendset/,
    "the page stopped saying why the two panels agree");
  assert.match(prose, /what the first of them becomes on the right/,
    "the page no longer says the after panel is one row of the left one");
  assert.match(prose, /The first of those rows, as a Sendset/,
    "the after panel's caption promises more than the crop shows");
  assert.doesNotMatch(prose, /Same four exercises|same sets, same reps|same starting weights/i,
    "the copy claims both panels show every row, and the right one shows one card");
  // And Day A is still four exercises with four numbers each, or the
  // spreadsheet stops being a fair picture of what a row can hold.
  const dayA = monthOneDemo.sections.find((s) => s.title === "Day A")!;
  assert.ok(dayA.items.length >= 4, "Day A is too thin to be a spreadsheet");
  for (const i of dayA.items)
    assert.ok((i.details ?? []).length >= 4,
      `"${i.title}" has fewer than four columns, so the two panels no longer line up`);
});

test("THE OLD SECTIONS ARE GONE, not merely pushed down", () => {
  // Two consecutive sections argued about delivery formats, and a third listed
  // job titles. The examples do the third's job better, and the first two are
  // one section near the bottom.
  for (const gone of [
    "For people who have to explain what they",
    "For professionals who hand over",
    "What goes in, and what comes out",
    "The information isn’t missing. It’s scattered",
    "Build it once, not once per format",
  ])
    assert.ok(!PAGE.includes(gone), `a superseded section survived: "${gone}"`);
  // Delivery sits BELOW the Library and the mobile section now, not above them.
  const at = (s: string) => PAGE.indexOf(s);
  assert.ok(at("Build it once. Use it again.") < at("Share it the way that suits"),
    "delivery formats are back above the Library");
  assert.ok(at("Made for the phone in their hand.") < at("Share it the way that suits"),
    "delivery formats are back above the mobile argument");
});
