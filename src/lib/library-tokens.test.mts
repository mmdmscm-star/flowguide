import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// TOKEN NAMESPACES CAN COLLIDE SILENTLY, AND THE FAILURE LOOKS LIKE A TYPO.
//
// Tailwind resolves `text-<name>` against BOTH `--text-<name>` (font size) and
// `--color-<name>` (colour). Adding `--color-page` beside the existing
// `--text-page` did not error, did not warn, and did not fail a build: it
// simply redefined `.text-page` as `color:#f7f6f4`, so the Library's page
// heading kept its class, lost its size, and rendered near-white on white.
//
// The same trap exists for `--font-*`, `--leading-*` and `--tracking-*`, which
// also answer to `text-*` in some form; colour is the one that has bitten.
// COMMENTS ARE NOT DECLARATIONS. The comment explaining the --color-page /
// --text-page collision mentions `--text-*`, and a scan for "is a text token
// inside this block" duly found it and failed on prose. Every rule below reads
// the stylesheet with comments removed.
const raw = readFileSync("src/app/globals.css", "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

const namesOf = (prefix: string) =>
  new Set([...css.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+)\\s*:`, "gm"))]
    .map((m) => m[1]));

test("no token name lives in both the colour and the text-size namespace", () => {
  const colours = namesOf("color");
  const sizes = namesOf("text");
  const both = [...sizes].filter((n) => colours.has(n));
  assert.deepEqual(both, [],
    `--color-${both[0]} and --text-${both[0]} both answer to \`text-${both[0]}\`; ` +
    "one of them will silently win. Rename one.");
});

test("the tokens the Library actually depends on are all declared", () => {
  // Not a list of everything — a list of the ones whose absence would be
  // invisible rather than obvious, because a missing utility just does nothing.
  for (const t of ["--color-ink", "--color-ink-2", "--color-ink-3",
                   "--color-line", "--color-line-2", "--color-line-3",
                   "--color-ground", "--color-canvas", "--color-ground-2",
                   "--color-ground-3", "--color-mark", "--color-mark-soft",
                   "--color-favorite", "--text-micro", "--text-meta",
                   "--text-body", "--text-title", "--text-page"]) {
    assert.match(css, new RegExp(`^\\s*${t}\\s*:`, "m"), `${t} is not declared`);
  }
});

// ---------------------------------------------------------------------------
// THE PHONE SCALE
//
// Found on an actual iPhone, not in a viewport render: the creator app was
// readable at a desk and uncomfortable at arm's length. "Fits at 390px with no
// overflow" cannot detect that, because nothing is overflowing — which is why
// these are asserted as numbers rather than left to the next screenshot.
// ---------------------------------------------------------------------------

const remOf = (block: string, name: string) => {
  const m = new RegExp(`--text-${name}\\s*:\\s*([0-9.]+)rem`).exec(block);
  assert.ok(m, `--text-${name} is not set in this block`);
  return Number(m![1]);
};

const phoneBlock = () => {
  const m = /@media \(max-width: 639\.98px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, "the phone type block is gone; every size is a desk size again");
  return m![1];
};

test("the type scale can still MOVE — sizes are not baked into the utilities", () => {
  // `@theme inline` substitutes the literal value into `.text-body{...}`, which
  // leaves a media query nothing to change. The whole responsive scale fails
  // silently and completely if a size is ever moved back into that block: the
  // build succeeds, the classes exist, and the phone quietly gets desk sizes.
  const inlineBlock = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(inlineBlock, "the inline theme block is gone");
  assert.ok(!/--text-[a-z-]+\s*:/.test(inlineBlock![1]),
    "a --text-* token is inside `@theme inline`, so it cannot change per breakpoint");
});

test("ordinary interface text is at least 16px on a phone", () => {
  const phone = phoneBlock();
  // 16px is not a preference. iOS Safari zooms the page when a focused input is
  // smaller, so a 15px field made the layout jump on every tap.
  assert.ok(remOf(phone, "body") >= 1,
    "body text is under 16px on a phone: hard to read, and iOS will zoom every input");
});

test("secondary text stays readable, and nothing is tiny", () => {
  const phone = phoneBlock();
  assert.ok(remOf(phone, "meta") >= 0.875,
    "secondary text is under 14px on a phone");
  assert.ok(remOf(phone, "micro") >= 0.8125,
    "the smallest text is under 13px on a phone; truly small text should be exceptional");
});

test("the phone scale is a scale — every step is larger than its desk size", () => {
  const desk = /@theme\s*\{([\s\S]*?)\n\}/.exec(css.replace(/@theme inline\s*\{[\s\S]*?\n\}/, ""));
  assert.ok(desk, "the desk type block is gone");
  const phone = phoneBlock();
  for (const name of ["micro", "meta", "body", "title", "page"]) {
    assert.ok(remOf(phone, name) > remOf(desk![1], name),
      `--text-${name} is not larger on a phone than at a desk`);
  }
});
