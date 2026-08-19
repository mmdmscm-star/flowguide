// First-use invariants for the Library, asserted against source in the style of
// library-route.test.mts.
//
// These exist because of a real production finding: on 2026-08-19 a first-time
// professional created a FlowGuide, added items, published it, and never found a
// way to put anything in their Library. Nothing was broken — every affordance
// was present and every route worked. What failed was that the only actions
// which could populate an empty Library were the visually subordinate ones, and
// none of them were where the work ends.
//
// Each assertion below is a way to silently regress back into that, and every
// one of them type-checks perfectly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const EDITOR = read("src/components/editor/legacy-packet-editor.tsx");
const ACTIONS = read("src/components/library/item-library-actions.tsx");
const WORKSPACE = read("src/components/library/library-workspace.tsx");
const ROUTE = read("src/app/api/library/route.ts");
const NAV = read("src/components/nav/creator-nav.tsx");
const RECIPIENT = read("src/app/p/[slug]/page.tsx");

// ---------------------------------------------------------------------------
// Publishing has nothing to do with Library eligibility
// ---------------------------------------------------------------------------
test("no Library route gates on publish status", () => {
  for (const [name, src] of [
    ["POST /api/library", ROUTE],
    ["library-candidates", read("src/app/api/packets/[id]/library-candidates/route.ts")],
  ] as const) {
    assert.doesNotMatch(src, /status[^\n]*published/i,
      `${name} must not consider whether the packet is published`);
  }
});

test("the end-of-work save prompt is not conditioned on packet status", () => {
  const prompt = EDITOR.slice(EDITOR.indexOf("Reuse any of these next time?"));
  const guard = EDITOR.slice(0, EDITOR.indexOf("Reuse any of these next time?")).lastIndexOf("{items.length > 0 && (");
  assert.ok(guard > 0, "the prompt must be gated on having items");
  assert.doesNotMatch(prompt.slice(0, 800), /packet\.status/,
    "a draft must be able to save to the Library exactly like a published one");
});

// ---------------------------------------------------------------------------
// Precedence follows state
// ---------------------------------------------------------------------------
test("the Library bar learns whether the Library is empty before choosing a primary", () => {
  const bar = EDITOR.slice(EDITOR.indexOf("function LibraryBar("), EDITOR.indexOf("export function LegacyPacketEditor"));
  assert.match(bar, /hasSaved/, "the bar must know whether anything is saved");
  assert.match(bar, /const empty = hasSaved === false/,
    "unknown must not be treated as empty — a failed request must not claim the Library is empty");
  assert.match(bar, /empty \? PRIMARY : SECONDARY/,
    "the SAVE action must lead when the Library is empty");
  assert.match(bar, /empty \? SECONDARY : PRIMARY/,
    "and 'Add from Library' must step down when it would open an empty list");
});

test("'Add from Library' is not offered as live when there is nothing to add", () => {
  const bar = EDITOR.slice(EDITOR.indexOf("function LibraryBar("), EDITOR.indexOf("export function LegacyPacketEditor"));
  assert.match(bar, /disabled=\{disabled \|\| empty\}/,
    "an empty Library must not present a working-looking Add button");
});

// ---------------------------------------------------------------------------
// The save action is offered where the work actually ends
// ---------------------------------------------------------------------------
test("bulk save is reachable both while building and after the last section", () => {
  const bar = EDITOR.indexOf("onSaveItems={() => setPromoting(true)}");
  const sections = EDITOR.indexOf("+ Add Section");
  const end = EDITOR.indexOf("Save items to Library");
  assert.ok(bar > 0 && sections > bar, "the Library bar comes before the sections");
  assert.ok(end > sections,
    "and a save affordance must also exist AFTER them — the top bar is off-screen " +
    "by the time the items exist, where the only controls in view are Preview and Publish");
});

test("bulk save is owned once and shared, not implemented twice", () => {
  assert.equal((EDITOR.match(/<BulkPromote/g) ?? []).length, 1,
    "two BulkPromote instances would be two behaviours that can drift");
});

// ---------------------------------------------------------------------------
// Saving reads as an action; ancestry reads as context
// ---------------------------------------------------------------------------
test("'Save to Library' is a button, not the muted ancestry treatment", () => {
  const ancestry = ACTIONS.slice(ACTIONS.indexOf("From your Library"));
  const quietEnd = ancestry.indexOf("</div>");
  assert.doesNotMatch(ancestry.slice(0, quietEnd), /Save to Library/,
    "the save branch must not sit inside the muted ancestry container");
  const save = ACTIONS.slice(ACTIONS.indexOf(") : ("));
  assert.match(save, /rounded-lg border/,
    "the only way to fill an empty Library must render as a real control");
});

// ---------------------------------------------------------------------------
// A Library entry can be written without a FlowGuide
// ---------------------------------------------------------------------------
test("POST /api/library accepts a written item as well as a packet item", () => {
  assert.match(ROUTE, /const \{ itemId, item, force \}/);
  assert.match(ROUTE, /if \(!itemId && !item\)/, "one of the two is still required");
});

test("a directly written entry records no lineage", () => {
  const lineage = ROUTE.slice(ROUTE.indexOf("library_item_id: created.id"));
  const guard = ROUTE.slice(0, ROUTE.indexOf("library_item_id: created.id"));
  assert.match(guard.slice(guard.lastIndexOf("\n\n")), /if \(itemId\)/,
    "lineage must only be written when there is a packet item to write it against");
  assert.ok(lineage.length > 0);
});

test("both doors normalise through the same function, once", () => {
  assert.equal((ROUTE.match(/normalizeItemContent\(/g) ?? []).length, 1,
    "a second normaliser call is a second shape that can drift from the first");
});

test("a written entry must carry a title", () => {
  assert.match(ROUTE, /Give this item a title/,
    "an untitled entry is unfindable, which defeats the point of saving it");
});

// ---------------------------------------------------------------------------
// The empty state explains itself
// ---------------------------------------------------------------------------
test("the empty Library names BOTH ways to fill it", () => {
  const empty = WORKSPACE.slice(WORKSPACE.indexOf("Nothing saved yet"));
  assert.match(empty, /Save from a FlowGuide/);
  assert.match(empty, /draft or published/,
    "the empty state must say publishing is irrelevant, because that is the confusion it exists to fix");
  assert.match(empty, /Create an item/);
});

test("writing an entry directly is not only a first-run affordance", () => {
  assert.ok((WORKSPACE.match(/setCreating\(true\)/g) ?? []).length >= 2,
    "a professional with a full Library must still be able to write a new entry");
});

// ---------------------------------------------------------------------------
// Creator navigation stays on the creator side
// ---------------------------------------------------------------------------
test("the creator nav reaches all three authoring destinations", () => {
  for (const href of ["/dashboard", "/library", "/new"]) {
    assert.ok(NAV.includes(`href: "${href}"`), `nav must reach ${href}`);
  }
});

test("the creator nav is never rendered on a recipient's page", () => {
  // The owner's return path is a separate, much smaller component; see
  // owner-bar.test.mts for that boundary.
  assert.doesNotMatch(RECIPIENT, /CreatorNav/,
    "/p/[slug] is the client's view of one FlowGuide, not an admin surface");
});
