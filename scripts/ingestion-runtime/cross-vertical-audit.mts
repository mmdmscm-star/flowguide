// OVERFITTING TEST. Runs the UNMODIFIED claim/accounting logic over four
// non-senior-living verticals and reports where "horizontal" rules fail.
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll } from "../../src/lib/attribution.ts";
import { PASTE, CROSS_VERTICAL, EXPECTED } from "./fixtures/cross-vertical.mts";

const ENV = recordEnvelopes(PASTE);
console.log(`\n${"=".repeat(72)}\nCROSS-VERTICAL OVERFITTING AUDIT\n${"=".repeat(72)}`);
console.log(`  record envelopes ......... ${ENV ? ENV.length : "FAILED"} (expected ${CROSS_VERTICAL.length})`);

const parsed = parseClaims(PASTE, 0);
const labelled = parsed.claims.filter((c) => c.kind === "labelled");
const pricing = parsed.claims.filter((c) => c.kind === "pricing");

// ---- labelled recall -------------------------------------------------------
const gotLabels = labelled.map((c) => c.label!);
const missingLabels: string[] = [];
const counts = new Map<string, number>();
for (const l of gotLabels) counts.set(l, (counts.get(l) ?? 0) + 1);
const want = new Map<string, number>();
for (const l of EXPECTED.labelledFacts) want.set(l, (want.get(l) ?? 0) + 1);
for (const [l, n] of want) if ((counts.get(l) ?? 0) < n) missingLabels.push(`${l} (want ${n}, got ${counts.get(l) ?? 0})`);
console.log(`  labelled facts ........... ${gotLabels.length} claimed, expected ${EXPECTED.labelledFacts.length}`);
console.log(`    recall ................. ${((EXPECTED.labelledFacts.length - missingLabels.length) / EXPECTED.labelledFacts.length * 100).toFixed(1)}%`);
if (missingLabels.length) { console.log(`    MISSING:`); for (const m of missingLabels) console.log(`      ${m}`); }

// ---- unlabelled pricing ----------------------------------------------------
console.log(`\n  UNLABELLED PRICING — the class most at risk of vertical assumptions`);
console.log(`    claimed .................. ${pricing.length}`);
for (const c of pricing) console.log(`      ${JSON.stringify(c.anchors)}`);
const claimedText = pricing.map((c) => c.value);
const missedPricing = EXPECTED.unlabelledPricing.filter((w) => !claimedText.some((t) => t.includes(w.split("$")[0].trim())));
console.log(`    expected but NOT claimed . ${missedPricing.length}/${EXPECTED.unlabelledPricing.length}`);
for (const m of missedPricing) console.log(`      ${m}`);

// ---- ambiguity -------------------------------------------------------------
console.log(`\n  AMBIGUOUS SOURCE UNITS ..... ${parsed.ambiguous.length}`);
for (const a of parsed.ambiguous) console.log(`      ${a.text.slice(0, 62)}`);
const missedAmbig = EXPECTED.mustBeAmbiguous.filter((w) => !parsed.ambiguous.some((a) => a.text.includes(w.replace(/^-\s*/, "").slice(0, 22))));
console.log(`    should be ambiguous but is NOT: ${missedAmbig.length}`);
for (const m of missedAmbig) {
  const asClaim = pricing.find((c) => c.value.includes(m.replace(/^-\s*/, "").slice(0, 22)));
  console.log(`      ${m}${asClaim ? `   -> CLAIMED as "${asClaim.anchors?.descriptor}"  (WRONG PAIRING)` : "   -> declined as a plain fragment"}`);
}

// ---- fragments -------------------------------------------------------------
const byReason: Record<string, number> = {};
for (const f of parsed.fragments) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
console.log(`\n  DECLINED FRAGMENTS`);
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}×  ${k}`);
const pricedFrags = parsed.fragments.filter((f) => /\$/.test(f.text));
if (pricedFrags.length) {
  console.log(`\n  *** PRICED CONTENT THAT FELL OUT OF ACCOUNTING ENTIRELY (${pricedFrags.length}) ***`);
  for (const f of pricedFrags) console.log(`      ${f.reason}: ${f.text.slice(0, 62)}`);
}

// ---- attribution -----------------------------------------------------------
const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, ENV, 0);
console.log(`\n  ATTRIBUTION`);
console.log(`    records with claims ...... ${a.byRecord.size}`);
console.log(`    ATTRIBUTION_UNRESOLVED ... ${a.unattributedClaims.length + a.unattributedAmbiguous.length}`);
console.log("");
