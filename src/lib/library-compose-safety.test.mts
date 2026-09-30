// A BUTTON THAT SAID "YOU ARE HERE" AND MEANT "START OVER".
//
// Reported from real client work on sendset.io. A professional had chosen five
// memory-care communities into a Sendset, reached for the nearest thing that
// said Create, and lost all five. No confirmation, no undo, back to square one.
//
// The trap was not carelessness. While composing, the header's "Create a
// Sendset" rendered as the ACTIVE, filled, aria-pressed button — the strongest
// "you are here" signal on the screen — directly above the list being built.
// Its handler began `setChosen([])`. And on a desktop the tray's own Create was
// `lg:hidden`, so the only real Create was a small secondary-sized button in
// the banner: the loudest button near the finished list was the one that
// destroyed it.
//
// Two rules come out of it, and both are checked below:
//   1. Nothing that discards a composition may sit in the header while one is
//      under way.
//   2. The action that finishes the work belongs where the work ends, at every
//      width — not only where a breakpoint made it convenient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FILE = "src/components/library/library-workspace.tsx";
const raw = readFileSync(FILE, "utf8");
/** Comments explain the defect by name; only code counts. */
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
  .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

/** Every handler in the file that empties the chosen list. */
const clearers = [...code.matchAll(/onClick=\{\(\) => \{[^}]*setChosen\(\[\]\)[^}]*\}\}/g)].map((m) => m[0]);

/** The header cluster: the row of mode buttons above the Library.
 *
 *  BOUNDED BY THE JSX ENTITY, not by the words. The first version ended the
 *  slice at "Select & Organize", which the source writes as `Select &amp;
 *  Organize` — so it matched a prose mention much further down instead, and the
 *  "header" swallowed half the file including the organize panel's own Done
 *  button. That button clears deliberately and correctly, and the test called
 *  it a defect. A region defined by a string that is not in the region is not a
 *  region. */
const HEADER = code.slice(code.indexOf("Import with AI"), code.indexOf("Select &amp; Organize"));

test("THE HEADER'S 'Create a Sendset' IS NOT REACHABLE WHILE COMPOSING", () => {
  // It still exists — starting a fresh composition is what it is for — but it
  // is rendered only when there is no composition to destroy.
  assert.match(code, /\{!composing && \(\s*<Button[^>]*>[\s\S]{0,200}?Create a Sendset/,
    "the header's Create a Sendset is not gated on !composing");
  // And it no longer dresses itself as the current mode. `aria-pressed` on a
  // control that resets is the exact lie that cost five items.
  assert.ok(!/aria-pressed=\{composing\}/.test(HEADER),
    "a header control still announces itself as the active composition");
});

test("NOTHING IN THE HEADER CAN DISCARD A COMPOSITION", () => {
  // The rule, not the one button. A second control added later with the same
  // handler would be the same defect wearing a different label.
  assert.ok(clearers.length > 0, "nothing clears the chosen list — has the composer changed shape?");
  assert.ok(HEADER.length > 100 && HEADER.length < code.length / 2,
    `the header slice is ${HEADER.length} chars — the boundary is wrong, so this test is checking the wrong region`);
  for (const h of clearers) {
    if (!HEADER.includes(h)) continue;
    // A clearer may live in the header only inside a !composing guard.
    const at = code.indexOf(h);
    const before = code.slice(Math.max(0, at - 400), at);
    assert.match(before, /\{!composing &&/,
      `a header control discards the composition with no !composing guard: ${h.slice(0, 90)}`);
  }
});

test("CANCEL IS STILL THE WAY OUT, and it is the one that says so", () => {
  // Removing the trap must not remove the exit. Cancel clears deliberately,
  // which is correct: it is named for what it does.
  assert.match(code, /setSelecting\(false\); setChosen\(\[\]\); setAddedTitles\(\{\}\);/,
    "the composer lost its cancel");
});

test("THE FINISHING ACTION SITS WHERE THE LIST ENDS, AT EVERY WIDTH", () => {
  const footer = code.slice(code.indexOf("footer={chosen.length > 0"), code.indexOf("</aside>"));
  assert.ok(footer.length > 0, "the tray's footer is gone");
  assert.ok(!/lg:hidden/.test(footer),
    "the tray's Create is hidden on desktop again — the only Create would be at the top");
  assert.match(footer, /onClick=\{createSendset\}/);
  assert.match(footer, /Create Sendset with \$\{chosen\.length\}/,
    "the action under the list no longer says how many items it will use");
  assert.match(footer, /variant="primary"/, "the action at the end of the work does not lead");
});

test("AND IT ONLY APPEARS WHEN THERE IS SOMETHING TO CREATE", () => {
  assert.match(code, /footer=\{chosen\.length > 0 &&/,
    "an empty tray would offer to create a Sendset with nothing in it");
});

test("THE BANNER'S COPY STEPS DOWN rather than competing", () => {
  const banner = code.slice(code.indexOf("Start a Sendset"), code.indexOf("footer={chosen.length > 0"));
  const create = banner.match(/<Button variant="(\w+)" size="sm"[^>]*\n?[^>]*onClick=\{createSendset\}/);
  assert.ok(create, "the banner's Create Sendset is gone — on a phone the tray is a long scroll away");
  assert.equal(create![1], "secondary",
    "two primary Create buttons compete; the one at the end of the work should lead");
  assert.match(banner, /disabled=\{busy \|\| chosen\.length === 0\}/,
    "the banner offers to create from an empty list");
});

test("BOTH CREATE CONTROLS ARE THE SAME ACTION — there is no second path", () => {
  assert.equal((code.match(/onClick=\{createSendset\}/g) ?? []).length, 2,
    "a create control was added or removed without this test noticing");
});
