import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeLabels, vocabularyOf, cursorFrom, cursorFilter, librarySearchQuery,
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
test("whitespace is tidied, inside as well as outside", () => {
  assert.deepEqual(normalizeLabels(["  Memory   Care  "]), ["Memory Care"]);
  assert.deepEqual(normalizeLabels(["   "]), [], "whitespace alone is not a label");
  assert.deepEqual(normalizeLabels(undefined), []);
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
    { labels: ["Santa Rosa", "Memory Care"] },
    { labels: ["santa rosa", "Moving"] },
    { labels: [] },
    { labels: null },
  ]);
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
  for (const leak of ["labels", "isFavorite", "sectionId", "groupId", "sortOrder"]) {
    assert.ok(!body.includes(leak), `snapshotToItem carries ${leak} into packet content`);
  }
});

test("filters and search reset paging rather than reusing a stale cursor", () => {
  const list = bodyOf("src/components/library/library-list.tsx");
  // The first-page loader always passes null, so a cursor from the previous
  // result set can never be applied to a new one.
  assert.match(list, /params\(query, null\)/, "the first page is fetched with a carried-over cursor");
  assert.match(list, /useCallback\([\s\S]{0,900}?labelList, favorite\]/,
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
const NONE = { labels: [], hasFavorites: false };
const OFF = { labels: [] as string[], favorite: false };

test("an unorganized Library shows NO filter chrome", () => {
  assert.equal(shouldShowFilters(NONE, OFF), false,
    "an empty row of controls is offered to someone who has organized nothing");
});

test("ONE FAVORITE is enough, with zero categories and zero labels", () => {
  assert.equal(shouldShowFilters({ ...NONE, hasFavorites: true }, OFF), true,
    "starring an item does not reveal the Favorites filter");
});

test("a label alone also reveals it", () => {
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
  assert.equal(vocabularyOf([{ labels: [] }]).hasFavorites, false);
  assert.equal(vocabularyOf([{ labels: [], is_favorite: true }]).hasFavorites, true,
    "the database row shape is not recognised");
  assert.equal(vocabularyOf([{ labels: [], isFavorite: true }]).hasFavorites, true,
    "the mapped item shape is not recognised");
  // ...and it is a fact about the material, never about the filter.
  const v = vocabularyOf([{ labels: ["Moving"], is_favorite: false }]);
  assert.deepEqual(v, { labels: ["Moving"], hasFavorites: false });
});

test("starring the FIRST item reveals the filter without waiting for a reload", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const fn = ws.slice(ws.indexOf("async function toggleFavorite"));
  assert.match(fn.slice(0, fn.indexOf("\n  }")), /setVocab\(\(v\) => \(v\.hasFavorites \? v : \{ \.\.\.v, hasFavorites: true \}\)\)/,
    "the affordance waits for the next page load, long after it was earned");
});

test("the vocabulary query actually reads is_favorite", () => {
  const service = bodyOf("src/lib/library-service.ts");
  assert.match(service, /select\("labels, is_favorite"\)/,
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
test("the Library offers an explicit SELECT & ORGANIZE entry point, beside Create", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const header = ws.slice(ws.indexOf("Import with AI"), ws.indexOf("{notice &&"));
  assert.match(header, />\s*Create a FlowGuide\s*</, "the create entry point is gone");
  // RENAMED, because the Library itself became draggable. "Organize" led to
  // the one mode where the drag handles are hidden, so it read as "to organize
  // your Library, do not press Organize". The mode is unchanged; its name was.
  assert.match(header, />\s*Select &amp; Organize\s*</,
    "multi-selection is only reachable through a button named after something else");
  // "Organize" alone was false once the Library became draggable; "Select
  // items" was true but left "for what?" hanging. Neither may come back.
  assert.ok(!/>\s*Organize\s*</.test(header),
    "the old label is still on a button, beside the Library that now drags");
  assert.ok(!/>\s*Select items\s*</.test(header),
    "the button still says what to do without saying what it is for");
  assert.match(header, /setOrganizing\(true\); setSelecting\(true\)/,
    "Select & Organize does not open the bulk-action intent");
  assert.match(header, /setOrganizing\(false\); setSelecting\(true\)/, "Create no longer opens with the create intent");
  assert.match(ws, /hasAny === true && \(/, "the entry points are offered over an empty Library");
});

// ---------------------------------------------------------------------------
// ARRIVING THROUGH SELECT & ORGANIZE MUST BE A SELECTION EXPERIENCE.
//
// Selection state is shared underneath, and that is an implementation detail.
// Showing a dimmed "Create FlowGuide" and a disabled "Select & Organize" beside
// it — after clicking Select & Organize — is the machinery leaking into the
// room: it says
// nothing about what to do next and quite a lot about how the code is arranged.
// ---------------------------------------------------------------------------
const organizePanel = () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  return ws.slice(ws.indexOf("{selecting && organizing && ("), ws.indexOf("{selecting && !organizing && ("));
};
const createPanel = () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  return ws.slice(ws.indexOf("{selecting && !organizing && ("), ws.indexOf("{importing && ("));
};

test("SELECT & ORGANIZE MODE shows no Create action, and no second entry button", () => {
  const panel = organizePanel();
  assert.ok(!/Create FlowGuide/.test(panel),
    "a dimmed Create FlowGuide is still offered inside the organizing experience");
  assert.ok(!/setOrganizing\(\(o\) => !o\)/.test(panel),
    "the disabled toggle is still there, beneath the button that opened it");
  assert.match(panel, /Select &amp; Organize/, "the mode does not name itself");
  // The three things this mode can actually do, named — so "select for what?"
  // is answered on the panel rather than left to be discovered.
  assert.match(panel.replace(/\s+/g, " "),
    /Choose one or more Library items to move, label, or favorite together/,
    "the panel does not say what selecting is for");
  // The boundary that was always in this sentence has to survive the rewrite.
  // Compared with whitespace collapsed, because JSX wraps prose and a reflow is
  // not a change of meaning.
  assert.match(panel.replace(/\s+/g, " "),
    /These changes only affect your Library — nothing is copied into a FlowGuide or seen by a client/,
    "the panel stopped saying that filing never reaches a client");
});

test("ZERO SELECTED says so, and offers nothing that cannot work", () => {
  const panel = organizePanel();
  assert.match(panel, /\{chosen\.length\} item\{chosen\.length === 1 \? "" : "s"\} selected/,
    "the count is not stated");
  assert.match(panel, /\{chosen\.length === 0 \? \(/,
    "the zero state is not distinguished from the working state");
  assert.match(panel, /Tick anything below to begin/, "nothing tells the professional selection comes first");
  // The inputs used to be editable while every action was disabled: type a
  // name, press the button, watch nothing happen.
  const zero = panel.slice(panel.indexOf("{chosen.length === 0 ? ("), panel.indexOf(") : ("));
  assert.ok(!/<input/.test(zero), "an input the professional can type into leads to no action");
  assert.ok(!/SmallAction/.test(zero), "an action button is offered with nothing to act on");
});

test("SELECTING activates the controls — they exist only in the working state", () => {
  const panel = organizePanel();
  const working = panel.slice(panel.indexOf(") : ("));
  // Placement replaced the free-text box: where something lives is chosen from
  // real sections, or named inline, never typed into a field that means nothing
  // until something matches it.
  for (const control of ["library-labels", "Put them here", "Take out of its section",
                         "Add", "Remove", "Favorite"]) {
    assert.ok(working.includes(control), `the working state is missing ${control}`);
  }
});

test("CATEGORY AND LABELS are explained in human, horizontal terms", () => {
  const panel = organizePanel();
  assert.match(panel, /Where should these live\?/, "placement is not explained");
  assert.match(panel, /Other ways you would want to find it later/, "Labels are not explained");
  // Wrapping is incidental; the words are what matter.
  const flat = panel.replace(/\s+/g, " ");
  assert.match(flat, /for example Places, Services, People or Documents\./,
    "the Section examples are missing or not generic");
  assert.match(flat, /a specialty, a status such as Preferred/,
    "the Label examples are missing or not generic");
  // A group is explained as a second level, in words that belong to no trade.
  assert.match(flat, /You can add a group inside it, like a town or a specialty\./,
    "groups are not explained, or the example is not generic");
  // The examples must belong to no profession. A vertical vocabulary here would
  // tell every other profession this software is not for them.
  for (const vertical of ["Memory Care", "Assisted Living", "senior", "Senior", "care level", "community type"]) {
    assert.ok(!panel.includes(vertical), `the explanatory copy hard-codes a vertical: ${vertical}`);
  }
});

test("THE RESULT IS VISIBLE — a row shows what it now carries", () => {
  const row = bodyOf("src/components/library/library-row.tsx");
  assert.match(row, /\(location \|\| \(item\.labels \?\? \[\]\)\.length > 0\) && \(/,
    "a row never shows its labels or where it lives, so organizing changes nothing anyone can see");
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  assert.match(ws, /setNotice\(`Organized \$\{data\.updated\} item/, "there is no acknowledgement");
  assert.match(ws, /if \(data\.vocabulary\) setVocab\(data\.vocabulary\)/,
    "the filter choices do not update after organizing");
  assert.match(ws, /setRefreshKey\(\(k\) => k \+ 1\)/, "the list is not refreshed after organizing");
});

test("THE CREATE PATH keeps its own intent, and its own words", () => {
  const panel = createPanel();
  assert.match(panel, /Start a FlowGuide/, "the create experience does not name itself");
  assert.ok(!/Choose one or more Library items|library-categories|library-labels/.test(panel),
    "organizing controls leaked into the create experience");
  assert.match(panel, /createFromLibrary\(chosen\)/, "creating from the selection is gone");
  assert.match(panel, /disabled=\{busy \|\| chosen\.length === 0\}/,
    "Create can fire with nothing selected");
});

test("LEAVING either experience drops the selection and writes nothing", () => {
  for (const [label, panel] of [["Done", organizePanel()], ["Cancel", createPanel()]] as const) {
    assert.match(panel, /setSelecting\(false\)/, "there is no way out");
    assert.match(panel, /setChosen\(\[\]\)/, "leaving keeps a stale selection");
    const exit = panel.slice(panel.lastIndexOf(label) - 700, panel.lastIndexOf(label));
    assert.ok(!/fetch\(/.test(exit), `${label} performs a write`);
  }
});

test("ORGANIZE says DONE, because its writes have already happened", () => {
  // Placing, labelling and starring all save immediately. "Cancel" would offer
  // to undo something this button cannot undo, and would make a professional
  // hesitate before leaving work they had already finished.
  const panel = organizePanel();
  assert.match(panel, />\s*Done\s*</, "the organize panel does not offer Done");
  assert.ok(!/>\s*Cancel\s*</.test(panel), "the organize panel still says Cancel");
});

test("CREATE keeps Cancel, because it genuinely stages a choice", () => {
  // Nothing is written until Create FlowGuide, so there IS something to abandon.
  const panel = createPanel();
  assert.match(panel, />\s*Cancel\s*</, "the create panel lost its Cancel");
  assert.ok(!/>\s*Done\s*</.test(panel), "the create panel says Done, but nothing is saved yet");
  assert.match(panel, /createFromLibrary\(chosen\)/, "the create panel does not defer its write");
});

test("a successful organize LEAVES THE PANEL OPEN to keep working", () => {
  const ws = bodyOf("src/components/library/library-workspace.tsx");
  const fn = ws.slice(ws.indexOf("async function organize"), ws.indexOf("async function toggleFavorite"));
  assert.ok(!/setSelecting\(false\)|setOrganizing\(false\)|setChosen\(\[\]\)/.test(fn),
    "a successful action closes the panel or drops the selection, so filing several things in a row is impossible");
  assert.match(fn, /setRefreshKey/, "the list is not refreshed, so the result is invisible");
});

test("a row is selectable by its card, not only by the checkbox", () => {
  const row = bodyOf("src/components/library/library-row.tsx");
  assert.match(row, /<label className=\{`\$\{shell\} cursor-pointer`\}>/,
    "the row card is not a label, so tapping it does not select");
  assert.match(row, /selected \? "border-accent bg-accent\/5"/, "a selected row is not visibly selected");
});

// ---------------------------------------------------------------------------
// TYPING IS A PREFIX QUESTION
//
// `MuirWoods` never appeared while typing `Muir`. It arrived at exactly
// `MuirWood`, which looked like fuzziness warming up and was the opposite:
// `search_tsv` is a tsvector, full-text search compares whole LEXEMES, and
// `MuirWoods` indexes as the single lexeme `muirwood` — the English stemmer
// drops the trailing s. So `muir` was simply a different word until enough had
// been typed to stem to the same one.
//
// The terms are prefix terms now. What these assert is the QUERY, because that
// is where the logic lives; that `muir:*` matches the lexeme `muirwood` is
// Postgres's own behaviour, verified against the real generated column in a
// disposable Postgres rather than restated here.
// ---------------------------------------------------------------------------

test("MUIR FINDS MUIRWOODS — terms become prefix terms", () => {
  assert.equal(librarySearchQuery("Muir"), "muir:*");
  assert.equal(librarySearchQuery("MuirW"), "muirw:*");
  // Typing the whole name still works: Postgres stems the query term too, so
  // `muirwoods:*` becomes `muirwood:*` and matches.
  assert.equal(librarySearchQuery("MuirWoods"), "muirwoods:*");
  assert.equal(librarySearchQuery("muirwoods"), "muirwoods:*");
});

test("SEVERAL WORDS ALL NARROW, and each is a prefix", () => {
  assert.equal(librarySearchQuery("memory care"), "memory:* & care:*");
  assert.equal(librarySearchQuery("  Muir   Woods  "), "muir:* & woods:*");
});

test("A ONE-CHARACTER TERM STAYS EXACT, so a short query is not noise", () => {
  // `m:*` would match a large share of any Library and say nothing.
  assert.equal(librarySearchQuery("m"), "m");
  assert.equal(librarySearchQuery("Mu"), "mu:*", "matching should be useful from two characters");
  // Mixed lengths keep the rule per term.
  assert.equal(librarySearchQuery("a muir"), "a & muir:*");
});

test("SAFE BY CONSTRUCTION — every tsquery operator is a separator", () => {
  // This is what `websearch` was buying and what a hand-built tsquery would
  // otherwise lose. None of these may reach Postgres as syntax.
  for (const hostile of ["a & b", "a | b", "!a", "(a)", "a:*", "'a'", "a <-> b", "\\", '"a"']) {
    const out = librarySearchQuery(hostile);
    assert.ok(!/[&|!()<>'"\\]/.test(out.replace(/ & /g, " ").replace(/:\*/g, "")),
      `an operator survived: ${JSON.stringify(hostile)} -> ${JSON.stringify(out)}`);
  }
  // A query of pure punctuation searches for nothing rather than erroring.
  for (const empty of ["", "   ", "!!!", "&|()", "***"])
    assert.equal(librarySearchQuery(empty), "", JSON.stringify(empty));
});

test("LETTERS ARE KEPT BY CLASS, so a non-Latin name is not erased", () => {
  // Stripping to /[a-z0-9]/ would turn these into nothing or into fragments.
  assert.equal(librarySearchQuery("Café"), "café:*");
  assert.equal(librarySearchQuery("Björk Lodge"), "björk:* & lodge:*");
  assert.equal(librarySearchQuery("大阪"), "大阪:*");
  assert.equal(librarySearchQuery("Suite 12B"), "suite:* & 12b:*");
});

test("the service asks Postgres the prefix question, on both surfaces", () => {
  const svc = readFileSync(new URL("./library-service.ts", import.meta.url), "utf8");
  assert.match(svc, /librarySearchQuery\(String\(query\.q \?\? ""\)\)/,
    "the search term no longer goes through the prefix builder");
  assert.match(svc, /textSearch\("search_tsv", tsq, \{ config: "english" \}\)/,
    "the query is not run against the english config the column was built with");
  assert.ok(!/type: "websearch"/.test(svc),
    "websearch matching is still in place, which is what could not see a prefix");
  // ONE search path. The Library list and the composition surface both reach
  // Postgres through searchLibrary, so neither can drift from the other.
  assert.equal((svc.match(/textSearch\(/g) ?? []).length, 1,
    "there is more than one place that searches, and they can disagree");
});
