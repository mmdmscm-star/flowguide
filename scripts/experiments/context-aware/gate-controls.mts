// The control corpora, held to the same "no regression" standard as before.
import { readFileSync } from "node:fs";
import { root } from "./lib.mts";
import type { Score } from "./ruler.mts";
type Row = { arm: string; corpus: string; score: Score; completionTokens: number; ms: number; cost: number };
const rows: Row[] = JSON.parse(readFileSync(`${root}/scripts/experiments/context-aware/out/scores.json`, "utf8"));
for (const corpus of ["icecream", "crossvert"]) {
  const stat = (arm: string) => {
    const a = rows.filter((r) => r.corpus === corpus && r.arm === arm);
    const m = (f: (r: Row) => number) => a.reduce((n, r) => n + f(r), 0) / a.length;
    const acc = m((r) => r.score.accepted), rep = m((r) => r.score.wouldBeRepaired);
    return { n: a.length, pct: (acc / (acc + rep)) * 100, om: m((r) => r.score.omissions),
      fab: m((r) => r.score.fabrications), notes: m((r) => r.score.unauthorizedNotes),
      attr: m((r) => r.score.attributionUnresolved), mal: m((r) => r.score.malformed),
      items: m((r) => r.score.itemsProposed) };
  };
  const a = stat("A"), b = stat("A2");
  const ok = b.pct >= a.pct - 1.0 && b.om <= a.om && b.fab <= a.fab && b.notes <= a.notes
    && b.attr <= a.attr && b.mal <= a.mal && b.items === a.items;
  console.log(`${ok ? "PASS" : "FAIL"}  ${corpus.padEnd(10)} acc ${a.pct.toFixed(1)}% -> ${b.pct.toFixed(1)}%  ` +
    `omissions ${a.om.toFixed(1)} -> ${b.om.toFixed(1)}  fab ${a.fab} -> ${b.fab}  ` +
    `notes ${a.notes} -> ${b.notes}  attrib ${a.attr} -> ${b.attr}  malformed ${a.mal} -> ${b.mal}  ` +
    `items ${a.items} -> ${b.items}`);
}
