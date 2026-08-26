import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { communityKey, mergeProposals, planContinuationMerges } from "./library-continuation.ts";
import { auditPrices, priceKey, pricesIn } from "./price-provenance.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const P = (o: Partial<Record<string, unknown>> & { ordinal: number; idx: number }) =>
  ({ details: [], links: [], photos: [], contacts: [], ...o }) as never;

// ---------------------------------------------------------------------------
// ONE COMMUNITY, ONE PROPOSAL
// ---------------------------------------------------------------------------

test("communityKey folds the city qualifier and accents", () => {
  assert.equal(communityKey("Cogir of North Bay — Vallejo"), communityKey("Cogir of North Bay"));
  assert.equal(communityKey("Ensō Village"), communityKey("Enso Village"));
  assert.equal(communityKey("The Reserve at Fountaingrove"), communityKey("The Reserve at Fountaingrove"));
});

test("IT DOES NOT FOLD TWO DIFFERENT COMMUNITIES THAT SHARE A PREFIX", () => {
  // Both are in the real source. A prefix rule would merge them.
  assert.notEqual(communityKey("Ivy Park at Piner"), communityKey("Ivy Park at Santa Rosa"));
  assert.notEqual(communityKey("Cogir of Sonoma"), communityKey("Cogir on Sonoma Plaza"));
  assert.notEqual(communityKey("Brookdale Chanate"), communityKey("Brookdale Paulin Creek"));
  assert.notEqual(communityKey("Aegis Living Napa"), communityKey("Aegis Living San Rafael"));
});

test("THE PLANNER REFUSES TWO DIFFERENT COMMUNITIES THAT SHARE A PREFIX", () => {
  // The dangerous case, tested through the PLANNER and not just the key:
  // these are adjacent, in different chunks, and share nine leading
  // characters. A prefix rule merges them into one record and silently loses a
  // community. Every pair below is real in the 65-community source.
  for (const [a, b] of [
    ["Ivy Park at Piner", "Ivy Park at Santa Rosa"],
    ["Cogir of Sonoma", "Cogir of North Bay"],
    ["Aegis Living Napa", "Aegis Living San Rafael"],
    ["Brookdale Chanate", "Brookdale Paulin Creek"],
    ["The Reserve at Fountaingrove", "The Ridge at Healdsburg"],
  ] as const) {
    const plans = planContinuationMerges([
      P({ ordinal: 1, idx: 0, title: a }),
      P({ ordinal: 2, idx: 0, title: b }),
    ]);
    assert.equal(plans.length, 0, `merged two different communities: ${a} + ${b}`);
  }
});

test("THE TWO REAL SPLITS MERGE", () => {
  const plans = planContinuationMerges([
    P({ ordinal: 42, idx: 1, title: "The Reserve at Fountaingrove", address: "200 Fountaingrove Pkwy.",
        details: [{ label: "Shared Suite", value: "$8,990/month" }], links: [{ url: "https://a" }] }),
    P({ ordinal: 43, idx: 0, title: "The Reserve at Fountaingrove", address: "Santa Rosa, CA",
        description: "A long description of the community.", photos: ["p1", "p2"] }),
  ]);
  assert.equal(plans.length, 1, "the split was not detected");
  const m = plans[0].merged as Record<string, unknown>;
  assert.equal((m.details as unknown[]).length, 1, "pricing was dropped by the merge");
  assert.equal((m.photos as unknown[]).length, 2, "photos were dropped by the merge");
  assert.equal(m.description, "A long description of the community.", "the description was lost");
  assert.equal(m.address, "200 Fountaingrove Pkwy.", "the fuller address did not win");
});

test("the fuller title wins, so the city qualifier is not lost", () => {
  const plans = planContinuationMerges([
    P({ ordinal: 53, idx: 0, title: "Cogir of North Bay — Vallejo", details: [{ label: "Studio", value: "$3,695/month" }] }),
    P({ ordinal: 54, idx: 0, title: "Cogir of North Bay", photos: ["a"] }),
  ]);
  assert.equal(plans.length, 1);
  assert.equal((plans[0].merged as Record<string, unknown>).title, "Cogir of North Bay — Vallejo");
});

test("TWO RECORDS IN THE SAME CHUNK ARE NEVER MERGED", () => {
  // One chunk listing the same name twice is two records, not a split.
  assert.equal(planContinuationMerges([
    P({ ordinal: 7, idx: 0, title: "Brookdale Windsor" }),
    P({ ordinal: 7, idx: 1, title: "Brookdale Windsor" }),
  ]).length, 0);
});

test("non-adjacent halves are not reached across a third community", () => {
  assert.equal(planContinuationMerges([
    P({ ordinal: 1, idx: 0, title: "Villa Capri" }),
    P({ ordinal: 2, idx: 0, title: "Somewhere Else" }),
    P({ ordinal: 3, idx: 0, title: "Villa Capri" }),
  ]).length, 0);
});

test("a pair is never chained into a triple", () => {
  const plans = planContinuationMerges([
    P({ ordinal: 1, idx: 0, title: "X" }), P({ ordinal: 2, idx: 0, title: "X" }), P({ ordinal: 3, idx: 0, title: "X" }),
  ]);
  assert.equal(plans.length, 1, "three same-titled records collapsed into one chain");
});

test("merging invents nothing and drops nothing", () => {
  const a = P({ ordinal: 1, idx: 0, title: "A", details: [{ label: "L", value: "1" }], photos: ["x"],
                contacts: [{ name: "N", phone: "1" }], links: [{ url: "u1" }] });
  const b = P({ ordinal: 2, idx: 0, title: "A", details: [{ label: "M", value: "2" }], photos: ["x", "y"],
                contacts: [{ name: "N", phone: "1" }], links: [{ url: "u2" }] });
  const m = mergeProposals(a, b) as Record<string, unknown>;
  assert.equal((m.details as unknown[]).length, 2, "a detail was lost");
  assert.equal((m.photos as unknown[]).length, 2, "the duplicate photo was not deduped");
  assert.equal((m.contacts as unknown[]).length, 1, "the identical contact was duplicated");
  assert.equal((m.links as unknown[]).length, 2);
});

test("THE MERGE IS PERSISTED, not just presented", () => {
  // `save` reads the proposals table, so a read-time merge would still write
  // two Library items.
  const r = codeOf("src/app/api/library/import/[runId]/proposals/route.ts");
  assert.match(r, /planContinuationMerges\(/, "the route does not merge at all");
  assert.match(r, /\.update\(\{ payload \}\)/, "the merged payload is never written back");
  assert.match(r, /\.delete\(\)\.eq\("run_id", runId\)\.eq\("id", plan\.absorb\.id/, "the absorbed proposal is not removed");
});

// ---------------------------------------------------------------------------
// EVERY PRICE MUST EXIST IN THE SOURCE
// ---------------------------------------------------------------------------

test("prices compare by VALUE, so $4500 and $4,500 are one number", () => {
  assert.equal(priceKey("$4500"), priceKey("$4,500"));
  assert.equal(priceKey("$ 4,500.00"), priceKey("$4500"));
  assert.deepEqual(pricesIn("Studio $5,595-$6,250/month"), ["$5,595", "$6,250"]);
});

test("THE WINDSONG BLEND IS CAUGHT — by the RANGE check, not the value check", () => {
  // Two real tables in one source; the output took a low from one and a high
  // from the other, producing a range attested in neither.
  const source = `Memory Care
 - Shared Studio
 - $5,595-$6,250/month
 Additional PDF entry / possible updated pricing:
 - Shared Studio
 - $5,200/month`;
  const good = { details: [{ label: "MC Shared Studio", value: "$5,595-$6,250/month" }] };
  const alsoGood = { details: [{ label: "MC Shared Studio (updated)", value: "$5,200/month" }] };
  const blended = { details: [{ label: "MC Shared Studio", value: "$5,200-$6,250/month" }] };
  assert.equal(auditPrices(good, source).ok, true, "an attested range was flagged");
  assert.equal(auditPrices(alsoGood, source).ok, true, "the updated figure was flagged");
  // The blend uses only real numbers, so a value-by-value audit passes it —
  // that was the gap. The RANGE check closes it: the pairing is the claim.
  const b = auditPrices(blended, source);
  assert.equal(b.unsupported.length, 0, "both endpoints are real, as expected");
  assert.deepEqual(b.unsupportedRanges, ["$5,200-$6,250"], "the invented PAIRING was not caught");
  assert.equal(b.ok, false, "the blended range was accepted");
});

test("a price that appears NOWHERE in the community's source is reported", () => {
  const a = auditPrices({ details: [{ label: "Studio", value: "$9,999/month" }] }, "Studio $5,595/month");
  assert.equal(a.ok, false);
  assert.deepEqual(a.unsupported, ["$9,999"]);
});

test("THE AUDIT IS PER COMMUNITY — a neighbour's price does not excuse one", () => {
  // Auditing against the whole source reported almost nothing wrong, because a
  // value invented for one community was "found" in another's listing.
  const mine = "Studio $5,595/month";
  const neighbour = "Studio $9,999/month";
  assert.equal(auditPrices({ v: "$9,999" }, mine).ok, false, "a foreign price was accepted");
  assert.equal(auditPrices({ v: "$9,999" }, mine + "\n" + neighbour).ok, true);
});

test("the prompts carry the pricing rule", () => {
  const src = codeOf("src/lib/ai-prompts.ts");
  assert.match(src, /Never combine, average, interpolate, round, or build a range out of two different figures/);
  assert.equal((src.match(/\$\{PRICING_RULE\}/g) ?? []).length, 3, "the rule is not in all three prompts");
  assert.equal((src.match(/\$\{NOTES_RULE\}/g) ?? []).length, 3, "the notes rule was disturbed");
});
