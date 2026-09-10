// MAKING THE SECOND DIMENSION REACHABLE.
//
// Real use produced a Section called "Large - Santa Rosa". Two dimensions were
// wearing one label because, at the moment of filing, only one box existed: the
// placement panel told the professional a group is for "a town", then withheld
// the group control whenever the section was new and offered instead "You can
// add groups inside it once it exists". A first-ever filing is ALWAYS a new
// section, so the promise was never available when it was needed.
//
// Nothing about the model was wrong. library_sections, library_groups,
// library_items.section_id/group_id and placeItems' newSectionName +
// newGroupName all existed and all worked. What is pinned here is that the
// professional can now REACH them.
//
// The menu behaviour is proven by mounting the real component; the placement
// panel is a large component wired to the whole workspace, so its two corrected
// branches are asserted against the source. Where a claim could be made about
// behaviour it is made about behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const codeOf = (p: string) => readFileSync(p, "utf8");
/** Source with comments stripped. A rule must be asserted against the CODE:
 *  these comments quote the old copy they replaced ("Tick anything below to
 *  begin"), so a raw search finds the explanation rather than the JSX. */
const bodyOf = (p: string) =>
  codeOf(p).replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const WORKSPACE = "src/components/library/library-workspace.tsx";
const VIEW = "src/components/library/library-structure-view.tsx";
const SERVICE = "src/lib/library-service.ts";

const SECTION = "sec-1", GROUP = "grp-1";
let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let View: typeof import("../components/library/library-structure-view.tsx").LibraryStructureView;

/** Every write the component could make. Nothing here should ever grow an entry
 *  from opening a menu — that is the "no empty group" claim. */
const writes: Array<{ path: string; method: string; body: unknown }> = [];

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url, "https://sendset.test");
  const json = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => b } as unknown as Response);
  if (init?.method && init.method !== "GET") {
    writes.push({ path: u.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  }
  if (u.pathname === "/api/library/browse") {
    return json({
      structure: {
        sections: [{ id: SECTION, name: "Communities", sortOrder: 0 }],
        groups: [{ id: GROUP, sectionId: SECTION, name: "Santa Rosa", sortOrder: 0 }],
      },
      containers: [
        { sectionId: SECTION, groupId: GROUP,
          items: [{ id: "g-1", title: "Grouped One", address: "1 Group St", sortOrder: 0, labels: [] }],
          total: 1, cursor: null, hasMore: false },
        { sectionId: SECTION, groupId: null,
          items: [{ id: "l-1", title: "Loose One", address: "2 Loose Rd", sortOrder: 0, labels: [] }],
          total: 1, cursor: null, hasMore: false },
      ],
      unorganized: { sectionId: null, groupId: null, items: [], total: 0, cursor: null, hasMore: false },
      vocabulary: { categories: [], labels: [], hasFavorites: false },
    });
  }
  return json({ items: [], hasMore: false, nextContainerCursor: null });
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://sendset.test/", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => fakeFetch(url, init)) as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ LibraryStructureView: View } = await import("../components/library/library-structure-view.tsx"));
});
after(() => dom.window.close());

async function mount(props: Record<string, unknown> = {}) {
  writes.length = 0;
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(View, props)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return host;
}
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};
const byText = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].filter((b) => re.test(b.textContent ?? ""));
const menuFor = (host: Element, name: string) =>
  [...host.querySelectorAll("button")]
    .find((b) => (b.getAttribute("aria-label") ?? "") === `Actions for ${name}`);

// ---------------------------------------------------------------------------
// THE MENU
// ---------------------------------------------------------------------------

test("A SECTION'S MENU OFFERS Add group…", async () => {
  const host = await mount({ reorder: true, onAddGroup: () => {} });
  const dots = menuFor(host, "Communities");
  assert.ok(dots, "the section has no actions menu");
  assert.equal(byText(host, /Add group/).length, 0, "the action is visible before the menu is opened");
  await click(dots!);
  const add = byText(host, /^Add group…$/);
  assert.equal(add.length, 1, "Add group… is not in the open menu");
  assert.equal(add[0].getAttribute("role"), "menuitem", "it is not a menu item");
  // Rename is still there — this ADDS an action, it does not replace one.
  assert.equal(byText(host, /^Rename$/).length, 1, "Rename was lost");
});

test("IT HANDS BACK THE SECTION IT BELONGS TO", async () => {
  const seen: string[] = [];
  const host = await mount({ reorder: true, onAddGroup: (id: string) => seen.push(id) });
  await click(menuFor(host, "Communities")!);
  await click(byText(host, /^Add group…$/)[0]);
  assert.deepEqual(seen, [SECTION], "the callback did not receive this section's id");
  // And the menu closes behind it, like Rename does.
  assert.equal(byText(host, /^Add group…$/).length, 0, "the menu stayed open");
});

test("NO EMPTY GROUP IS CREATED BY OPENING OR USING THE MENU", async () => {
  // THE POINT OF ROUTING THROUGH FILING. A group that could be conjured empty
  // would leave a named nothing on the shelf and a professional hunting for the
  // way to fill it. Nothing may be written until items are chosen and placed.
  const host = await mount({ reorder: true, onAddGroup: () => {} });
  await click(menuFor(host, "Communities")!);
  await click(byText(host, /^Add group…$/)[0]);
  assert.deepEqual(writes, [], `the menu wrote to the server: ${JSON.stringify(writes)}`);
  const src = codeOf(VIEW);
  const menu = src.slice(src.indexOf("function HeadingMenu"));
  assert.ok(!/fetch\(/.test(menu.slice(0, menu.indexOf("\n}\n"))), "the menu talks to the server itself");
});

test("A GROUP HEADING HAS NO Add group — a group does not nest", async () => {
  const host = await mount({ reorder: true, onAddGroup: () => {} });
  // Sections open CLOSED, so the group heading does not exist until the section
  // is opened. Looking for it first found nothing and would have "passed" the
  // absence check for the wrong reason.
  await click(byText(host, /Expand all/)[0]);
  const dots = menuFor(host, "Santa Rosa");
  assert.ok(dots, "the group has no actions menu");
  await click(dots!);
  assert.equal(byText(host, /^Add group…$/).length, 0,
    "a group offers Add group, which would imply groups nest inside groups");
  assert.equal(byText(host, /^Rename$/).length, 1, "the group lost Rename");
});

test("IT IS ABSENT WHERE THE STRUCTURE IS NOT THE PROFESSIONAL'S TO CHANGE", async () => {
  // Same gate as Rename: not in a picker, and not while a filter is narrowing
  // the list — the two places `reorder` is already false.
  const host = await mount({ reorder: false, onAddGroup: () => {} });
  assert.equal(menuFor(host, "Communities"), undefined,
    "the actions menu appears where the structure cannot be changed");
  // And with no handler supplied, the menu still works for Rename alone.
  const host2 = await mount({ reorder: true });
  await click(menuFor(host2, "Communities")!);
  assert.equal(byText(host2, /^Add group…$/).length, 0, "Add group appears with no handler wired");
  assert.equal(byText(host2, /^Rename$/).length, 1, "Rename was lost when Add group was absent");
});

test("WHILE SELECTING, AN OPEN SECTION WEARS Add group IN THE OPEN", async () => {
  // THE HEADLINE OF THIS CORRECTION, and the one a mutation caught me missing.
  // Real use found the `…` shortcut unfindable: sections can contain groups and
  // nothing on screen said so. Reachable WITHOUT opening any menu.
  const seen: string[] = [];
  const host = await mount({ reorder: true, selectable: true, onAddGroup: (id: string) => seen.push(id) });
  await click(byText(host, /Expand all/)[0]);

  const inline = byText(host, /^\+ Add group$/);
  assert.equal(inline.length, 1, "an open section does not show an inline Add group");
  // NOT inside the overflow popover — that is the affordance this replaces.
  assert.equal(inline[0].closest('[role="menu"]'), null,
    "the inline action is inside the overflow menu, so it is still hidden");
  // And no menu had to be opened to get here.
  assert.equal(host.querySelectorAll('[role="menu"]').length, 0, "a menu was open already");

  await click(inline[0]);
  assert.deepEqual(seen, [SECTION], "the inline action did not target this section");
});

test("THE CALM LIBRARY STAYS CALM — no inline action unless organizing", async () => {
  const host = await mount({ reorder: true, selectable: false, onAddGroup: () => {} });
  await click(byText(host, /Expand all/)[0]);
  assert.equal(byText(host, /^\+ Add group$/).length, 0,
    "browsing the Library shows an organizing control");
  // Collapsed sections stay quiet too: the action belongs to an OPEN section.
  const host2 = await mount({ reorder: true, selectable: true, onAddGroup: () => {} });
  assert.equal(byText(host2, /^\+ Add group$/).length, 0,
    "a collapsed section shows the action for contents nobody can see");
});

// ---------------------------------------------------------------------------
// THE PLACEMENT PANEL
// ---------------------------------------------------------------------------

test("A NEW SECTION NOW OFFERS A GROUP, IN THE SAME ACTION", async () => {
  const src = codeOf(WORKSPACE);
  // The consolation prize is gone.
  assert.ok(!src.includes("You can add groups inside it once it exists"),
    "the misleading copy survives — it promises a control that is not there");
  // And in its place, a group name for the section being created.
  // A fixed window: the JSX contains ")}" inside its own handlers, so cutting at
  // the first one truncated the block mid-attribute.
  const block = src.slice(src.indexOf('{destSection === "__new" && newSection.trim() && ('))
    .slice(0, 900);
  assert.match(block, /value=\{newGroup\}/, "the new-section branch offers no group input");
  assert.match(block, /onChange=\{\(e\) => setNewGroup\(e\.target\.value\)\}/);
  assert.match(block, /placeholder="Group inside it/, "the input does not say what it is for");
});

test("AND THE PLACEMENT ACTUALLY CARRIES newGroupName", async () => {
  // The input would be theatre if the submit still sent only the section. This
  // is the line that made "Large - Santa Rosa" the only expressible answer.
  const src = codeOf(WORKSPACE);
  const call = src.slice(src.indexOf("onClick={() => place("), src.indexOf(">Put them here<"));
  assert.match(call, /newSectionName: newSection,[\s\S]{0,80}newGroupName: newGroup/,
    "a new section is still placed without its group");
  // Optional, not required: blank files straight into the section.
  assert.match(call, /newGroup\.trim\(\) \? \{ newGroupName: newGroup \} : \{\}/,
    "an empty group name would be sent as a group");
  // The existing-section path is untouched.
  assert.match(call, /sectionId: destSection/, "section-only placement was lost");
  assert.match(call, /destGroup === "__new" \? \{ newGroupName: newGroup \}/,
    "the existing-section new-group path was lost");
  assert.match(call, /destGroup \? \{ groupId: destGroup \} : \{\}/,
    "choosing an existing group was lost");
});

test("THE BACKEND IT RELIES ON WAS ALREADY THERE", async () => {
  // No new server path was added, and the UI now depends on an ordering inside
  // placeItems: the section is created FIRST and assigned to `sectionId`, and
  // the group branch runs under `if (sectionId)`. Reversing those would make a
  // new section silently drop its group again, with the UI still offering it.
  const svc = codeOf(SERVICE);
  const fn = svc.slice(svc.indexOf("export async function placeItems"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const assigns = body.indexOf("sectionId = String(");
  const groupBranch = body.indexOf("wantedGroup = cleanName(req.newGroupName)");
  assert.ok(assigns > 0 && groupBranch > assigns,
    "the group is resolved before a newly created section is assigned");
  assert.match(body, /if \(sectionId\) \{/, "the group branch is no longer gated on having a section");
  assert.match(svc, /newSectionName\?: string;[\s\S]{0,120}newGroupName\?: string;/,
    "PlacementRequest no longer accepts both names");
});

test("Add group SWITCHES THE PANEL INTO AN EXPLICIT GROUP-CREATION STATE", () => {
  // THE SECOND CORRECTION. Pre-setting two hidden `select` values moved the
  // screen slightly and then said "Tick anything below to begin" — real use
  // reported no visible path to actually making the group. It is now a mode
  // with a name, a field and a count, rendered AT ZERO SELECTION.
  const src = codeOf(WORKSPACE);
  const start = src.slice(src.indexOf("function startAddGroup"), src.indexOf("function cancelAddGroup"));
  assert.match(start, /setGroupFor\(sectionId\)/, "the mode is not entered");
  assert.match(start, /setChosen\(\[\]\)/, "it pre-selects items nobody chose");
  assert.match(start, /setNewGroup\(""\)/, "a previous group name survives into the new one");
  assert.match(start, /setOrganizing\(true\); setSelecting\(true\)/, "the panel is not opened");

  // The panel branches on the MODE, before the ticked-count branch — so it
  // shows with nothing selected.
  const panel = src.slice(src.indexOf("{groupFor ? ("), src.indexOf(") : chosen.length === 0 ? ("));
  assert.ok(panel.length > 400, "the group-creation branch is missing or empty");
  assert.match(panel, /Add a group inside \{groupForSection\}/, "the panel does not name the target section");
  assert.match(panel, /Group name/, "there is no labelled name field");
  assert.match(panel, /Select the Library items below that belong in this group\./,
    "the panel does not say what to do next");
  assert.match(panel, /\{chosen\.length\} item\{chosen\.length === 1 \? "" : "s"\} selected/,
    "there is no live count");
  const body = bodyOf(WORKSPACE);
  assert.ok(body.indexOf("{groupFor ? (") < body.indexOf("Tick anything below to begin"),
    "the generic prompt still wins over the group-creation state");
});

test("THE NAME FIELD IS VISIBLE AND FOCUSED, AND THE COUNT IS ANNOUNCED", () => {
  const panel = codeOf(WORKSPACE);
  const block = panel.slice(panel.indexOf("{groupFor ? ("), panel.indexOf(") : chosen.length === 0 ? ("));
  assert.match(block, /id="new-group-name"/, "the field has no id to label");
  assert.match(block, /htmlFor="new-group-name"/, "the label is not tied to the field");
  assert.match(block, /autoFocus/, "the field is not focused on entry");
  assert.match(block, /aria-live="polite"/, "the count is not announced as it changes");
});

test("NOTHING IS CREATED UNTIL THERE IS BOTH A NAME AND A SELECTION", () => {
  const src = codeOf(WORKSPACE);
  const block = src.slice(src.indexOf("{groupFor ? ("), src.indexOf(") : chosen.length === 0 ? ("));
  assert.match(block, /disabled=\{busy \|\| !newGroup\.trim\(\) \|\| chosen\.length === 0\}/,
    "Create group is available without a name or without items");
  // And the guard is in the handler too, not only on the button — Enter also
  // reaches it, and a disabled attribute is not a rule.
  const fn = src.slice(src.indexOf("async function createGroup")).slice(0, 1400);
  assert.match(fn, /if \(!groupFor \|\| !name \|\| !chosen\.length\) return;/,
    "createGroup would run with no name or no selection");
  assert.match(fn, /const name = newGroup\.trim\(\);/, "a whitespace-only name would create a group");
});

test("CANCEL WRITES NOTHING", () => {
  const src = codeOf(WORKSPACE);
  const fn = src.slice(src.indexOf("function cancelAddGroup"), src.indexOf("async function createGroup"));
  assert.ok(!/fetch\(|organize\(|place\(/.test(fn), "cancelling talks to the server");
  assert.match(fn, /setGroupFor\(null\)/, "cancelling leaves the mode set");
  assert.match(fn, /setNewGroup\(""\)/, "the typed name survives a cancel");
  assert.match(fn, /setChosen\(\[\]\)/, "the selection survives a cancel");
});

test("SUCCESS IS UNAMBIGUOUS: THE GROUP APPEARS, EXPANDED, WITH A SENTENCE", () => {
  const src = codeOf(WORKSPACE);
  const fn = src.slice(src.indexOf("async function createGroup")).slice(0, 1400);
  // One existing path, not a new one.
  assert.match(fn, /organize\(\{ place: \{ sectionId: groupFor, newGroupName: name \} \}\)/,
    "it does not go through the existing placement path");
  // The section stays open and the new group is revealed rather than collapsed.
  assert.match(fn, /setReveal\(made \? \[groupFor, made\.id\] : \[groupFor\]\)/,
    "the new group is not revealed under its section");
  // A sentence that names what happened, not "Organized 3 items".
  assert.match(fn, /Added \$\{name\} to \$\{section\} with \$\{count\} item/,
    "there is no specific success feedback");
  // And the mode closes.
  assert.match(fn, /setGroupFor\(null\)/, "the panel stays in group-creation after success");
  // A failed write says so and changes nothing.
  assert.match(fn, /if \(!data\) return;/, "a failed placement still reports success");
});

test("REVEALING NEVER CLOSES ANYTHING THE PROFESSIONAL OPENED OR CLOSED", () => {
  const view = codeOf(VIEW);
  assert.match(view, /const isOpen = \(id: string\) => open\[id\] \?\? revealed\.has\(id\);/,
    "reveal is not derived — an explicit toggle may not win over it");
  assert.match(view, /!\(m\[id\] \?\? revealed\.has\(id\)\)/,
    "toggling a revealed heading would not close it");
  // Derived, not synced: a setState inside an effect cascades a render for
  // something already knowable while rendering.
  assert.ok(!/useEffect\(\(\) => \{[\s\S]{0,120}setOpen\(/.test(view),
    "reveal is pushed into state from an effect");
});

// ---------------------------------------------------------------------------
// WHAT MUST NOT HAVE MOVED
// ---------------------------------------------------------------------------

test("LABELS, FAVOURITES, FILTER FLATTENING AND ORDERING ARE UNTOUCHED", async () => {
  const src = codeOf(WORKSPACE);
  assert.match(src, /organize\(\{ addLabels: \[orgLabel\] \}\)/, "adding a label changed");
  assert.match(src, /organize\(\{ removeLabels: \[orgLabel\] \}\)/, "removing a label changed");
  assert.match(src, /organize\(\{ favorite: true \}\)/, "favouriting changed");
  assert.match(src, /organize\(\{ favorite: false \}\)/, "unfavouriting changed");
  // Filtering still collapses the hierarchy, and reordering still hides behind
  // an unfiltered list — both deliberate, neither in scope here.
  const struct = codeOf("src/lib/library-structure.ts");
  assert.match(struct, /if \(\(filtering\.labels \?\? \[\]\)\.length\) return false;/,
    "label filtering no longer flattens the list");
  assert.match(struct, /if \(filtering\.favorite\) return false;/);
  assert.match(struct, /if \(String\(filtering\.q \?\? ""\)\.trim\(\)\) return false;/);
  assert.match(src, /reorder=\{!composing && canReorder\(/, "the reorder gate changed");
});

// The commit before this line of Library work began. Anchoring to a COMMIT is
// the whole point: this read `git diff` against the WORKING TREE, so it checked
// real code only while the package was still uncommitted and evaporated the
// moment it landed — and once the tree was clean it failed outright, on a
// change to a different directory. A guard whose subject depends on version
// control state is not guarding the code.
const BEFORE_THIS_WORK = "725d328";

test("NOTHING NEW REACHES THE DATABASE OR THE RECIPIENT", async () => {
  // Three of these are absolute and can be said about the whole directory: a
  // Library component does not talk to the database, does not stamp a row's
  // timestamp, and does not delete. Stated this way they hold forever instead
  // of only for one diff.
  const dir = execSync("git ls-files src/components/library/", { encoding: "utf8" })
    .trim().split("\n").map((f) => codeOf(f)).join("\n");
  for (const forbidden of [/updated_at/, /supabase/i, /\.delete\(/]) {
    assert.ok(!forbidden.test(dir), `a Library component now carries ${forbidden}`);
  }

  // `revision` is the exception and cannot be banned outright: the workspace
  // reads the one it opened an entry with and sends it back as
  // `expectedRevision`, which is a PRECONDITION, not a value being written.
  // So that one stays scoped to what this line of work added.
  const added = execSync(`git diff -U0 ${BEFORE_THIS_WORK} -- src/components/library/`,
    { encoding: "utf8" })
    .split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  assert.match(added, /onAddGroup/,
    "this is not the diff it should be — the baseline or the path is wrong");
  assert.ok(!/(?<![A-Za-z])revision/.test(added),
    "this work started writing a revision rather than passing one through");
  // One structural home per item is still the model: placement sends ONE
  // section and at most one group, never a list.
  const src = codeOf(WORKSPACE);
  assert.ok(!/sectionIds|groupIds/.test(src), "placement grew a multi-home shape");
});
