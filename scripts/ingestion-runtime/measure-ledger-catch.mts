// OBSERVE-ONLY LEDGER RESULT.
//
// The question this answers is narrow and the only one worth asking before
// Steps 4-6 are designed: OF THE FACTS THE MODEL ACTUALLY LOST IN THE REAL
// CORPUS V2 RUNS, HOW MANY WOULD THE LEDGER HAVE FLAGGED AS UNRESOLVED?
//
// It needs no model calls and no database. It joins the three persisted v2 run
// scorecards to the detector's deterministic detection set.
//
// The inference is sound because reconcile() flags any DETECTED fact that is
// ABSENT from the run's items, and a fact scored LOST is absent by definition.
// It does NOT extend to MISCLASSIFIED facts — those are present in the output,
// just in the wrong field, and the ledger by design says nothing about them.
// Corpus v2 scored MISCLASSIFIED = 0, so nothing hides in that gap here.
import { readFileSync, existsSync } from "node:fs";
import { detectFacts } from "../../src/lib/fact-ledger.ts";
import { squash } from "../../src/lib/fact-match.ts";
import { buildRunChunks } from "../../src/lib/ingestion.ts";
import * as V2 from "./fixtures/semantic-corpus-v2.mts";

type Row = { run: number; rec: string; fact: string; shape: string; outcome: string; expect: string };

const files = [1, 2, 3].map((i) => `/tmp/v2-run${i}.json`).filter(existsSync);
if (!files.length) { console.error("No persisted v2 runs found."); process.exit(1); }
const rows: Row[] = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")));

// Fact text, by record + fact id, from the corpus itself.
const textOf = new Map<string, { text: string; present: boolean }>();
for (const r of V2.RECORDS as any[])
  for (const f of r.facts) textOf.set(`${r.key}/${f.id}`, { text: f.text, present: f.present });

const detected = buildRunChunks(V2.SOURCE).flatMap((c) => detectFacts(c.segment_text, c.ordinal));
const needles = detected.map((d) => ({ d, n: squash(d.text) })).filter((x) => x.n);
const isDetected = (text: string) => {
  const y = squash(text);
  return Boolean(y) && needles.some((x) => x.n.includes(y) || y.includes(x.n));
};

const lost = rows.filter((r) => r.outcome === "LOST");
const seen = new Map<string, { shape: string; expect: string; text: string; runs: number; caught: boolean }>();
for (const r of lost) {
  const t = textOf.get(`${r.rec}/${r.fact}`);
  if (!t?.present) continue;
  const k = `${r.rec}/${r.fact}`;
  const e = seen.get(k) ?? { shape: r.shape, expect: r.expect, text: t.text, runs: 0, caught: isDetected(t.text) };
  e.runs++;
  seen.set(k, e);
}

const all = [...seen.values()];
const caught = all.filter((e) => e.caught);
const missed = all.filter((e) => !e.caught);

console.log(`\n${"=".repeat(66)}\nOBSERVE-ONLY LEDGER — corpus v2, ${files.length} real runs`);
console.log(`  scored fact-outcomes ........ ${rows.length}`);
console.log(`  LOST outcomes ............... ${lost.length}  (${all.length} distinct facts)`);
console.log(`  LEDGER WOULD FLAG ........... ${caught.length}/${all.length}  (${(caught.length / all.length * 100).toFixed(1)}%)`);
console.log(`  ledger silent on ............ ${missed.length}`);

const by = (list: typeof all, k: "shape" | "expect") => {
  const m: Record<string, { n: number; c: number }> = {};
  for (const e of list) { m[e[k]] ??= { n: 0, c: 0 }; m[e[k]].n++; if (e.caught) m[e[k]].c++; }
  return m;
};
console.log(`\n  LOST facts by shape — flagged / lost`);
for (const [k, v] of Object.entries(by(all, "shape")).sort((a, b) => b[1].n - a[1].n))
  console.log(`      ${k.padEnd(10)} ${String(v.c).padStart(3)} / ${String(v.n).padEnd(3)}  ${(v.c / v.n * 100).toFixed(0)}%`);
console.log(`\n  LOST facts by destination the corpus expected`);
for (const [k, v] of Object.entries(by(all, "expect")).sort((a, b) => b[1].n - a[1].n))
  console.log(`      ${k.padEnd(14)} ${String(v.c).padStart(3)} / ${String(v.n).padEnd(3)}  ${(v.c / v.n * 100).toFixed(0)}%`);

if (missed.length) {
  console.log(`\n  SILENT — lost facts the ledger would NOT have flagged:`);
  for (const e of missed.slice(0, 20)) console.log(`      ${e.shape}/${e.expect}: ${e.text.slice(0, 54)}`);
}
console.log(`\n  TIER-1 REACH — of the flagged losses, how many are key/value facts`);
console.log(`  with no more specific source-backed destination, and so eligible`);
console.log(`  for verbatim detail preservation under the approved Tier-1 rule:`);
const kvEligible = detected.filter((d) => d.detailEligible);
const eligibleCaught = caught.filter((e) => kvEligible.some((d) => { const a = squash(d.text), b = squash(e.text); return a.includes(b) || b.includes(a); }));
console.log(`      ${eligibleCaught.length}/${caught.length} flagged losses are Tier-1 eligible`);
console.log(`      ${caught.length - eligibleCaught.length} would fall to Tier-2 (surface, do not auto-place)\n`);
