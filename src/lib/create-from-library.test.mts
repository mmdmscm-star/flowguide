// Wiring invariants for "create a FlowGuide from saved material".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped. Three times now a whole-file scan has matched
 *  the prose that EXPLAINS an invariant instead of the code that keeps it. */
const code = (p: string) => read(p)
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");
const ROUTE = read("src/app/api/packets/from-library/route.ts");
const INSERT = read("src/lib/library-insert.ts");
const EXISTING = read("src/app/api/packets/[id]/items/from-library/route.ts");
const PICKER = read("src/components/library/use-library-picker.tsx");
const WORKSPACE = read("src/components/library/library-workspace.tsx");
const DASHBOARD = read("src/app/dashboard/page.tsx");

// ---------------------------------------------------------------------------
// A failure must not leave an orphan draft
// ---------------------------------------------------------------------------
test("every failure path after the packet insert removes the draft", () => {
  // Everything AFTER abandon() is defined — abandon's own return is the one
  // bare NextResponse.json that is allowed to exist in this region, so the scan
  // starts past it rather than counting it as a violation.
  const body = ROUTE.slice(ROUTE.indexOf("const { data: section,"));
  const returns = [...body.matchAll(/return (NextResponse\.json|abandon)\(/g)].map((m) => m[1]);
  assert.ok(returns.length >= 4, `expected several exits, saw ${returns.length}`);
  const bare = returns.filter((r) => r === "NextResponse.json");
  assert.equal(bare.length, 1,
    `exactly one bare return is allowed here — the SUCCESS one; every failure must abandon(). Saw ${bare.length}`);
  assert.ok(returns.filter((r) => r === "abandon").length >= 3,
    "each failure after creation must undo it");
});

test("abandon actually deletes the packet", () => {
  const fn = ROUTE.slice(ROUTE.indexOf("async function abandon"), ROUTE.indexOf("const { data: section,"));
  assert.match(fn, /from\("packets"\)\s*\.delete\(\)\s*\.eq\("id", packetId\)/);
});

test("a section that fails to create takes the packet with it", () => {
  assert.match(ROUTE, /if \(sectionErr \|\| !section\) \{\s*\n\s*return abandon\(/);
});

test("finding none of the chosen entries is a failure, not an empty FlowGuide", () => {
  assert.match(ROUTE, /itemIds\.length === 0[\s\S]{0,120}abandon\(/,
    "an empty draft is exactly the orphan this route exists to avoid");
});

// ---------------------------------------------------------------------------
// One insert implementation
// ---------------------------------------------------------------------------
test("both entry points share one insert implementation", () => {
  assert.match(ROUTE, /insertLibraryEntries\(/);
  assert.match(EXISTING, /insertLibraryEntries\(/);
  for (const [name, src] of [["create route", ROUTE], ["add-to-packet route", EXISTING]] as const) {
    assert.doesNotMatch(src, /applyItemContentUpdate\(/,
      `${name} must not write item content itself`);
    assert.doesNotMatch(src, /lineageForInsert\(/,
      `${name} must not compose lineage itself — 0017's CHECK makes a half state unrepresentable`);
  }
});

test("the shared insert normalises content rather than passing it through", () => {
  assert.match(INSERT, /normalizeItemContent\(/,
    "an entry stored with bare photo urls must not carry that shape into the packet's photo rows");
  assert.ok(INSERT.indexOf("normalizeItemContent(") < INSERT.indexOf("applyItemContentUpdate") ||
            /applyItemContentUpdate\([\s\S]{0,400}normalizeItemContent\(/.test(INSERT));
});

test("the insert writes lineage but never fabricates ingestion provenance", () => {
  assert.match(INSERT, /lineageForInsert\(source\.id, source\.revision\)/);
  assert.doesNotMatch(INSERT, /origin_run_id|origin_chunk_ordinal|emit_index/,
    "a Library copy has no ingestion origin; inventing one would corrupt the 0016 gate");
});

// ---------------------------------------------------------------------------
// Product shape
// ---------------------------------------------------------------------------
test("the new FlowGuide is a legacy-composition draft, and nothing publishes", () => {
  assert.match(ROUTE, /composition_mode: "legacy"/,
    "the Library inserts into sections and items, which block mode freezes");
  assert.doesNotMatch(code("src/app/api/packets/from-library/route.ts"), /status: "published"|publish/i);
});

test("creation lands the professional inside the new FlowGuide", () => {
  for (const [name, src] of [["picker", PICKER], ["library workspace", WORKSPACE]] as const) {
    assert.match(src, /router\.push\(`\/edit\/\$\{packetId\}`\)/,
      `${name} must open the new FlowGuide, not return to a list`);
  }
});

test("both entry points call the one shared client helper", () => {
  assert.match(PICKER, /createFromLibrary\(/);
  assert.match(WORKSPACE, /createFromLibrary\(/);
  for (const src of [PICKER, WORKSPACE]) {
    assert.doesNotMatch(src, /fetch\("\/api\/packets\/from-library"/,
      "the request shape must live in one place");
  }
});

test("the New FlowGuide menu offers the Library first", () => {
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
test("the new UI already meets the text-sm floor for decision text", () => {
  for (const [name, src] of [["picker", PICKER]] as const) {
    assert.doesNotMatch(src, /text-xs/,
      `${name} is new work; text a professional reads to decide must be at least text-sm`);
  }
  const added = WORKSPACE.slice(WORKSPACE.indexOf("Choose what to start a FlowGuide with"),
                               WORKSPACE.indexOf("Cancel") + 40);
  assert.doesNotMatch(added, /text-xs/, "the new selection bar must not use text-xs");
});
