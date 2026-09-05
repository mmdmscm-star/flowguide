// HOW MANY THINGS IS THIS SOURCE?
//
// A photographed pricing sheet — one community, many apartment rows — produced
// twenty-six review cards from one misunderstanding about scope. The model
// chose one item per row; the deterministic side tiled the same table into one
// record per row; every proposal then failed to bind, because a pricing table
// carries no email, URL or phone and anchorsOf recognises nothing else.
//
// These are the measurements that justified a schema change, kept as
// regressions so the numbers cannot quietly move.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { groupingOf, keepsTogether, groupingPromptRule } from "./grouping.ts";
import { organizeLeadPrompt, sectionsPrompt, itemsOnlyPrompt } from "./ai-prompts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const CHUNK_ROUTE = codeOf("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");
const ENFORCE = codeOf("src/lib/enforce-chunk.ts");

/** Spring Lake Village, in the shape the transcription prompt produces: one
 *  community, many rows, repeated vocabulary, prices and sizes, tab-separated. */
const ROWS = [
  "Little River\tStudio Apartment\t490 sq ft\t$6,396",
  "Timber Cove\tAlcove Apartment\t530 sq ft\t$6,493",
  "Forestville\t1 Bedroom, 1 Bathroom\t580 sq ft\t$6,545",
  "Fulton\t1 Bedroom, 1 Bathroom\t650 sq ft\t$7,077",
  "Guerneville\t1 Bedroom, 1 Bathroom\t700 sq ft\t$7,214",
  "Healdsburg\t2 Bedroom, 2 Bathroom\t900 sq ft\t$8,102",
];
const SOURCE = ROWS.join("\n");
const PRICES = ROWS.map((r) => r.split("\t")[3]);

const perRow = ROWS.map((r) => {
  const [name, type, size, fee] = r.split("\t");
  return { title: `${name} ${type}`, description: `${type}, ${size}`,
    details: [{ label: "Monthly Fee", value: fee }, { label: "Size", value: size }] };
});
const oneItem = (title: string) => [{
  title, description: "Month-to-Month Apartment Options",
  details: ROWS.map((r) => { const [n, t, s2, f] = r.split("\t");
    return { label: `${n} — ${t}`, value: `${s2}, ${f}` }; }),
}];

const run = (items: unknown[], grouping?: { intent: string; title: string | null } | null) => {
  const out = enforceChunkResult({
    segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
    result: { sections: [{ title: "Options", items }] },
    destination: "packet", delimiterHint: null,
    grouping: grouping as never,
  });
  const survived = (out.result as { sections?: { items?: Record<string, unknown>[] }[] })
    .sections?.[0]?.items ?? [];
  return {
    cards: out.unresolved.filter((u) => u.kind === "unbound-recipient-content").length,
    details: survived.reduce((n, i) => n + ((i.details as unknown[])?.length ?? 0), 0),
    items: survived, json: JSON.stringify(survived),
  };
};

// ---------------------------------------------------------------------------
// THE MEASUREMENTS
// ---------------------------------------------------------------------------

test("AUTO REPRODUCES THE FAN-OUT — one card per row, every detail withheld", () => {
  const a = run(perRow, null);
  assert.equal(a.cards, ROWS.length, "the fan-out this feature exists for stopped reproducing");
  assert.equal(a.details, 0, "details now survive under auto — the baseline moved");
});

test("KEEP TOGETHER produces one item and keeps every supported fact", () => {
  const k = run(oneItem("Spring Lake Village"),
    { intent: "keep_together", title: "Spring Lake Village" });
  assert.equal(k.cards, 0, "keeping it together still asks for a decision per row");
  assert.equal(k.items.length, 1, "more than one item survived");
  assert.equal(k.items[0].title, "Spring Lake Village", "the creator's title did not survive");
  assert.equal(k.details, ROWS.length, "a supported detail was dropped");
  for (const p of PRICES) assert.ok(k.json.includes(p), `the source price ${p} was lost`);
});

test("MISUSE: several apparent entities aggregate VISIBLY, and every price survives", () => {
  // keep_together on a source that plainly holds three communities. The failure
  // mode must be over-aggregation under a name the creator typed — not silent
  // loss, and not reassignment, because there is nowhere to reassign to.
  const MULTI = ["Spring Lake Village", "Little River\tStudio\t490 sq ft\t$6,396",
    "Oakmont Gardens", "Sunrise\t1 Bedroom\t600 sq ft\t$5,100",
    "Friends House", "Willow\t2 Bedroom\t880 sq ft\t$7,400"].join("\n");
  const item = [{ title: "Spring Lake Village", details: [
    { label: "Little River — Studio", value: "490 sq ft, $6,396" },
    { label: "Sunrise — 1 Bedroom", value: "600 sq ft, $5,100" },
    { label: "Willow — 2 Bedroom", value: "880 sq ft, $7,400" }] }];
  const out = enforceChunkResult({
    segmentText: MULTI, chunkOrdinal: 0, sourceStart: 0, sourceText: MULTI,
    result: { sections: [{ title: "Options", items: item }] },
    destination: "packet", delimiterHint: null,
    grouping: { intent: "keep_together", title: "Spring Lake Village" } as never,
  });
  const survived = (out.result as { sections?: { items?: Record<string, unknown>[] }[] })
    .sections?.[0]?.items ?? [];
  assert.equal(survived.length, 1, "there is more than one item, so a fact could be under the wrong one");
  assert.equal(survived[0].title, "Spring Lake Village", "the aggregation is not visibly named");
  assert.equal(out.telemetry.itemsGoverned, 1, "the declared record's proposal was not governed");
  for (const p of ["$6,396", "$5,100", "$7,400"])
    assert.ok(JSON.stringify(survived).includes(p), `${p} was lost`);

  // AND CANONICALIZATION TAKES NOTHING WITH IT. Governance renders the claim
  // "490 sq ft: $6,396" over the model's aggregated detail; the unit's name and
  // type are source-backed, so they are kept beside it rather than replaced
  // away. This was a real deletion until the residue rule landed.
  for (const w of ["Little River", "Studio", "Sunrise", "Willow",
                   "490 sq ft", "600 sq ft", "880 sq ft"])
    assert.ok(JSON.stringify(survived).includes(w), `${w} was deleted by canonicalization`);
});

// ---------------------------------------------------------------------------
// THE DEFAULT IS UNTOUCHED
// ---------------------------------------------------------------------------

test("AUTO'S PROMPT IS BYTE-IDENTICAL — the rule is appended, never woven in", () => {
  for (const g of [null, undefined, { intent: "auto", title: null },
                   { intent: "split", title: null }] as const)
    assert.equal(groupingPromptRule(g as never), "",
      "something other than keep_together changes the prompt");
  // And the base prompts themselves are untouched by this feature.
  for (const p of [organizeLeadPrompt("general"), sectionsPrompt("general"), itemsOnlyPrompt()])
    assert.ok(!/EXACTLY ONE item|GROUPING —/.test(p),
      "a grouping rule leaked into the base prompt, so auto is no longer the old behaviour");
});

test("KEEP TOGETHER's prompt requires exactly one item, with the creator's title", () => {
  const rule = groupingPromptRule({ intent: "keep_together", title: "Spring Lake Village" });
  assert.match(rule, /EXACTLY ONE item/, "the prompt does not require one item");
  assert.match(rule, /"Spring Lake Village"/, "the creator's title is not pinned");
  assert.match(rule, /Do not split it/, "the model may still split it");
  assert.match(rule, /omit nothing/i, "nothing forbids dropping facts that did not fit");
  // A title with no intent, or an intent with no title, changes nothing.
  assert.equal(groupingPromptRule({ intent: "keep_together", title: null }), "");
});

test("an unknown intent behaves like auto rather than failing a chunk", () => {
  assert.equal(groupingOf({ grouping_intent: "merge", grouping_title: "x" }).intent, "auto");
  assert.equal(groupingOf(null).intent, "auto");
  assert.equal(groupingOf({ grouping_intent: "keep_together", grouping_title: "  " }).title, null,
    "a blank title still counts as keeping together");
  assert.equal(keepsTogether(groupingOf({ grouping_intent: "keep_together", grouping_title: " " })), false);
});

// ---------------------------------------------------------------------------
// THE TRAP, AND THE GUARDS
// ---------------------------------------------------------------------------

test("SCENARIO B IS UNREACHABLE — one prompt, one enforcement, one value", () => {
  // The state that looks like a fix and is not: the model told to return one
  // item while the deterministic side still tiles the source into many. It
  // yields one card and still withholds every fact.
  const trap = run(oneItem("Spring Lake Village"), null);   // one item, auto
  assert.equal(trap.cards, 1);
  assert.equal(trap.details, 0, "the trap stopped being a trap; re-check the claim below");

  // It is unreachable because both sides read ONE persisted value, once.
  assert.equal((CHUNK_ROUTE.match(/const grouping = groupingOf\(/g) ?? []).length, 1,
    "the chunk route reads grouping more than once, so the two reads can disagree");
  const call = (fn: string) => CHUNK_ROUTE.slice(CHUNK_ROUTE.indexOf(fn), CHUNK_ROUTE.indexOf(fn) + 900);
  assert.match(call("processSegment({"), /\n\s*grouping,/, "the prompt is not given the grouping");
  assert.match(call("enforceChunkResult({"), /\n\s*grouping,/, "the enforcement is not given the grouping");
  // And both consult the same predicate rather than reimplementing it.
  assert.match(ENFORCE, /keepsTogether\(grouping\)/, "enforcement re-derives the decision");
});

test("KEEP TOGETHER TURNS OFF NOTHING ELSE", () => {
  // It changes the declared record count, and only that. No guard learns about
  // grouping, and the unbound rule is not suppressed globally.
  for (const f of ["src/lib/price-provenance.ts", "src/lib/library-price-gate.ts",
                   "src/lib/source-completeness.ts", "src/lib/reconcile.ts",
                   "src/lib/review-units.ts", "src/lib/claim-parser.ts",
                   "src/lib/enforce.ts", "src/lib/attribution.ts"])
    assert.ok(!/grouping|keepsTogether|keep_together/.test(codeOf(f)),
      `${f} branches on grouping — a guard now behaves differently by intent`);
  // bindByProvenance itself is untouched.
  assert.ok(!/grouping/.test(codeOf("src/lib/attribution.ts")), "bindByProvenance learned about grouping");
  // Exactly one place in enforcement consults it: the record count.
  assert.equal((ENFORCE.match(/keepsTogether\(/g) ?? []).length, 1,
    "grouping is consulted in more than one place inside enforcement");
});

test("the run is the source of truth, not the browser", () => {
  assert.match(CHUNK_ROUTE, /grouping_intent, grouping_title/,
    "the chunk route does not read the persisted grouping, so resume would lose it");
  const ORGANIZE = codeOf("src/app/api/ingest/organize/route.ts");
  // BOTH COLUMNS, IN ONE UPDATE. 0046's coherence CHECK refuses a row where the
  // intent and the title disagree, so writing either alone is a row Postgres
  // rejects — and writing them in two statements would be rejected in between.
  const block = ORGANIZE.slice(ORGANIZE.indexOf("const stamp"), ORGANIZE.indexOf(".update(stamp)"));
  assert.match(block, /stamp\.grouping_intent = groupingIntent/, "the intent is never persisted");
  assert.match(block, /stamp\.grouping_title =/, "the title is never persisted");
  assert.match(ORGANIZE, /\.update\(stamp\)/, "the two columns are not sent in one update");
  assert.ok(ORGANIZE.indexOf("stamp.grouping_intent") < ORGANIZE.indexOf(".update(stamp)"),
    "the intent is set after the update");
  assert.match(ORGANIZE, /grouping_title_required/, "a keep_together run can be created unnamed");
  // The creator's title must never be overwritten by the model-derived one.
  assert.ok(!/derived_title/.test(codeOf("src/lib/grouping.ts")),
    "the creator's title is entangled with the model-derived packet title");
});
