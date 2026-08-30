import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  swapForMove, appendOrders, shadowCategory, buildTree, sameContainer,
  emptyGroupIds, emptySectionIds, findByName, showStructure, canReorder, unreconciledIds,
} from "./library-structure.ts";

// Source-shape guards read the CODE, never the prose explaining it. Several
// rules here are argued for at length in comments that mention the very thing
// being forbidden — "no drag", "never copied" — and a scan that left those in
// would match its own rationale and pass forever.
const bodyOf = (p: string) => readFileSync(p, "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
// MOVING — against the whole container, never the loaded page.
// ---------------------------------------------------------------------------
const rows = (...n: number[]) => n.map((x, i) => ({ id: `i${i}`, sortOrder: x }));

test("a move exchanges positions with the ADJACENT row", () => {
  assert.deepEqual(swapForMove(rows(0, 1, 2), "i2", "up"),
    [{ id: "i2", sortOrder: 1 }, { id: "i1", sortOrder: 2 }]);
  assert.deepEqual(swapForMove(rows(0, 1, 2), "i0", "down"),
    [{ id: "i0", sortOrder: 1 }, { id: "i1", sortOrder: 0 }]);
});

test("the edges write NOTHING rather than writing the order they already had", () => {
  assert.equal(swapForMove(rows(0, 1, 2), "i0", "up"), null);
  assert.equal(swapForMove(rows(0, 1, 2), "i2", "down"), null);
  assert.equal(swapForMove(rows(0, 1), "nope", "up"), null);
  assert.equal(swapForMove([], "i0", "up"), null);
});

test("a TIE still moves, because exchanging equal values would not", () => {
  const out = swapForMove(rows(0, 0, 1), "i1", "up");
  assert.ok(out, "a tie must not silently do nothing");
  assert.notDeepEqual(out!.map((r) => r.sortOrder), [0, 0]);
});

test("the LAST VISIBLE ROW of a page is not the last row of its container", () => {
  // The defect this prevents: a client holding one page of a long section and
  // reordering within it would renumber the loaded rows and silently rewrite
  // everything below. Given the WHOLE container, the item three pages in still
  // has somewhere to go down to.
  const whole = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, sortOrder: i }));
  const pageEnd = whole[5];                       // last row a 6-item page shows
  assert.deepEqual(swapForMove(whole, pageEnd.id, "down"),
    [{ id: "x5", sortOrder: 6 }, { id: "x6", sortOrder: 5 }],
    "moving the last visible row must reach the row after it, not stop at the page");
});

test("the move endpoint takes an INTENT, not a list of ids", () => {
  const route = bodyOf("src/app/api/library/order/route.ts");
  assert.match(route, /const \{ kind, id, direction \} = body/,
    "the route accepts something other than one thing and one direction");
  assert.ok(!/orderedIds|blockIds|ids\b/.test(route),
    "the route accepts an id LIST, which a paged client cannot supply correctly");
});

test("the server resolves the neighbour from the whole container", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const fn = svc.slice(svc.indexOf("export async function moveItem"));
  const body = fn.slice(0, fn.indexOf("export async function moveSection"));
  assert.ok(!/limit\(/.test(body), "the container read is capped, so a long section reorders wrongly");
  assert.match(body, /swapForMove\(ordered/, "the move is not computed from the container");
});

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------
test("a placement APPENDS, in the order chosen", () => {
  assert.deepEqual(appendOrders(4, 3), [5, 6, 7]);
  assert.deepEqual(appendOrders(null, 2), [0, 1], "an empty container starts at 0");
});

test("a section or group is REUSED case-insensitively rather than duplicated", () => {
  const secs = [{ id: "s1", name: "Communities" }];
  assert.equal(findByName(secs, "communities")?.id, "s1");
  assert.equal(findByName(secs, "  COMMUNITIES  ")?.id, "s1");
  assert.equal(findByName(secs, "Services"), undefined);
  assert.equal(findByName(secs, "   "), undefined, "a blank name matches nothing");
});

test("a loose item and a grouped item are DIFFERENT containers", () => {
  assert.ok(sameContainer({ sectionId: "s", groupId: null }, { sectionId: "s", groupId: null }));
  assert.ok(!sameContainer({ sectionId: "s", groupId: null }, { sectionId: "s", groupId: "g" }),
    "moving down in a section would otherwise walk into one of its groups");
});

test("organized first, remainder last — at both levels", () => {
  const tree = buildTree(
    [{ id: "b", name: "B", sortOrder: 1 }, { id: "a", name: "A", sortOrder: 0 }],
    [{ id: "g2", sectionId: "a", name: "G2", sortOrder: 1 },
     { id: "g1", sectionId: "a", name: "G1", sortOrder: 0 }]);
  assert.deepEqual(tree.sections.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(tree.sections[0].groups.map((g) => g.id), ["g1", "g2"]);
});

// ---------------------------------------------------------------------------
// PRUNING — structure exists because material is in it.
// ---------------------------------------------------------------------------
test("a group with nothing in it is pruned; one with an item is not", () => {
  assert.deepEqual(
    emptyGroupIds([{ id: "g1" }, { id: "g2" }], [{ groupId: "g1" }]), ["g2"]);
});

test("a section is pruned only when it holds neither items NOR groups", () => {
  assert.deepEqual(emptySectionIds([{ id: "s1" }], [], [{ sectionId: "s1" }]), []);
  assert.deepEqual(emptySectionIds([{ id: "s1" }], [{ sectionId: "s1" }], []), [],
    "a section still holding a group must survive");
  assert.deepEqual(emptySectionIds([{ id: "s1" }], [], [{ sectionId: null }]), ["s1"]);
});

test("pruning is APPLICATION policy, not a trigger", () => {
  // A trigger would fire between "create the section" and "assign the items" —
  // two calls, because supabase-js has no multi-statement transaction — and
  // delete the section the professional had just named.
  const sql = readFileSync("supabase/migrations/0039_library_structure_expand.sql", "utf8");
  assert.ok(!/create trigger/i.test(sql), "0039 adds a trigger");
  assert.match(bodyOf("src/lib/library-service.ts"), /export async function pruneEmptyStructure/);
});

// ---------------------------------------------------------------------------
// THE COMPATIBILITY SHADOW
// ---------------------------------------------------------------------------
test("the shadow carries the SECTION NAME, or nothing", () => {
  assert.equal(shadowCategory("Communities"), "Communities");
  assert.equal(shadowCategory("  Large   Community  "), "Large Community");
  assert.equal(shadowCategory(null), "");
  assert.equal(shadowCategory(undefined), "");
});

test("PLACEMENT is the only writer of category", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const place = svc.slice(svc.indexOf("export async function placeItems"),
                          svc.indexOf("export async function pruneEmptyStructure"));
  assert.match(place, /shadowCategory\(sectionName\)/, "placement does not maintain the shadow");
  assert.match(place, /category \}\)/, "placement does not write the shadow with the move");

  // Any second writer could make category and section_id describe different
  // homes, which is the one thing the shadow must never do.
  const bulk = svc.slice(svc.indexOf("export async function bulkOrganize"),
                         svc.indexOf("export async function libraryVocabulary"));
  assert.ok(!/category/.test(bulk), "bulkOrganize can still write a raw category");
  const one = bodyOf("src/app/api/library/[id]/route.ts");
  assert.ok(!/patch\.category/.test(one), "the single-item route can still write a raw category");
  const editor = bodyOf("src/components/editor/block-item-editor.tsx");
  assert.ok(!/setCategory/.test(editor), "the editor still offers a free-text category");
});

test("NEITHER placement NOR a move touches revision or updated_at", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  for (const [name, end] of [
    ["export async function placeItems", "export async function pruneEmptyStructure"],
    ["export async function moveItem", "export async function moveSection"],
    ["export async function moveSection", "export async function moveGroup"],
  ] as const) {
    const body = svc.slice(svc.indexOf(name), svc.indexOf(end));
    assert.ok(!/revision/.test(body), `${name} writes revision`);
    assert.ok(!/updated_at:/.test(body), `${name} writes updated_at`);
  }
});

test("no organization metadata can travel into a FlowGuide", () => {
  // The copy function enumerates the fields it takes, so structure cannot ride
  // along; the adapter drops it on the way into the editor.
  const copy = readFileSync("supabase/migrations/0036_library_copy_calls_current_update_item_content.sql", "utf8");
  const call = copy.slice(copy.indexOf("perform public.update_item_content"));
  for (const col of ["section_id", "group_id", "sort_order", "category", "labels", "is_favorite"]) {
    assert.ok(!call.slice(0, call.indexOf(";")).includes(col), `${col} is copied into a packet item`);
  }
  const adapter = bodyOf("src/lib/library-adapter.ts");
  const toItem = adapter.slice(adapter.indexOf("export function snapshotToItem"));
  for (const col of ["sectionId", "groupId", "sortOrder", "category", "labels", "isFavorite"]) {
    assert.ok(!toItem.slice(0, toItem.indexOf("\n}")).includes(col),
      `${col} travels into the packet item copy`);
  }
});

// ---------------------------------------------------------------------------
// WHEN STRUCTURE SHOWS, AND WHEN REORDERING DOES
// ---------------------------------------------------------------------------
test("a Library with no sections stays the calm flat list", () => {
  assert.equal(showStructure(false, {}), false);
  assert.equal(showStructure(true, {}), true);
});

test("a filter SUSPENDS the hierarchy rather than drawing it half empty", () => {
  assert.equal(showStructure(true, { q: "villa" }), false);
  assert.equal(showStructure(true, { labels: ["Preferred"] }), false);
  assert.equal(showStructure(true, { favorite: true }), false);
  assert.equal(showStructure(true, { q: "   " }), true, "whitespace is not a search");
});

test("reordering disappears whenever a filter is narrowing the list", () => {
  assert.equal(canReorder({}), true);
  assert.equal(canReorder({ q: "villa" }), false);
  assert.equal(canReorder({ labels: ["Preferred"] }), false);
  assert.equal(canReorder({ favorite: true }), false);
});

test("the workspace actually WIRES those two rules, rather than only exporting them", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  assert.match(ws, /showStructure\(structure\.sections\.length > 0, \{\s*q, labels: filters\.labels, favorite: filters\.favorite,?\s*\}\)/,
    "the workspace decides structure by some other rule");
  assert.match(ws, /reorder=\{canReorder\(\{ labels: filters\.labels, favorite: filters\.favorite \}\)\}/,
    "reorder controls are not gated on the filters");
});

test("SEARCH survives the switch between the two views", () => {
  // The box used to live inside the flat list. Once the structured view could
  // replace that list, typing would have removed the very control being typed
  // into, so the term is owned above both.
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  assert.match(ws, /<LibrarySearch value=\{q\} onChange=\{setQ\}/);
  assert.match(ws, /query=\{q\}/, "the flat list is not told the search term");
});

// ---------------------------------------------------------------------------
// THE PICKERS
// ---------------------------------------------------------------------------
for (const picker of [
  "src/components/library/library-picker.tsx",
  "src/components/library/use-library-picker.tsx",
]) {
  test(`${picker.split("/").pop()} browses the structure but cannot CHANGE it`, () => {
    const src = bodyOf(picker);
    assert.match(src, /<LibraryStructureView/, "organization does not help while assembling");
    assert.ok(!/reorder/.test(src), "a picker offers reordering — choosing is not filing");
    assert.ok(!/onMove/.test(src), "a picker offers Move…");
    assert.ok(!/onToggleFavorite/.test(src), "a picker offers starring");
  });

  test(`${picker.split("/").pop()} keeps its selection across browsing and filtering`, () => {
    const src = bodyOf(picker);
    // Selection lives in the PICKER, not in either list, so expanding a
    // container, paging, searching or filtering cannot clear it. The only
    // things that end a selection session are creating and leaving.
    assert.match(src, /const \[selected, setSelected\] = useState<string\[\]>\(\[\]\)/);
    assert.equal((src.match(/setSelected\(\[\]\)/g) ?? []).length, 0,
      "something clears the selection out from under the professional");
    assert.match(src, /selected=\{selected\}[\s\S]*?<LibraryList/,
      "the structured view is not given the same selection as the flat list");
  });
}

// ---------------------------------------------------------------------------
// NO DRAG, AND NO FILE MANAGER
// ---------------------------------------------------------------------------
test("this phase adds NO drag-and-drop", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  for (const token of ["dnd-kit", "useSortable", "DndContext", "draggable", "onDragEnd"]) {
    assert.ok(!view.includes(token), `the structured view pulls in ${token}`);
  }
  assert.match(view, /aria-label="Move up"/);
  assert.match(view, /aria-label="Move down"/);
});

test("a long container expands IN PLACE rather than becoming its own screen", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /Show more \(\$\{Math\.max\(c\.total - rows\.length, 0\)\} more\)/,
    "there is no in-place expansion");
  assert.ok(!/router\.push|<Link|href=/.test(view),
    "the structured view navigates somewhere — a container became a screen");
});

test("sections and groups are collapsible", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /aria-expanded=\{!collapsed\}/);
});

// ---------------------------------------------------------------------------
// THE CUTOVER RACE
//
// Between 0040 and the structured runtime being reachable, the OLD runtime can
// still write `category`. If a placement then ran before 0041, it would
// overwrite that intent with its section's name — and destroy the evidence,
// because afterwards the two agree and 0041 finds nothing to reconcile.
// ---------------------------------------------------------------------------
const NAMES = new Map([["s1", "Places"], ["s2", "Services"]]);

test("a synchronized item is NOT flagged, so the guard is invisible in normal use", () => {
  assert.deepEqual(unreconciledIds([
    { id: "a", category: "Places", sectionId: "s1" },
    { id: "b", category: "", sectionId: null },
    { id: "c", category: "  places  ", sectionId: "s1" },   // folded, still agreeing
  ], NAMES), []);
});

test("an item the OLD runtime moved is flagged before it can be overwritten", () => {
  assert.deepEqual(unreconciledIds([
    { id: "a", category: "Services", sectionId: "s1" },     // old runtime said Services
  ], NAMES), ["a"]);
});

test("an item the old runtime FILED for the first time is flagged", () => {
  assert.deepEqual(unreconciledIds([
    { id: "a", category: "Documents", sectionId: null },
  ], NAMES), ["a"]);
});

test("an item the old runtime CLEARED is flagged", () => {
  assert.deepEqual(unreconciledIds([
    { id: "a", category: "", sectionId: "s1" },
  ], NAMES), ["a"]);
});

test("a section that no longer exists counts as a disagreement, not a crash", () => {
  assert.deepEqual(unreconciledIds([{ id: "a", category: "Places", sectionId: "gone" }], NAMES), ["a"]);
});

test("PLACEMENT consults the guard before it writes anything", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const place = svc.slice(svc.indexOf("export async function placeItems"),
                          svc.indexOf("export async function pruneEmptyStructure"));
  // THE RESULT MUST GATE THE WRITE. Asserting only that unreconciledIds is
  // mentioned somewhere passes even if its answer is thrown away — a rename
  // that left `stale` permanently empty would keep the early return and the
  // mention, and silently disable the guard.
  assert.match(place,
    /const stale = unreconciledIds\([\s\S]{0,400}?\);\s*\n\s*if \(stale\.length\) return \{ updated: 0, error: "unreconciled" \};/,
    "the guard's answer does not gate the placement");
  const guardAt = place.indexOf("const stale = unreconciledIds");
  const firstWrite = place.indexOf(".update({");
  assert.ok(guardAt !== -1 && (guardAt < firstWrite || firstWrite === -1),
    "the guard runs AFTER a write, which is too late to protect anything");
});

test("the route tells the professional what to do about it", () => {
  const route = bodyOf("src/app/api/library/bulk/route.ts");
  assert.match(route, /error === "unreconciled"/);
  assert.match(route, /Reload the Library and try again/,
    "the refusal gives no remedy");
});

test("placement remains the ONLY writer of category, with no latent second", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const one = svc.slice(svc.indexOf("export async function setLibraryOrganization"),
                        svc.indexOf("export interface BulkOrganizePatch"));
  assert.ok(!/category/.test(one),
    "setLibraryOrganization can still write a category, which is one refactor from a second writer");
});

// ---------------------------------------------------------------------------
// 0041 IS AN INDEPENDENT MIGRATION, NOT A RE-RUN
// ---------------------------------------------------------------------------
test("0041 carries 0040's reconciliation VERBATIM, and is its own migration", () => {
  const a = readFileSync("supabase/migrations/0040_library_structure_cutover.sql", "utf8");
  const b = readFileSync("supabase/migrations/0041_library_structure_catchup.sql", "utf8");
  const BEGIN = "-- ===================== CATCH-UP BLOCK BEGINS";
  const END = "-- ===================== CATCH-UP BLOCK ENDS";
  const block = a.slice(a.indexOf(BEGIN), a.indexOf(END))
    .replace("-- Everything between these markers is what a later 0041 would contain.\n", "")
    .slice(a.slice(a.indexOf(BEGIN), a.indexOf(END)).indexOf("\n"));
  assert.ok(b.includes(block.trim().slice(0, 400)),
    "0041 has drifted from the reconciliation that was tested in 0040");
  // Its own snapshot table, so running it never depends on 0040's transaction.
  assert.match(b, /zz_0041_before/);
  assert.ok(!b.includes("zz_0040_before"), "0041 refers to 0040's temp table");
});
