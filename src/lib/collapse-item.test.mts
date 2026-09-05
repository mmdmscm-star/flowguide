// KEEP_TOGETHER ACROSS CHUNKS.
//
// The creator says "this source is one thing". The model is told so per chunk,
// because a chunk is the only place a model is called — but a 26-row pricing
// sheet is 1,077 characters and still becomes FIVE chunks on the segmenter's
// six-item budget, and finalize_ingestion_run inserts every item of every
// chunk. Five obedient chunks would have become five items called "Spring Lake
// Village". These tests hold the fold that stops that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseToOneItem } from "./collapse-item.ts";
import { collapseRunToOneItem, type ChunkRow, type CollapseDb } from "./collapse-run.ts";
import { buildRunChunks } from "./ingestion.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

// ---------------------------------------------------------------------------
// A FAKE RUN, so the fold can be exercised without a database.
// ---------------------------------------------------------------------------
function fakeDb(rows: ChunkRow[]) {
  const writes: { ordinal: number; result: unknown }[] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: rows, error: null }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: () => ({
          eq: async (_c: string, ordinal: unknown) => {
            writes.push({ ordinal: Number(ordinal), result: values.result });
            const row = rows.find((r) => r.ordinal === Number(ordinal));
            if (row) row.result = values.result;      // so a second fold sees the first
            return { error: null };
          },
        }),
      }),
    }),
  } as unknown as CollapseDb;
  return { db, writes, rows };
}
const KEEP = { intent: "keep_together" as const, title: "Spring Lake Village" };
const chunk = (ordinal: number, items: unknown[], status = "completed"): ChunkRow => ({
  ordinal, status, source_start: ordinal * 100,
  result: { sections: [{ title: "Month-to-Month Apartment Options", items }] },
});

// ---------------------------------------------------------------------------
// THE REAL CASE
// ---------------------------------------------------------------------------

test("THE 26-ROW SHEET: five internal chunks, one final item", async () => {
  const ROWS = Array.from({ length: 26 }, (_, i) =>
    `Unit ${i + 1}\t${i % 3 === 0 ? "Studio" : "1 Bedroom, 1 Bathroom"}\t${480 + i * 10} sq ft\t$${6000 + i * 90}`);
  const SOURCE = ROWS.join("\n");

  // The chunking is real, not assumed: this is what the pipeline actually does.
  const plan = buildRunChunks(SOURCE);
  assert.equal(plan.length, 5, "the fixture no longer produces five chunks; re-check the budget");

  // Five obedient chunks, each returning the one item it was told to.
  const perChunk = [0, 1, 2, 3, 4].map((c) =>
    chunk(c, [{
      title: "Spring Lake Village",
      details: ROWS.slice(c * 6, c * 6 + 6).map((r) => {
        const [n, t, s, f] = r.split("\t");
        return { label: `${n} — ${t}`, value: `${s}, ${f}` };
      }),
    }]));

  const { db, rows } = fakeDb(perChunk);
  const out = await collapseRunToOneItem(db, "run-1", KEEP);
  assert.equal(out.kind, "collapsed");

  const head = (rows[0].result as { sections: { items: Record<string, unknown>[] }[] });
  const items = head.sections[0].items;
  assert.equal(items.length, 1, "more than one item survived the fold");
  assert.equal(items[0].title, "Spring Lake Village", "the creator's title is not the item's title");

  // Every fact from every chunk.
  const details = items[0].details as { label: string; value: string }[];
  assert.equal(details.length, 26, `expected all 26 rows, got ${details.length}`);
  const json = JSON.stringify(items);
  for (const r of ROWS) {
    const [n, , , f] = r.split("\t");
    assert.ok(json.includes(n), `${n} was lost`);
    assert.ok(json.includes(f), `the price ${f} was lost`);
  }

  // And the other four chunks contribute nothing further — no duplicate item.
  for (const r of rows.slice(1))
    assert.deepEqual((r.result as { sections: unknown[] }).sections, [],
      `chunk ${r.ordinal} would still insert items of its own`);
  const all = rows.flatMap((r) => (r.result as { sections?: { items?: unknown[] }[] }).sections ?? [])
    .flatMap((s) => s.items ?? []);
  assert.equal(all.length, 1, "the run would still apply more than one item");
});

// ---------------------------------------------------------------------------
// THE FOLD ITSELF
// ---------------------------------------------------------------------------

test("A CHUNK THAT DISOBEYS THE PROMPT is folded in, not rejected", () => {
  const c = collapseToOneItem([
    { title: "Little River", details: [{ label: "Fee", value: "$6,396" }] },
    { title: "Timber Cove", details: [{ label: "Fee", value: "$6,493" }] },
    { title: "Forestville", details: [{ label: "Fee", value: "$6,545" }] },
  ], "Spring Lake Village");
  assert.equal(c.title, "Spring Lake Village");
  assert.equal(c.details.length, 3, "a disobedient chunk's extra items lost their facts");
  for (const p of ["$6,396", "$6,493", "$6,545"])
    assert.ok(JSON.stringify(c).includes(p), `${p} was lost`);
});

test("CONFLICTING SCALARS ARE KEPT, VERBATIM, under a mechanical label", () => {
  const c = collapseToOneItem([
    { address: "1 Alpha St", description: "A studio", highlight: "Ask about the view" },
    { address: "2 Beta Ave", description: "A one bedroom", highlight: "Ask about parking" },
    { address: "1 Alpha St" },   // the same value twice is one fact
  ], "Spring Lake Village");

  assert.equal(c.address, "1 Alpha St", "the first value did not take the canonical field");
  assert.equal(c.description, "A studio");
  assert.equal(c.highlight, "Ask about the view");

  const labelled = (l: string) => c.details.filter((d) => d.label === l).map((d) => d.value);
  assert.deepEqual(labelled("Address"), ["2 Beta Ave"], "the second address was silently dropped");
  assert.deepEqual(labelled("Description"), ["A one bedroom"]);
  assert.deepEqual(labelled("Highlight"), ["Ask about parking"]);
  // Verbatim: nothing written about the value, only the field's own name.
  for (const d of c.details) assert.ok(!/also|alternate|conflict|instead/i.test(d.label + d.value),
    "the fold generated prose about a value instead of keeping it");
});

test("every supported field survives, and exact duplicates collapse", () => {
  const c = collapseToOneItem([
    { notes: "call them back", links: [{ url: "https://a.example", label: "Rates" }],
      photos: ["https://img.example/1.jpg"],
      contacts: [{ name: "Dana", phone: "(707) 555-0100" }],
      details: [{ label: "Fee", value: "$6,396" }] },
    { notes: "call them back",                                    // duplicate note
      links: [{ url: "https://a.example", label: "Rates" },       // duplicate link
              { url: "https://b.example" }],
      photos: ["https://img.example/1.jpg", "https://img.example/2.jpg"],
      contacts: [{ name: "Dana", phone: "(707) 555-0100" },       // duplicate contact
                 { name: "Sam", email: "sam@example.com" }],
      details: [{ label: "Fee", value: "$6,396" },                // duplicate detail
                { label: "Size", value: "490 sq ft" }] },
  ], "X");

  assert.equal(c.notes, "call them back", "a duplicate private note was repeated");
  assert.deepEqual(c.links.map((l) => l.url), ["https://a.example", "https://b.example"]);
  assert.deepEqual(c.photos, ["https://img.example/1.jpg", "https://img.example/2.jpg"]);
  assert.equal(c.contacts.length, 2, "a person was duplicated or lost");
  assert.deepEqual(c.details, [{ label: "Fee", value: "$6,396" }, { label: "Size", value: "490 sq ft" }]);
});

test("THE FOLD IS IDEMPOTENT — a finalize retry cannot double anything", async () => {
  const rows = [chunk(0, [{ title: "a", address: "1 Alpha St", details: [{ label: "Fee", value: "$1" }] }]),
                chunk(1, [{ title: "b", address: "2 Beta Ave", details: [{ label: "Fee", value: "$2" }] }])];
  const { db, rows: state } = fakeDb(rows);
  await collapseRunToOneItem(db, "run-1", KEEP);
  const once = JSON.stringify(state.map((r) => r.result));
  await collapseRunToOneItem(db, "run-1", KEEP);
  assert.equal(JSON.stringify(state.map((r) => r.result)), once,
    "folding an already-folded run changed it");
});

// ---------------------------------------------------------------------------
// WHAT IT MUST NOT TOUCH
// ---------------------------------------------------------------------------

test("AUTO NEVER ENTERS — no chunk result is read or written", async () => {
  const { db, writes } = fakeDb([chunk(0, [{ title: "a" }]), chunk(1, [{ title: "b" }])]);
  for (const g of [null, undefined, { intent: "auto" as const, title: null },
                   { intent: "split" as const, title: null }]) {
    const out = await collapseRunToOneItem(db, "run-1", g);
    assert.equal(out.kind, "skipped", "a non-keep_together run entered the fold");
  }
  assert.equal(writes.length, 0, "the historical path rewrote chunk results");
});

test("A PARTIAL RUN IS NEVER MODIFIED", async () => {
  const { db, writes } = fakeDb([chunk(0, [{ title: "a" }]), chunk(1, [{ title: "b" }], "claimed")]);
  const out = await collapseRunToOneItem(db, "run-1", KEEP);
  assert.deepEqual(out, { kind: "skipped", reason: "run_incomplete" });
  assert.equal(writes.length, 0, "a run still being processed had its results rewritten");
});

test("split parents are ignored, as finalize ignores them", async () => {
  const rows = [chunk(0, [{ title: "parent" }], "split"),
                chunk(1, [{ title: "child", details: [{ label: "Fee", value: "$1" }] }])];
  const { db, rows: state } = fakeDb(rows);
  const out = await collapseRunToOneItem(db, "run-1", KEEP);
  assert.equal(out.kind, "collapsed");
  assert.equal((out as { chunksFolded: number }).chunksFolded, 1, "a split parent was folded in");
  assert.deepEqual((state[0].result as { sections: { title: string }[] }).sections[0].title,
    "Month-to-Month Apartment Options", "the split parent's own result was rewritten");
});

test("the collapse runs BEFORE finalize, and a failure stops it", () => {
  const route = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  const fold = route.indexOf("collapseRunToOneItem");
  const rpc = route.indexOf('rpc("finalize_ingestion_run"');
  assert.ok(fold > -1 && rpc > -1, "the route no longer folds or no longer finalizes");
  assert.ok(fold < rpc, "the run is finalized before its proposals are folded");
  assert.match(route.slice(fold, rpc), /collapse_failed/, "a failed fold still finalizes");
  assert.match(route.slice(fold, rpc), /status: 500/, "a failed fold is not an error");
  // It reads the PERSISTED intent, so resume and retry behave the same.
  assert.match(route, /grouping_intent, grouping_title/, "the intent is not read from the run");
});

test("NO GUARD LEARNED ABOUT COLLAPSING", () => {
  for (const f of ["src/lib/price-provenance.ts", "src/lib/library-price-gate.ts",
                   "src/lib/source-completeness.ts", "src/lib/reconcile.ts",
                   "src/lib/review-units.ts", "src/lib/enforce.ts",
                   "src/lib/enforce-chunk.ts", "src/lib/attribution.ts"])
    assert.ok(!/collapse|collapseToOneItem|collapseRun/.test(codeOf(f)),
      `${f} branches on the fold — a guard now behaves differently for keep_together`);
  // And the fold itself reaches no guard, no model and no inference.
  const prim = codeOf("src/lib/collapse-item.ts");
  assert.ok(!/fetch\(|openrouter|title ===|includes\(title/.test(prim),
    "the fold calls out, or matches on titles");
});
