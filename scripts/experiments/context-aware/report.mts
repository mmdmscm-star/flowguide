// Reads out/scores.json and prints the comparison. No model calls, so a
// scoring or presentation fix costs nothing to re-run.
import { readFileSync } from "node:fs";
import { acrossReps, type Score } from "./ruler.mts";
import { root } from "./lib.mts";

type Row = { arm: string; corpus: string; rep: number; calls: number;
  promptTokens: number; completionTokens: number; ms: number; cost: number; score: Score };
const rows: Row[] = JSON.parse(readFileSync(`${root}/scripts/experiments/context-aware/out/scores.json`, "utf8"));

// Derived from the data, not hardcoded: a hardcoded list silently omitted B2
// entirely and printed a one-arm "comparison".
const ARMS = [...new Set(rows.map((r) => r.arm))].sort();
const corpora = [...new Set(rows.map((r) => r.corpus))];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const f = (n: number, d = 1) => n.toFixed(d);

// What the provider actually charged, not a list-price guess.
const cost = (rs: Row[]) => mean(rs.map((r) => r.cost));

function block(label: string, rs: Row[]) {
  console.log(`\n### ${label}`);
  console.log("arm | items | accepted | would-repair | acc% | omissions | fabric | unauth-notes | attrib-unres | src-unres | malformed | dest-disagree | item-consistency | calls | in-tok | out-tok | secs | $/run");
  for (const arm of ARMS) {
    const a = rs.filter((r) => r.arm === arm);
    if (!a.length) continue;
    const sc = a.map((r) => r.score);
    const acc = mean(sc.map((s) => s.accepted));
    const rep = mean(sc.map((s) => s.wouldBeRepaired));
    const pct = acc + rep > 0 ? (acc / (acc + rep)) * 100 : 0;
    const x = acrossReps(sc);
    console.log([
      arm,
      f(mean(sc.map((s) => s.itemsProposed))),
      f(acc), f(rep), f(pct) + "%",
      f(mean(sc.map((s) => s.omissions))),
      f(mean(sc.map((s) => s.fabrications))),
      f(mean(sc.map((s) => s.unauthorizedNotes))),
      f(mean(sc.map((s) => s.attributionUnresolved))),
      f(mean(sc.map((s) => s.sourceUnresolved))),
      f(mean(sc.map((s) => s.malformed)), 2),
      `${x.destinationDisagreements}/${x.placedValues}`,
      `${x.itemsIdenticalAcrossReps}/${x.itemsCompared}`,
      f(mean(a.map((r) => r.calls))),
      f(mean(a.map((r) => r.promptTokens)), 0),
      f(mean(a.map((r) => r.completionTokens)), 0),
      f(mean(a.map((r) => r.ms)) / 1000),
      "$" + cost(a).toFixed(4),
    ].join(" | "));
  }
}

for (const c of corpora) block(c, rows.filter((r) => r.corpus === c));

// OVERALL, summed per repetition across corpora rather than averaged across
// rows: a corpus with 17 chunks and one with 1 are not equal units of anything.
console.log("\n### overall (per repetition, summed across corpora)");
console.log("arm | accepted | would-repair | acc% | omissions | fabric | unauth-notes | attrib-unres | malformed | calls | in-tok | out-tok | secs | $/run");
for (const arm of ARMS) {
  const reps = [...new Set(rows.map((r) => r.rep))];
  const per = reps.map((rp) => rows.filter((r) => r.arm === arm && r.rep === rp));
  if (!per[0]?.length) continue;
  const g = (fn: (r: Row) => number) => mean(per.map((rs) => sum(rs.map(fn))));
  const acc = g((r) => r.score.accepted), rep = g((r) => r.score.wouldBeRepaired);
  console.log([
    arm, f(acc), f(rep), f(acc + rep > 0 ? (acc / (acc + rep)) * 100 : 0) + "%",
    f(g((r) => r.score.omissions)), f(g((r) => r.score.fabrications)),
    f(g((r) => r.score.unauthorizedNotes)), f(g((r) => r.score.attributionUnresolved)),
    f(g((r) => r.score.malformed), 2),
    f(g((r) => r.calls)), f(g((r) => r.promptTokens), 0), f(g((r) => r.completionTokens), 0),
    f(g((r) => r.ms) / 1000),
    "$" + g((r) => r.cost).toFixed(4),
  ].join(" | "));
}
