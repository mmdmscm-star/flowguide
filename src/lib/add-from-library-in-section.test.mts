// THE WAY BACK INTO THE LIBRARY, WHERE THE WORK IS.
//
// Reported from real client work: a professional built a Sendset from their
// Library, then realised one community was missing, and found no way to add it.
// They reached it by pressing Preview and coming back — which scrolled the
// editor to the top, where the Library bar had been all along, above the title
// and the identity fields and far off the screen by then.
//
// The editor ALREADY KNEW. The "Reuse any of these next time?" card at the foot
// of the page says in its own comment that the Library bar "sits above the
// title and every section ... by the time the items exist, that bar is far off
// the top of the screen". That observation fixed the SAVE half. This is the
// REUSE half, which is the half that was needed.
//
// AND THE SECOND DEFECT, which is worse than the missing button: the top bar
// passes no section, so the API falls back to the FIRST section. Finding it
// would have put the community somewhere the professional was not looking,
// silently, on any Sendset with more than one section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EDITOR = "src/components/editor/legacy-packet-editor.tsx";
const PICKER = "src/components/library/library-picker.tsx";
const ROUTE = "src/app/api/packets/[id]/items/from-library/route.ts";

const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
  .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const editor = strip(readFileSync(EDITOR, "utf8"));

/** The row of "ways to add an item" that sits under each section. */
const row = editor.slice(editor.indexOf("+ Add Item"), editor.indexOf("{pictureError &&"));

test("ADDING FROM THE LIBRARY SITS WITH THE OTHER WAYS TO ADD AN ITEM", () => {
  for (const action of ["+ Add Item", "+ Add picture", "+ Add items with AI", "+ Add from Library"]) {
    assert.ok(row.includes(action), `the section action row lost "${action}"`);
  }
});

test("AND IT PASSES THE SECTION IT IS IN — not the first one", () => {
  // The defect this prevents is silent: without a section the API inserts into
  // whichever section sorts first, so the item appears somewhere the
  // professional was not looking and nothing says so.
  assert.match(row, /setLibrarySection\(section\.id\)/,
    "the button does not record which section it was pressed in");
  assert.match(row, /<LibraryPicker\s+packetId=\{packetId\}\s+sectionId=\{section\.id\}/,
    "the picker is opened without the section, so the insert falls back to the first one");
});

test("THE PICKER SENDS THE SECTION ON, and the route proves it belongs to the packet", () => {
  const picker = strip(readFileSync(PICKER, "utf8"));
  assert.match(picker, /\.\.\.\(sectionId \? \{ sectionId \} : \{\}\)/,
    "the picker stopped forwarding the section id");
  const route = strip(readFileSync(ROUTE, "utf8"));
  // A section id from a request body is not evidence of anything on its own.
  assert.match(route, /\.from\("sections"\)\.select\("id"\)\.eq\("id", targetSection\)\.eq\("packet_id", id\)/,
    "the route stopped proving a supplied section belongs to this Sendset");
  assert.match(route, /order\("sort_order"\)\.limit\(1\)/,
    "the no-section fallback is gone — the top bar still relies on it");
});

test("THE CONFIRMATION APPEARS WHERE THE INSERT HAPPENED", () => {
  // The top bar's notice renders beside the top bar. Reusing it for a
  // per-section insert would confirm success off the top of the screen — the
  // same defect this button exists to fix, in the feedback rather than the
  // control.
  assert.match(row, /setLibrarySectionNotice\(\{\s*id: section\.id,/,
    "a per-section insert reports through the top bar's notice");
  assert.match(row, /librarySectionNotice\?\.id === section\.id/,
    "the confirmation is not rendered beside the section it belongs to");
});

test("LINEAGE IS UNTOUCHED — the copy is still the one transactional RPC", () => {
  // The whole point of routing both entry points through library_copy_into_section
  // is that they cannot drift on lineage, photo normalisation or the content
  // writer. This change alters WHICH section id is passed and WHERE the button
  // is; it must not have grown a second way to insert.
  const route = strip(readFileSync(ROUTE, "utf8"));
  assert.match(route, /supabase\.rpc\("library_copy_into_section"/);
  assert.ok(!/\.from\("items"\)\s*\.insert/.test(route),
    "the route inserts items directly, bypassing the lineage the RPC records");
  // NOTHING IN THE EDITOR WRITES LINEAGE — but it legitimately READS it, which
  // is how it knows an item came from the Library at all (the save-back
  // dialog depends on that). So the ban is on producing the values, not on
  // mentioning them: the first version of this assertion forbade both and
  // failed on an ordinary field read.
  assert.match(editor, /libraryItemId: \(i\.library_item_id as string \| null\) \?\? null/,
    "the editor stopped reading which Library item a row came from");
  assert.ok(!/library_item_revision/.test(editor),
    "the editor touches the revision pin, which only the copy RPC may set");
  assert.ok(!/library_item_id:\s/.test(editor),
    "the editor assigns Library lineage itself instead of leaving it to the RPC");
  // The RPC records both halves of the lineage.
  const sql = readFileSync("supabase/migrations/0036_library_copy_calls_current_update_item_content.sql", "utf8");
  assert.match(sql, /insert into public\.items \(section_id, title, sort_order, library_item_id, library_item_revision\)/,
    "the copy stopped recording which Library item a row came from, and at what revision");
});

test("ONE WORDING, BOTH DOORS", () => {
  // The top bar said "Choose from Library" and the new one says "Add from
  // Library"; two names for one action is how a professional ends up looking
  // for the wrong thing.
  assert.ok(!/Choose from Library/.test(editor), "the top bar still uses the old wording");
  assert.equal((editor.match(/Add from Library/g) ?? []).length, 2,
    "expected exactly two doors to the Library, both named the same");
});

test("THE TOP BAR IS KEPT — it is useful before any sections exist", () => {
  assert.match(editor, /<LibraryBar/, "the top Library bar was removed");
  // It deliberately passes no section: at that point there may not be one, and
  // the route's first-section fallback is the right answer there.
  const bar = editor.slice(editor.indexOf("<LibraryBar"), editor.indexOf("onRefresh={loadPacket}"));
  assert.ok(!/sectionId=/.test(bar), "the top bar now claims a section it cannot know");
});
