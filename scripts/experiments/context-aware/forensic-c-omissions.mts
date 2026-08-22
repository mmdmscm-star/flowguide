// FORENSIC: what exactly did whole-source (C) drop on the senior corpus?
//
// Read-only. No model calls, no change to the harness or the scorer. It reuses
// the SAME specifics() extractor the ruler used to score omissions, so the
// facts classified here are precisely the facts that were counted.
import { readFileSync } from "node:fs";
import { root } from "./lib.mts";
import { specifics, itemsOf } from "./ruler.mts";
import { detectSourceRecords } from "../../../src/lib/segmentation.ts";

const OUT = `${root}/scripts/experiments/context-aware/out-v2-ABC`;
const source = readFileSync(`${root}/diagnostic-paste.txt`, "utf8");
const records = detectSourceRecords(source)!.records;

const key = (s: string) =>
  /^https?:/i.test(s) ? "url:" + s.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/g, "")
  : /@/.test(s) ? "email:" + s.toLowerCase().replace(/[^a-z0-9]+/g, "")
  : /^\$/.test(s) ? "money:" + s.replace(/\D+/g, "")
  : "phone:" + s.replace(/\D+/g, "");
const kind = (k: string) => k.split(":")[0];

/** Quote-aware split into the record's top-level tab cells. */
function cells(rec: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < rec.length; i++) {
    const ch = rec[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (ch === "\t" && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Every source fact, with where it lives.
interface Fact { k: string; raw: string; rec: number; col: number; cellLen: number; multiline: boolean }
const facts = new Map<string, Fact>();
for (let r = 0; r < records.length; r++) {
  const text = source.slice(records[r].start, records[r].end);
  const cs = cells(text);
  for (let c = 0; c < cs.length; c++) {
    for (const s of specifics(cs[c])) {
      const k = key(s);
      if (!facts.has(k)) {
        facts.set(k, { k, raw: s, rec: r + 1, col: c, cellLen: cs[c].length, multiline: /\n/.test(cs[c]) });
      }
    }
  }
}

function proposalKeys(arm: string, rep: number): Set<string> {
  const d = JSON.parse(readFileSync(`${OUT}/raw-senior-${arm}-r${rep}.json`, "utf8"));
  const items: unknown[] = [];
  for (const c of d.calls) {
    if (!c.content) continue;
    const t = String(c.content).replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
    try { items.push(...itemsOf(JSON.parse(t))); } catch { /* malformed counted elsewhere */ }
  }
  return new Set(specifics(JSON.stringify(items)).map(key));
}

const reps = [1, 2, 3];
const cKeys = reps.map((r) => proposalKeys("C", r));
const aKeys = reps.map((r) => proposalKeys("A", r));

const rows: Array<Fact & { missIn: number[]; aHas: boolean[] }> = [];
for (const f of facts.values()) {
  const missIn = reps.filter((r, i) => !cKeys[i].has(f.k));
  if (!missIn.length) continue;
  rows.push({ ...f, missIn, aHas: reps.map((r, i) => aKeys[i].has(f.k)) });
}
rows.sort((a, b) => a.rec - b.rec || a.col - b.col);

const bucket = (r: number) => (r <= 7 ? "early(1-7)" : r <= 14 ? "middle(8-14)" : "late(15-20)");
const shape = (f: Fact) => (f.multiline || f.cellLen > 200 ? "long/multiline" : "short/simple");

console.log(`senior source: ${records.length} records, ${facts.size} distinct source specifics\n`);
console.log("rec | pos        | type  | col | cell shape     | missed in C | A preserved (r1,r2,r3) | value");
for (const r of rows) {
  console.log([
    String(r.rec).padStart(3),
    bucket(r.rec).padEnd(10),
    kind(r.k).padEnd(5),
    String(r.col).padStart(3),
    shape(r).padEnd(14),
    (r.missIn.length + "/3 (" + r.missIn.join(",") + ")").padEnd(11),
    r.aHas.map((x) => (x ? "Y" : "N")).join(",").padEnd(22),
    r.raw.slice(0, 46),
  ].join(" | "));
}

// ---- summaries ------------------------------------------------------------
const tally = (fn: (r: (typeof rows)[number]) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(fn(r), (m.get(fn(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");
};
const allFacts = [...facts.values()];
const denom = (fn: (f: Fact) => string, v: string) => allFacts.filter((f) => fn(f) === v).length;

console.log(`\ndistinct facts missed by C in >=1 repetition: ${rows.length} of ${facts.size}`);
console.log(`by position : ${tally((r) => bucket(r.rec))}`);
console.log(`   (source facts per bucket: early=${denom((f) => bucket(f.rec), "early(1-7)")}  middle=${denom((f) => bucket(f.rec), "middle(8-14)")}  late=${denom((f) => bucket(f.rec), "late(15-20)")})`);
console.log(`by type     : ${tally((r) => kind(r.k))}`);
console.log(`   (source facts per type: ${["url", "email", "phone", "money"].map((t) => `${t}=${allFacts.filter((f) => kind(f.k) === t).length}`).join("  ")})`);
console.log(`by shape    : ${tally(shape)}`);
console.log(`   (source facts per shape: short=${denom(shape, "short/simple")}  long=${denom(shape, "long/multiline")})`);
console.log(`by column   : ${tally((r) => "col" + r.col)}`);
console.log(`persistence : ${tally((r) => r.missIn.length + "/3 reps")}`);
const aAlsoMissedAll = rows.filter((r) => r.aHas.every((x) => !x)).length;
const aKeptAll = rows.filter((r) => r.aHas.every((x) => x)).length;
console.log(`A preserved it in all 3 paired reps : ${aKeptAll}`);
console.log(`A missed it in all 3 paired reps too: ${aAlsoMissedAll}  (shared blind spot, not a C-specific loss)`);
console.log(`A mixed across reps                 : ${rows.length - aKeptAll - aAlsoMissedAll}`);
