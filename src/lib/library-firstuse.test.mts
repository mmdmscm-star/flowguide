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
  // Anchored on the prompt's own heading, which is unique. "Save to Library"
  // now appears in the Library bar too, so indexOf would find that one and
  // silently compare the wrong position.
  const end = EDITOR.indexOf("Reuse any of these next time?");
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
test("the empty Library names every way to fill it, in one sentence", () => {
  const empty = WORKSPACE.slice(WORKSPACE.indexOf("Nothing saved yet"));
  const sentence = empty.slice(0, empty.indexOf("</p>", empty.indexOf("</p>") + 4));
  for (const [what, re] of [["importing", /Import/i], ["adding by hand", /manually/i],
                            ["saving while building", /while building a FlowGuide/i]] as const) {
    assert.match(sentence, re, `the empty state must mention ${what}`);
  }
  // SAY IT ONCE. The earlier version explained the same idea in the page
  // description, a paragraph about what a Library holds, and a list — a short
  // manual in front of an empty screen.
  assert.ok(sentence.split(".").filter((x) => x.trim()).length <= 2,
    "one sentence, not a paragraph");
  assert.doesNotMatch(empty, /never changes|makes a copy/,
    "the independence rule belongs at insertion and update, not on an empty screen");
});

test("publish-independence is stated where saving actually happens", () => {
  // Dropped from the empty state on purpose: it is the moment of saving that
  // needs it, and that is where the original confusion arose.
  const prompt = EDITOR.slice(EDITOR.indexOf("Reuse any of these next time?"));
  assert.match(prompt.slice(0, 600), /do not have to publish/i);
});

test("adding by hand is always reachable, not only from the empty state", () => {
  // It used to appear twice — in the toolbar and again inside the empty-state
  // card — which is the duplication the simplification removed. What matters is
  // that the affordance is NOT gated on the Library being empty, so it now lives
  // once, in the toolbar, which renders whenever nothing is being edited.
  // Anchored on the guard's stable head rather than its full condition, which
  // gains a clause each time another full-screen mode is added.
  const toolbar = WORKSPACE.slice(WORKSPACE.indexOf("{!editing && !creating"),
                                  WORKSPACE.indexOf("{importing && ("));
  assert.match(toolbar, /Add manually/, "the toolbar carries it");
  assert.match(toolbar, /setCreating\(true\)/);

  const empty = WORKSPACE.slice(WORKSPACE.indexOf("Nothing saved yet"));
  const card = empty.slice(0, empty.indexOf("</div>"));
  assert.doesNotMatch(card, /<button/,
    "and the empty state does not repeat the buttons sitting directly above it");
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

// ---------------------------------------------------------------------------
// Viewing is not editing
// ---------------------------------------------------------------------------
test("selecting and opening are different elements, so a click is never ambiguous", () => {
  const LIST = read("src/components/library/library-list.tsx");
  // One behaviour per mode, chosen by which element renders — not by a branch
  // inside a shared handler, which is where "did that select or open it?" lives.
  assert.match(LIST, /return selectable \? \(/);
  const rows = LIST.slice(LIST.indexOf("return selectable ? ("));
  const label = rows.slice(0, rows.indexOf(") : ("));
  const button = rows.slice(rows.indexOf(") : ("));
  assert.match(label, /<input type="checkbox"/, "selection mode is a labelled checkbox");
  assert.doesNotMatch(label, /onOpen/, "and cannot open the detail view");
  assert.match(button, /onClick=\{\(\) => onOpen\?\.\(s\)\}/, "normal mode opens on click");
  assert.doesNotMatch(button, /checkbox/, "and has no checkbox");
});

test("the list no longer offers Edit per row — reading comes first", () => {
  const LIST = read("src/components/library/library-list.tsx");
  assert.doesNotMatch(LIST, />\s*Edit\s*</,
    "Edit is an explicit action from the detail view, not the only way to see content");
});

test("the read-only detail renders content, not disabled form controls", () => {
  const DETAIL = read("src/components/library/library-detail.tsx");
  assert.doesNotMatch(DETAIL, /<input|<textarea|<select/,
    "a form of greyed-out inputs reads as broken rather than as read-only");
  assert.doesNotMatch(DETAIL, /disabled=\{true\}/);
  // Empty sections are omitted rather than shown as blank rows.
  for (const g of [/details\.length > 0/, /links\.length > 0/, /photos\.length > 0/, /contacts\.length > 0/]) {
    assert.match(DETAIL, g, "each section is rendered only when it has content");
  }
  assert.match(DETAIL, /onEdit/, "and Edit is offered explicitly");
});

test("opening an entry cannot start an edit by itself", () => {
  const openHandler = WORKSPACE.slice(WORKSPACE.indexOf("onOpen={selecting ? undefined"),
                                      WORKSPACE.indexOf("emptyHint="));
  assert.match(openHandler, /setViewing\(s\)/);
  assert.doesNotMatch(openHandler, /setEditing\(/,
    "clicking a row must not put the professional in an editor");
});
