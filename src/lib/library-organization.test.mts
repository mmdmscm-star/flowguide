import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeCategory, normalizeLabels, vocabularyOf, cursorFrom, cursorFilter,
} from "./library-organization.ts";
import { shouldShowFilters } from "../components/library/library-filters.tsx";

// Comments stripped INCLUDING trailing ones. A rule must be asserted against
// the code, never against the prose explaining it: the organization write
// carries the comment "no revision, no updated_at, on purpose", and a scan that
// left it in would match its own rationale and pass forever.
// `://` is spared so a URL survives.
const bodyOf = (p: string) => readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
// VOCABULARY: converge by reusing what the professional already said, without
// anything to administer.
// ---------------------------------------------------------------------------
test("a category adopts the spelling already in use", () => {
  assert.equal(normalizeCategory("santa rosa", ["Santa Rosa"]), "Santa Rosa");
  assert.equal(normalizeCategory("  COMMUNITIES  ", ["Communities"]), "Communities");
});

test("a genuinely new category is kept as typed", () => {
  assert.equal(normalizeCategory("Organizations", ["Communities", "Services"]), "Organizations");
});

test("whitespace is tidied, inside as well as outside", () => {
  assert.equal(normalizeCategory("  Memory   Care  "), "Memory Care");
  assert.equal(normalizeCategory("   "), "", "whitespace alone is not a category");
  assert.equal(normalizeCategory(undefined), "");
});

test("LABELS are trimmed, blanks dropped, and de-duplicated within an item", () => {
  assert.deepEqual(normalizeLabels(["  Moving ", "moving", "", "   ", "Real Estate"]),
    ["Moving", "Real Estate"]);
});

test("labels adopt existing spelling, so one idea is one chip", () => {
  assert.deepEqual(normalizeLabels(["santa rosa", "MEMORY CARE"], ["Santa Rosa", "Memory Care"]),
    ["Santa Rosa", "Memory Care"]);
});

test("label ORDER is preserved as typed", () => {
  assert.deepEqual(normalizeLabels(["Zebra", "Alpha", "Mid"]), ["Zebra", "Alpha", "Mid"],
    "input was reordered for no reason");
});

test("a non-array is not a crash", () => {
  assert.deepEqual(normalizeLabels(undefined), []);
  assert.deepEqual(normalizeLabels("Moving"), [], "a bare string is not one label");
});

test("the vocabulary is DERIVED from the material, folded and sorted", () => {
  const v = vocabularyOf([
    { category: "Communities", labels: ["Santa Rosa", "Memory Care"] },
    { category: "communities", labels: ["santa rosa", "Moving"] },
    { category: "", labels: [] },
    { category: "Services", labels: null },
  ]);
  assert.deepEqual(v.categories, ["Communities", "Services"], "a case variant became a second category");
  assert.deepEqual(v.labels, ["Memory Care", "Moving", "Santa Rosa"]);
});

// ---------------------------------------------------------------------------
// THE CURSOR. The tiebreak is the whole point.
// ---------------------------------------------------------------------------
test("the cursor carries BOTH values", () => {
  const c = cursorFrom({ updated_at: "2026-08-28 20:27:25.364619+00", id: "abc" });
  assert.equal(c.updatedAt, "2026-08-28 20:27:25.364619+00");
  assert.equal(c.id, "abc");
});

test("the filter compares the PAIR, so a tie can neither skip nor repeat", () => {
  const f = cursorFilter({ updatedAt: "2026-08-28 20:27:25.364619+00", id: "abc" });
  assert.match(f, /updated_at\.lt\./, "there is no strictly-older branch");
  assert.match(f, /and\(updated_at\.eq\..*,id\.lt\./,
    "there is no tie branch: rows sharing updated_at would be skipped or repeated");
});

test("the cursor's timestamp keeps microsecond precision", () => {
  // A Date round-trip truncates to milliseconds, and the page boundary then
  // repeats or drops whatever sits inside the truncated microsecond.
  const raw = "2026-08-28 20:27:25.364619+00";
  assert.ok(cursorFilter({ updatedAt: raw, id: "x" }).includes("364619"),
    "microseconds were lost on the way into the filter");
  const service = bodyOf("src/lib/library-service.ts");
  assert.ok(!/new Date\([^)]*updated_?[Aa]t/.test(service),
    "the service parses updated_at into a Date, which truncates the cursor");
  const route = bodyOf("src/app/api/library/route.ts");
  assert.ok(!/new Date\([^)]*cursor/i.test(route), "the route parses the cursor into a Date");
});

test("quoted values, because a timestamp carries + and :", () => {
  assert.match(cursorFilter({ updatedAt: "2026-08-28 20:27:25+00", id: "x" }), /updated_at\.lt\."/);
});

// ---------------------------------------------------------------------------
// THE CONTRACTS THAT MADE THIS SAFE TO DO
// ---------------------------------------------------------------------------
test("ORGANIZING DOES NOT BUMP revision OR updated_at", () => {
  const service = bodyOf("src/lib/library-service.ts");
  const fn = service.slice(service.indexOf("export async function setLibraryOrganization"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!/revision/.test(body),
    "the organization write touches revision — every descendant FlowGuide would report a false conflict");
  assert.ok(!/updated_at/.test(body),
    "the organization write touches updated_at — the Library list would reshuffle on organizing");
  assert.match(body, /is_favorite/, "the organization write does not set the star");
});

test("the page reports hasMore EXPLICITLY rather than inferring it from a short page", () => {
  const service = bodyOf("src/lib/library-service.ts");
  assert.match(service, /limit\(limit \+ 1\)/,
    "hasMore is guessed from the page size, which stops being true the moment a filter changes its shape");
  assert.match(service, /hasMore = rows\.length > limit/);
});

test("the ordering is the total one, in both columns and both directions", () => {
  const service = bodyOf("src/lib/library-service.ts");
  const order = service.slice(service.indexOf(".order(\"updated_at\""));
  assert.match(order.slice(0, 200), /\.order\("updated_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
    "id is not the tiebreak, so rows sharing updated_at have no defined order");
});

test("a Library snapshot does not carry organization into a FlowGuide item", () => {
  const adapter = bodyOf("src/lib/library-adapter.ts");
  const fn = adapter.slice(adapter.indexOf("export function snapshotToItem"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  for (const leak of ["category", "labels", "isFavorite"]) {
    assert.ok(!body.includes(leak), `snapshotToItem carries ${leak} into packet content`);
  }
});

test("filters and search reset paging rather than reusing a stale cursor", () => {
  const list = bodyOf("src/components/library/library-list.tsx");
  // The first-page loader always passes null, so a cursor from the previous
  // result set can never be applied to a new one.
  assert.match(list, /params\(query, null\)/, "the first page is fetched with a carried-over cursor");
  assert.match(list, /useCallback\([\s\S]{0,900}?category, labelList, favorite\]/,
    "the request params do not depend on the filters, so changing one would not refetch");
  // ...and they depend on the VALUE of the labels, not the array's identity.
  // `labels = []` is a fresh array every render, so depending on it rebuilt
  // params -> load -> the load effect -> setState -> render, forever. The
  // workspace passes state and never saw it; the picker passes nothing and
  // looped on open.
  assert.match(list, /const labelKey = labels\.join\(/,
    "the labels dependency is the array itself, which is a new identity each render");
  assert.match(list, /useMemo\(\(\) => \(labelKey \? labelKey\.split\([\s\S]{0,40}?\[labelKey\]\)/,
    "labelList is not derived from the stable key");
});

// ---------------------------------------------------------------------------
// FAVORITES MUST NOT DEPEND ON CATEGORY OR LABEL VOCABULARY.
//
// The first version gated the whole filter surface on categories or labels
// existing, with the filter's OWN state as the only other way in. So a Library
// with one starred item and nothing filed showed no Favorites chip — and the
// only way to reveal it was a filter you could not switch on, because the chip
// was not rendered. A closed loop, and exactly the kind that looks like
// "organization just doesn't work here".
// ---------------------------------------------------------------------------
const NONE = { categories: [], labels: [], hasFavorites: false };
const OFF = { category: "", labels: [] as string[], favorite: false };

test("an unorganized Library shows NO filter chrome", () => {
  assert.equal(shouldShowFilters(NONE, OFF), false,
    "an empty row of controls is offered to someone who has organized nothing");
});

test("ONE FAVORITE is enough, with zero categories and zero labels", () => {
  assert.equal(shouldShowFilters({ ...NONE, hasFavorites: true }, OFF), true,
    "starring an item does not reveal the Favorites filter");
});

test("a category or a label alone also reveals it", () => {
  assert.equal(shouldShowFilters({ ...NONE, categories: ["Communities"] }, OFF), true);
  assert.equal(shouldShowFilters({ ...NONE, labels: ["Santa Rosa"] }, OFF), true);
});

test("unstarring the last favorite cannot strand you inside the Favorites view", () => {
  // hasFavorites is false again, but the filter is ON — so the chip stays and
  // can be switched off.
  assert.equal(shouldShowFilters(NONE, { ...OFF, favorite: true }), true,
    "the only control that could leave the view disappeared with the last favorite");
});

test("...and once the view is left, the calm surface returns", () => {
  assert.equal(shouldShowFilters(NONE, OFF), false);
});

test("the vocabulary reports whether ANYTHING is starred, in either shape", () => {
  assert.equal(vocabularyOf([{ category: "", labels: [] }]).hasFavorites, false);
  assert.equal(vocabularyOf([{ category: "", labels: [], is_favorite: true }]).hasFavorites, true,
    "the database row shape is not recognised");
  assert.equal(vocabularyOf([{ category: "", labels: [], isFavorite: true }]).hasFavorites, true,
    "the mapped item shape is not recognised");
  // ...and it is a fact about the material, never about the filter.
  const v = vocabularyOf([{ category: "Communities", labels: ["Moving"], is_favorite: false }]);
  assert.deepEqual(v, { categories: ["Communities"], labels: ["Moving"], hasFavorites: false });
});

test("starring the FIRST item reveals the filter without waiting for a reload", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const fn = ws.slice(ws.indexOf("async function toggleFavorite"));
  assert.match(fn.slice(0, fn.indexOf("\n  }")), /setVocab\(\(v\) => \(v\.hasFavorites \? v : \{ \.\.\.v, hasFavorites: true \}\)\)/,
    "the affordance waits for the next page load, long after it was earned");
});

test("the vocabulary query actually reads is_favorite", () => {
  const service = bodyOf("src/lib/library-service.ts");
  assert.match(service, /select\("category, labels, is_favorite"\)/,
    "hasFavorites is computed from a query that never selected the column");
});

// ---------------------------------------------------------------------------
// ORGANIZATION NEEDS A DOOR WITH ITS OWN NAME ON IT.
//
// Selection has been neutral since Phase 2 — pick items, then decide what to do
// with them — but the only way IN was a button labelled "Create a FlowGuide".
// So a professional looking for how to organize their Library found Favorites,
// which is on every row, and reasonably concluded that was the whole release.
// ---------------------------------------------------------------------------
test("the Library offers an explicit Organize entry point, beside Create", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const header = ws.slice(ws.indexOf("Import with AI"), ws.indexOf("{selecting &&"));
  assert.match(header, />\s*Create a FlowGuide\s*</, "the create entry point is gone");
  assert.match(header, />\s*Organize\s*</,
    "organizing is still only reachable through a button named after the other destination");
  assert.match(header, /setOrganizing\(true\); setSelecting\(true\)/,
    "Organize does not open the organizing intent");
  assert.match(header, /setOrganizing\(false\); setSelecting\(true\)/,
    "Create no longer opens with the create intent");
  // ...and both are still gated on there being something to organize.
  assert.match(ws, /hasAny === true && \(/, "the entry points are offered over an empty Library");
});

test("ONE mode, two intents — not a second organizing system", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  // Both doors set the SAME selection state; only `organizing` differs.
  assert.equal((ws.match(/setSelecting\(true\)/g) ?? []).length, 2,
    "there is more than one way to enter selection, or none");
  assert.ok(!/organizeSelecting|selectingToOrganize|organizeMode/.test(ws),
    "a parallel selection state appeared");
});

test("the organizing panel appears with the MODE, not with the first selection", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  assert.ok(!/\{organizing && chosen\.length > 0 && \(/.test(ws),
    "clicking Organize shows only checkboxes until something is ticked — the controls it is named for stay hidden");
  assert.match(ws, /\{organizing && \(/, "the panel is not tied to the mode");
  assert.match(ws, /Tick the items below, then set a category, add a label, or star them\./,
    "nothing tells the professional what to do first");
  assert.match(ws, /Select the items you want to organize/,
    "the bar does not say what this mode is for");
});

test("every bulk control is disabled until something is selected", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const panel = ws.slice(ws.indexOf("{organizing && ("), ws.indexOf("</div>\n          )}"));
  const actions = panel.match(/<SmallAction disabled=\{[^}]*\}/g) ?? [];
  assert.equal(actions.length, 6, `expected six bulk actions, found ${actions.length}`);
  for (const a of actions) {
    assert.match(a, /!chosen\.length/, `a bulk action can fire with nothing selected: ${a}`);
  }
});

test("the row star survives the change — it never required the mode", () => {
  const list = bodyOf("src/components/library/library-list.tsx");
  assert.match(list, /onToggleFavorite/, "the row star is gone");
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  assert.match(ws, /onToggleFavorite=\{selecting \? undefined : toggleFavorite\}/,
    "the star's availability outside selection changed");
});
