// Wiring invariants for "create a FlowGuide from saved material".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { libraryCopyFailure } from "./library-copy-failure.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped. Three times now a whole-file scan has matched
 *  the prose that EXPLAINS an invariant instead of the code that keeps it. */
const code = (p: string) => read(p)
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");
const ROUTE = read("src/app/api/packets/from-library/route.ts");
const EXISTING = read("src/app/api/packets/[id]/items/from-library/route.ts");
const WORKSPACE = read("src/components/library/library-workspace.tsx");
// The dashboard gained a thin server shell (for the first-run identity
// prompt); its menu and list live in the workspace component now.
const DASHBOARD = read("src/components/dashboard/dashboard-workspace.tsx");

// ---------------------------------------------------------------------------
// Atomicity is the DATABASE's, not the route's
//
// The route used to create the packet, then the section, then the items, and
// delete the packet if a later step failed. That is compensating cleanup: a
// process that dies between the write and the cleanup leaves an orphan. These
// pin that the route can no longer be written that way.
// ---------------------------------------------------------------------------
test("the whole creation is ONE rpc call", () => {
  assert.match(ROUTE, /rpc\("create_packet_from_library"/);
  for (const p of ["p_owner", "p_slug", "p_title", "p_client_name", "p_library_item_ids"]) {
    assert.ok(ROUTE.includes(p), `create_packet_from_library needs ${p}`);
  }
});

test("the route performs no writes of its own", () => {
  const body = code("src/app/api/packets/from-library/route.ts");
  for (const t of ["packets", "sections", "items"]) {
    assert.doesNotMatch(body, new RegExp(`from\\("${t}"\\)\\s*\\.insert`),
      `creating ${t} outside the transaction is the orphan this replaced`);
  }
});

test("and no compensating cleanup remains", () => {
  const body = code("src/app/api/packets/from-library/route.ts");
  assert.doesNotMatch(body, /abandon\(/, "compensating cleanup is gone");
  assert.doesNotMatch(body, /\.delete\(\)/,
    "a route that deletes what it just created is the pattern this replaced");
});

test("the old multi-write helper is deleted, not merely unused", () => {
  // existsSync, not assert.throws: a string second argument to assert.throws is
  // an expected ERROR MESSAGE, not a description, so the obvious spelling
  // compares the description against ENOENT and fails for the wrong reason.
  assert.ok(!existsSync(join(ROOT, "src/lib/library-insert.ts")),
    "library-insert.ts must not exist — a second copy path would drift from the RPC");
});

test("both entry points copy through the SAME sql", () => {
  assert.match(ROUTE, /rpc\("create_packet_from_library"/);
  assert.match(EXISTING, /rpc\("library_copy_into_section"/);
  for (const [name, src] of [["create route", ROUTE], ["add-to-packet route", EXISTING]] as const) {
    assert.doesNotMatch(src, /applyItemContentUpdate\(/, `${name} must not write item content itself`);
    assert.doesNotMatch(src, /lineageForInsert\(/, `${name} must not compose lineage itself`);
    assert.doesNotMatch(src, /from\("items"\)\s*\.insert/, `${name} must not insert items itself`);
  }
});

test("a slug collision is retried, as the ordinary blank create retries it", () => {
  assert.match(ROUTE, /slug .\* is taken/);
  assert.match(ROUTE, /for \(let attempt = 0; attempt < 5; attempt\+\+\)/);
});

test("a missing or foreign entry is reported as unavailable, not as a partial success", () => {
  // The recognition moved into the shared failure classifier, so that a raw
  // database message could stop reaching the modal on either path. Assert the
  // OUTCOME rather than where the regex happens to live: both routes delegate,
  // and the classifier still answers this refusal the same way.
  for (const [name, src] of [["create", ROUTE], ["add-to-packet", EXISTING]] as const) {
    assert.match(src, /libraryCopyFailure\(/, `${name} must classify failures through the shared helper`);
  }
  const verdict = libraryCopyFailure(
    "library: 2 of 4 chosen entries are missing or not yours", "test",
    { error: "create_failed", message: "generic" });
  assert.equal(verdict.error, "entries_unavailable", "the all-or-nothing refusal is no longer recognised");
  assert.equal(verdict.status, 409);
  assert.match(verdict.message, /no longer available/i);
});

// ---------------------------------------------------------------------------
// Product shape
// ---------------------------------------------------------------------------
test("the new Sendset is a legacy-composition draft, and nothing publishes", () => {
  // The invariant moved into SQL with the transaction. 0023 does not RESTATE
  // these values — the ordinary blank create relies on the same column defaults —
  // it ASSERTS the row it produced, so a changed default fails loudly instead of
  // yielding a FlowGuide whose items cannot be written.
  const m = read("supabase/migrations/0023_create_packet_from_library.sql");
  assert.match(m, /v_status <> 'draft'/);
  assert.match(m, /v_mode <> 'legacy'/);
  assert.doesNotMatch(code("src/app/api/packets/from-library/route.ts"), /status: "published"|publish/i);
  assert.doesNotMatch(code("src/app/api/packets/from-library/route.ts"), /composition_mode/,
    "the route must not set composition mode behind the transaction's back");
});

test("creation lands the professional inside the new Sendset", () => {
  assert.match(WORKSPACE, /router\.push\(`\/edit\/\$\{packetId\}`\)/,
    "the composer must open the new Sendset, not return to a list");
});

test("ONE COMPOSER, reached from both doors", () => {
  // There were two implementations of this job: the Library's own workspace and
  // a modal picker behind "Use my Library" on the New FlowGuide menu. Which one
  // a professional got depended on which door they came through. The modal is
  // gone; the menu item now routes to the workspace.
  assert.match(WORKSPACE, /createFromLibrary\(/);
  assert.doesNotMatch(WORKSPACE, /fetch\("\/api\/packets\/from-library"/,
    "the request shape must live in one place");
  assert.match(DASHBOARD, /router\.push\("\/library\?compose=1"\)/,
    "Use my Library does not reach the canonical composer");
  assert.doesNotMatch(DASHBOARD, /UseLibraryPicker|createFromLibrary/,
    "the dashboard still creates Sendsets from the Library by itself");
});

test("the New Sendset menu offers the Library first", () => {
  const menu = DASHBOARD.slice(DASHBOARD.indexOf("showNewMenu &&"));
  const lib = menu.indexOf("Use my Library");
  const ai = menu.indexOf("Paste &amp; organize with AI");
  const blank = menu.indexOf("Start blank");
  assert.ok(lib > 0 && lib < ai && ai < blank,
    "Use my Library / Paste & organize with AI / Start blank, in that order");
});

// ---------------------------------------------------------------------------
// Readability in the new surfaces
// ---------------------------------------------------------------------------
test("the composition panel meets the text-sm floor for decision text", () => {
  const panel = WORKSPACE.slice(WORKSPACE.indexOf("{selecting && !organizing && ("),
                                WORKSPACE.indexOf("Cancel") + 40);
  assert.doesNotMatch(panel, /text-xs/, "the composition panel must not use text-xs");
});

test("the OTHER New Sendset choices are untouched", () => {
  // Converging the Library door must not disturb the two beside it.
  const menu = DASHBOARD.slice(DASHBOARD.indexOf("showNewMenu &&"));
  assert.match(menu, /router\.push\("\/new"\)/, "Paste & organize with AI no longer goes to /new");
  assert.match(menu, /createPacket\(\)/, "Start blank no longer creates a blank packet");
  // And the Library door is the only one that changed.
  assert.match(menu, /router\.push\("\/library\?compose=1"\)/);
});

test("THE SECOND COMPOSER IS GONE, not merely unused", () => {
  // A dead 200-line duplicate of this job is an invitation to drift back into
  // two experiences. Nothing in the app imports it because it no longer exists.
  assert.ok(!existsSync(join(ROOT, "src/components/library/use-library-picker.tsx")),
    "the modal Create-from-Library picker is still in the tree");
  // The remaining picker is a different job: inserting into an EXISTING packet.
  assert.ok(existsSync(join(ROOT, "src/components/library/library-picker.tsx")),
    "the insert-into-existing-packet picker was removed by mistake");
});
