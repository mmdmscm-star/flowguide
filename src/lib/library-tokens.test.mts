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
const css = readFileSync("src/app/globals.css", "utf8");

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
