// The predeclared A2 gate, checked mechanically. Read-only.
import { readFileSync } from "node:fs";
import { root } from "./lib.mts";
import { specifics, itemsOf, type Score } from "./ruler.mts";
const OUT = `${root}/scripts/experiments/context-aware/out`;
type Row = { arm: string; corpus: string; rep: number; calls: number; completionTokens: number;
  ms: number; cost: number; score: Score };
// SENIOR ONLY. The gate was written and first applied when out/ held senior
// alone, so every threshold in it is a senior threshold. Averaging three
// corpora into it would silently change what the numbers mean while appearing
// to run the same gate. Controls are reported separately, as they always were.
const rows: Row[] = (JSON.parse(readFileSync(`${OUT}/scores.json`, "utf8")) as Row[])
  .filter((r) => r.corpus === "senior");
const m = (arm: string, f: (r: Row) => number) => {
  const a = rows.filter((r) => r.arm === arm); return a.reduce((n, r) => n + f(r), 0) / a.length;
};
// Duplication pathology: the same specific emitted into two destinations of the
// SAME item. "Preserve everything" going wrong looks like this.
function dupWithinItems(arm: string): number {
  let dup = 0;
  for (const rep of [1, 2, 3]) {
    const d = JSON.parse(readFileSync(`${OUT}/raw-senior-${arm}-r${rep}.json`, "utf8"));
    for (const c of d.calls) {
      if (!c.content) continue;
      const t = String(c.content).replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
      let items: Record<string, unknown>[] = [];
      try { items = itemsOf(JSON.parse(t)) as Record<string, unknown>[]; } catch { continue; }
      for (const it of items) {
        const counts = new Map<string, number>();
        for (const k of ["address", "description", "notes", "details", "links", "photos", "contacts"]) {
          for (const s of specifics(JSON.stringify(it[k] ?? ""))) {
            const key = /^https?:/i.test(s) ? s.toLowerCase().replace(/[^a-z0-9]+/g, "") : s.replace(/\D+/g, "");
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        for (const v of counts.values()) if (v > 1) dup++;
      }
    }
  }
  return dup / 3;
}
const g = (name: string, ok: boolean, detail: string) =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
const aO = m("A", (r) => r.score.omissions), a2O = m("A2", (r) => r.score.omissions);
const accOf = (arm: string) => {
  const acc = m(arm, (r) => r.score.accepted), rep = m(arm, (r) => r.score.wouldBeRepaired);
  return (acc / (acc + rep)) * 100;
};
console.log("\n### predeclared A2 gate");
g("1. omissions reduced", a2O < aO, `A=${aO.toFixed(1)} -> A2=${a2O.toFixed(1)}`);
g("2. fabrication not above A", m("A2", (r) => r.score.fabrications) <= m("A", (r) => r.score.fabrications),
  `A=${m("A", (r) => r.score.fabrications).toFixed(1)} -> A2=${m("A2", (r) => r.score.fabrications).toFixed(1)}`);
g("3. unauthorized notes not above A", m("A2", (r) => r.score.unauthorizedNotes) <= m("A", (r) => r.score.unauthorizedNotes),
  `A=${m("A", (r) => r.score.unauthorizedNotes).toFixed(1)} -> A2=${m("A2", (r) => r.score.unauthorizedNotes).toFixed(1)}`);
g("4. attribution not above A", m("A2", (r) => r.score.attributionUnresolved) <= m("A", (r) => r.score.attributionUnresolved),
  `A=${m("A", (r) => r.score.attributionUnresolved).toFixed(1)} -> A2=${m("A2", (r) => r.score.attributionUnresolved).toFixed(1)}`);
g("5. malformed not above A", m("A2", (r) => r.score.malformed) <= m("A", (r) => r.score.malformed),
  `A=${m("A", (r) => r.score.malformed).toFixed(2)} -> A2=${m("A2", (r) => r.score.malformed).toFixed(2)}`);
g("6. accepted rate not >1.0pp below A", accOf("A2") >= accOf("A") - 1.0,
  `A=${accOf("A").toFixed(1)}% -> A2=${accOf("A2").toFixed(1)}%`);
const itemsOk = rows.every((r) => r.score.itemsProposed === 20);
const dA = dupWithinItems("A"), dA2 = dupWithinItems("A2");
const tokOk = m("A2", (r) => r.completionTokens) <= 1.5 * m("A", (r) => r.completionTokens);
g("7a. item count stays 20", itemsOk, rows.map((r) => r.score.itemsProposed).join(","));
g("7b. no new within-item duplication", dA2 <= dA * 1.25 + 1, `A=${dA.toFixed(1)} -> A2=${dA2.toFixed(1)} per rep`);
g("7c. output tokens < 1.5x A", tokOk,
  `A=${m("A", (r) => r.completionTokens).toFixed(0)} -> A2=${m("A2", (r) => r.completionTokens).toFixed(0)} (${(m("A2", (r) => r.completionTokens) / m("A", (r) => r.completionTokens)).toFixed(2)}x)`);
console.log(`\ncost/time: A ${m("A", (r) => r.ms) / 1000}s $${m("A", (r) => r.cost).toFixed(3)} | A2 ${(m("A2", (r) => r.ms) / 1000).toFixed(0)}s $${m("A2", (r) => r.cost).toFixed(3)}`);
console.log(`omissions per rep: A ${rows.filter((r) => r.arm === "A").map((r) => r.score.omissions).join(", ")} | A2 ${rows.filter((r) => r.arm === "A2").map((r) => r.score.omissions).join(", ")}`);
