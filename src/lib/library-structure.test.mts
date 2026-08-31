import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  swapForMove, appendOrders, buildTree, sameContainer,
  emptyGroupIds, emptySectionIds, findByName, showStructure, canReorder,
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
  // Still the point, and now it carries two intents rather than one: a step up
  // or down, and a position relative to a named neighbour. What it must never
  // accept is an ORDER, because a paged client does not have one.
  const route = bodyOf("src/app/api/library/order/route.ts");
  assert.match(route, /const \{ kind, id, direction, sectionId, groupId, before, after \} = body/,
    "the route no longer takes one thing, one direction, and one neighbour");
  assert.ok(!/orderedIds|blockIds|ids\b/.test(route),
    "the route accepts an id LIST, which a paged client cannot supply correctly");
  // And the owner is never the client's to name.
  assert.ok(!/p_owner:\s*(body|req)/.test(route), "the owner comes from the request");
  assert.match(route, /session\.userId/, "the owner is not taken from the session");
});

test("the server resolves the neighbour from the whole container", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const fn = svc.slice(svc.indexOf("export async function moveItem"));
  const body = fn.slice(0, fn.indexOf("export async function moveSection"));
  assert.ok(!/limit\(/.test(body), "the container read is capped, so a long section reorders wrongly");
  // The step is now expressed as the neighbour it lands beside, and handed to
  // the same transactional primitive a drag uses.
  assert.match(body, /neighbourFor\(ordered/, "the move is not computed from the container");
  assert.match(body, /moveStructural\(/, "a one-step move bypasses the shared primitive");
});

test("EVERY structural move goes through the one locked primitive", () => {
  // The reason to share it is not tidiness. `library_move` takes a per-owner
  // advisory lock, so two paths that each wrote their own statements would not
  // be serialized against each other — a drag and a Move down could interleave
  // and one would silently undo the other.
  const svc = bodyOf("src/lib/library-service.ts");
  assert.match(svc, /db\.rpc\("library_move"/, "nothing calls the transactional move");
  assert.equal((svc.match(/db\.rpc\("library_move"/g) ?? []).length, 1,
    "the RPC is called from more than one place; there should be a single door");
  for (const fn of ["moveItem", "moveSection", "moveGroup"]) {
    const at = svc.indexOf(`export async function ${fn}`);
    const body = svc.slice(at, svc.indexOf("export ", at + 10));
    assert.match(body, /moveStructural\(/, `${fn} writes its own order`);
  }
  // Single-item "Move to…" shares it too; bulk placement deliberately does not.
  const place = svc.slice(svc.indexOf("export async function placeItems"));
  assert.match(place, /ordered\.length === 1 && sectionId/,
    "a single-item placement does not share the primitive");
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
// THE LEGACY CATEGORY IS GONE, NOT MERELY UNUSED
//
// Dead compatibility machinery kept "just in case" is machinery that has to be
// reasoned about forever. These assert it is actually absent.
// ---------------------------------------------------------------------------
test("no runtime code reads or writes the legacy category", () => {
  for (const f of ["src/lib/library-service.ts", "src/lib/library-structure.ts",
                   "src/lib/library-organization.ts", "src/lib/library-adapter.ts",
                   "src/app/api/library/route.ts", "src/app/api/library/bulk/route.ts",
                   "src/app/api/library/[id]/route.ts",
                   "src/components/library/library-filters.tsx",
                   "src/components/library/library-list.tsx",
                   "src/components/library/library-workspace.tsx"]) {
    assert.ok(!/\bcategory\b/i.test(bodyOf(f)), `${f} still references the legacy category`);
  }
});

test("the cutover machinery is gone with it", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  assert.ok(!/unreconciled|shadowCategory/.test(svc), "the cutover guard or shadow survives");
  assert.ok(!/unreconciled/.test(bodyOf("src/app/api/library/bulk/route.ts")),
    "the route still handles a state that can no longer occur");
});

test("placement writes a section, a group and a position — and nothing else", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const place = svc.slice(svc.indexOf("export async function placeItems"),
                          svc.indexOf("export async function pruneEmptyStructure"));
  assert.match(place, /\.update\(\{ section_id: sectionId, group_id: groupId, sort_order: [^}]*\}\)/,
    "placement writes a column it should not");
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
test("drag is added WITHOUT removing the way that already worked", () => {
  // The previous phase asserted the absence of dnd-kit here. That was a phase
  // boundary, not a principle, and this phase crosses it deliberately. What
  // remains a principle is that drag is the fast path and not the only one:
  // the step controls stay, and they are what a small screen and a keyboard
  // still rely on.
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /DndContext/, "the structured view has no drag context");
  assert.match(view, /aria-label=\{`Move \$\{label\} up`\}/,
    "Move up is gone, or no longer says what it moves");
  assert.match(view, /aria-label=\{`Move \$\{label\} down`\}/,
    "Move down is gone, or no longer says what it moves");
  assert.match(view, /onMove \?/, "Move… is gone");
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

test("0042 carries NO shadow-agreement precondition", () => {
  // The structured runtime deploys BEFORE 0042 and stops maintaining
  // `category` the moment it is live, so the shadow goes stale by design. A
  // precondition demanding they still agree would reject the migration on the
  // first thing filed after the deploy, and protects nothing once nothing
  // writes the column.
  const sql = readFileSync("supabase/migrations/0042_library_retire_category.sql", "utf8");
  assert.ok(!/still describe two different homes/.test(sql),
    "0042 still refuses to run unless the retired shadow agrees");
  assert.ok(!/\$pre\$/.test(sql), "0042 still has a precondition block");
  // What it DOES still verify.
  for (const guarantee of ["content must never be lost", "changed during a column drop",
                           "the section/group structure changed"]) {
    assert.ok(sql.includes(guarantee), `0042 no longer asserts: ${guarantee}`);
  }
});

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

// ---------------------------------------------------------------------------
// RENAME
//
// Possible only now. While `category` shadowed the section's name onto every
// item, renaming meant a second write across every descendant — non-atomic, and
// able to leave the two disagreeing — so it was withheld rather than done
// badly. With the shadow retired the name lives in exactly one place.
// ---------------------------------------------------------------------------
test("rename writes the NAME and nothing else", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const fn = svc.slice(svc.indexOf("export async function renameStructure"));
  assert.match(fn, /\.update\(\{ name \}\)/, "rename writes more than the name");
  for (const forbidden of ["sort_order", "section_id", "group_id", "revision", "updated_at",
                           "labels", "is_favorite", "library_items"]) {
    assert.ok(!fn.includes(forbidden), `rename can reach ${forbidden}`);
  }
  assert.match(fn, /\.eq\("id", id\)\.eq\("user_id", userId\)/, "rename is not owner-scoped");
});

test("a duplicate name is refused by the DATABASE, not by a check-then-write", () => {
  const svc = bodyOf("src/lib/library-service.ts");
  const fn = svc.slice(svc.indexOf("export async function renameStructure"));
  // A read-then-write would race: two tabs could both see "free" and both
  // write. The unique index refuses whatever else is happening.
  assert.match(fn, /error\.code === "23505" \? "duplicate_name"/,
    "a unique violation is not translated into a name clash");
  assert.ok(!/select\("id, name"\)|findByName/.test(fn),
    "rename checks for a duplicate before writing, which races");

  const sql = readFileSync("supabase/migrations/0039_library_structure_expand.sql", "utf8");
  assert.match(sql, /library_sections_user_name_key\s*\n\s*on public\.library_sections \(user_id, lower\(name\)\)/,
    "sections have no case-insensitive unique index for rename to rely on");
  assert.match(sql, /library_groups_section_name_key\s*\n\s*on public\.library_groups \(section_id, lower\(name\)\)/,
    "groups are not unique per SECTION, so identical names across sections would break");
});

test("rename is offered only where the structure is the professional's to change", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /onRename=\{reorder \? \(n\) => rename\("section", sec\.id, n\) : undefined\}/,
    "section rename is not gated the same way reordering is");
  assert.match(view, /onRename=\{reorder \? \(n\) => rename\("group", g\.id, n\) : undefined\}/,
    "group rename is not gated the same way reordering is");
  // reorder is false in both pickers and whenever a filter is narrowing.
  for (const picker of ["src/components/library/library-picker.tsx",
                        "src/components/library/use-library-picker.tsx"]) {
    assert.ok(!/reorder|onRename/.test(bodyOf(picker)), `${picker} can rename the structure`);
  }
});

test("the rename affordance is VISIBLE, not revealed by hovering", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  // A hover-only control does not exist on a touch device.
  assert.ok(!/group-hover\/head|text-muted\/0/.test(view),
    "the heading action is hidden until hover");
  assert.match(view, /aria-label=\{`Actions for \$\{name\}`\}/, "there is no visible actions control");
  assert.match(view, /aria-haspopup="menu"/);
  assert.match(view, /role="menuitem"/);
  // One action. A heading is not a settings screen.
  assert.equal((view.match(/role="menuitem"/g) ?? []).length, 1,
    "the heading menu carries more than the one action it needs");
});

test("rename happens IN PLACE, with no dialog and no management screen", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /if \(editing\) \{/, "the heading does not become a field");
  assert.match(view, /e\.key === "Escape"/, "there is no way to abandon a rename");
  assert.match(view, /onBlur=\{commit\}/, "clicking away discards what was typed");
  assert.ok(!/role="dialog"|fixed inset-0/.test(view), "rename opens a dialog");
});

test("an unchanged or emptied name closes quietly instead of erroring", () => {
  const view = bodyOf("src/components/library/library-structure-view.tsx");
  assert.match(view, /if \(!wanted \|\| wanted === name\) \{ setEditing\(false\); setDraft\(name\); return; \}/,
    "a no-op rename is sent to the server, or reports a failure the professional did not cause");
});
