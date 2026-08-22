// Did the lossless contract recover the 26 C-specific omissions?
import { readFileSync, existsSync } from "node:fs";
import { root } from "./lib.mts";
import { specifics, itemsOf } from "./ruler.mts";
import { detectSourceRecords } from "../../../src/lib/segmentation.ts";

const V2 = `${root}/scripts/experiments/context-aware/out-v2-ABC`;
const NOW = `${root}/scripts/experiments/context-aware/out`;
const source = readFileSync(`${root}/diagnostic-paste.txt`, "utf8");
const records = detectSourceRecords(source)!.records;
const key = (s: string) =>
  /^https?:/i.test(s) ? "url:" + s.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/g, "")
  : /@/.test(s) ? "email:" + s.toLowerCase().replace(/[^a-z0-9]+/g, "")
  : /^\$/.test(s) ? "money:" + s.replace(/\D+/g, "") : "phone:" + s.replace(/\D+/g, "");

function keysOf(dir: string, arm: string, rep: number): Set<string> | null {
  const f = `${dir}/raw-senior-${arm}-r${rep}.json`;
  if (!existsSync(f)) return null;
  const d = JSON.parse(readFileSync(f, "utf8"));
  const items: unknown[] = [];
  let anyOk = false;
  for (const c of d.calls) {
    if (!c.content || c.ok === false) continue;
    anyOk = true;
    const t = String(c.content).replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
    try { items.push(...itemsOf(JSON.parse(t))); } catch { /* */ }
  }
  return anyOk ? new Set(specifics(JSON.stringify(items)).map(key)) : null;
}

const srcFacts = new Map<string, { rec: number; raw: string }>();
for (let r = 0; r < records.length; r++)
  for (const s of specifics(source.slice(records[r].start, records[r].end)))
    if (!srcFacts.has(key(s))) srcFacts.set(key(s), { rec: r + 1, raw: s });

const reps = [1, 2, 3];
const cK = reps.map((r) => keysOf(V2, "C", r)!);
const aK = reps.map((r) => keysOf(V2, "A", r)!);
const c2K = reps.map((r) => keysOf(NOW, "C2", r)).filter(Boolean) as Set<string>[];
console.log(`C2 repetitions usable: ${c2K.length} of 3\n`);

// The 26: missed by C in all 3, not missed by A in all 3.
const cSpecific = [...srcFacts.keys()].filter((k) =>
  cK.every((s) => !s.has(k)) && !aK.every((s) => !s.has(k)));
const recovered = cSpecific.filter((k) => c2K.every((s) => s.has(k)));
const partly = cSpecific.filter((k) => c2K.some((s) => s.has(k)) && !c2K.every((s) => s.has(k)));
const still = cSpecific.filter((k) => c2K.every((s) => !s.has(k)));

console.log(`### the ${cSpecific.length} C-specific omissions under C2`);
console.log(`recovered in EVERY C2 repetition : ${recovered.length}`);
console.log(`recovered in some but not all    : ${partly.length}`);
console.log(`still missing in every C2 rep    : ${still.length}`);
for (const k of still) console.log(`   still missing: rec ${srcFacts.get(k)!.rec} ${srcFacts.get(k)!.raw}`);
for (const k of partly) console.log(`   intermittent : rec ${srcFacts.get(k)!.rec} ${srcFacts.get(k)!.raw}`);

// NEW omissions: present in every C run, absent in every C2 run.
const newlyLost = [...srcFacts.keys()].filter((k) =>
  cK.every((s) => s.has(k)) && c2K.every((s) => !s.has(k)));
console.log(`\n### new omissions introduced by C2 (C had them, C2 never does): ${newlyLost.length}`);
for (const k of newlyLost.slice(0, 10)) console.log(`   rec ${srcFacts.get(k)!.rec} ${srcFacts.get(k)!.raw}`);

// Totals against the same 429-fact denominator.
const omit = (s: Set<string>) => [...srcFacts.keys()].filter((k) => !s.has(k)).length;
console.log(`\n### omissions per repetition (of ${srcFacts.size} source facts)`);
console.log(`A  : ${aK.map(omit).join(", ")}`);
console.log(`C  : ${cK.map(omit).join(", ")}`);
console.log(`C2 : ${c2K.map(omit).join(", ")}`);
const fab = (s: Set<string>) => 0;
void fab;
