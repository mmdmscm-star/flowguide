// ARM O: the two checks the summary table cannot make.
//
// 1. CROSS-RECORD LEAKAGE. Orientation lets the model see the whole source
//    once. The risk this creates is not a wrong fact - it is a TRUE fact
//    arriving in the wrong item, carried from a part of the source that chunk
//    never saw. That is undetectable by any check that only asks "is this true
//    of the document", so it is checked per chunk: every specific in an item
//    must be present in the chunk text that produced it.
//
// 2. THE BRIEFS THEMSELVES. A brief that names a business or a price has
//    stopped orienting and started extracting. Checked with the SAME specifics
//    extractor used for fabrication scoring, so the two cannot disagree.
import { readFileSync, existsSync } from "node:fs";
import { root } from "./lib.mts";
import { specifics, itemsOf } from "./ruler.mts";

const OUT = `${root}/scripts/experiments/context-aware/out`;
const norm = (s: string) =>
  /^https?:/i.test(s) ? s.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/g, "")
  : /@/.test(s) ? s.toLowerCase().replace(/[^a-z0-9]+/g, "")
  : s.replace(/\D+/g, "");

function parse(content: string | null): unknown {
  if (!content) return null;
  const t = content.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { return null; }
}

const corpora = ["senior", "icecream", "crossvert"];
const reps = [1, 2, 3];

console.log("### cross-record leakage — a specific in an item that its own chunk never contained");
for (const c of corpora) {
  for (const arm of ["A", "O"]) {
    let leaked = 0, checked = 0;
    const examples: string[] = [];
    for (const rep of reps) {
      const f = `${OUT}/raw-${c}-${arm}-r${rep}.json`;
      if (!existsSync(f)) continue;
      const d = JSON.parse(readFileSync(f, "utf8"));
      for (const call of d.calls) {
        const items = itemsOf(parse(call.content));
        if (!items.length) continue;
        const hay = new Set(specifics(String(call.chunkText ?? "")).map(norm));
        for (const s of specifics(JSON.stringify(items))) {
          checked++;
          if (!hay.has(norm(s))) { leaked++; if (examples.length < 3) examples.push(s); }
        }
      }
    }
    console.log(`${c.padEnd(10)} ${arm.padEnd(2)} leaked ${leaked}/${checked}` +
      (examples.length ? `  e.g. ${JSON.stringify(examples)}` : ""));
  }
}

console.log("\n### the orientation briefs");
for (const c of corpora) {
  const briefs: string[] = [];
  for (const rep of reps) {
    const f = `${OUT}/raw-${c}-O-r${rep}.json`;
    if (!existsSync(f)) continue;
    const d = JSON.parse(readFileSync(f, "utf8"));
    briefs.push(String(d.orientation?.brief ?? ""));
  }
  if (!briefs.length) continue;
  console.log(`\n--- ${c}`);
  for (let i = 0; i < briefs.length; i++) {
    const spec = specifics(briefs[i]);
    console.log(`  r${i + 1}: ${briefs[i].split(/\s+/).length} words, ` +
      `record-specific values detected: ${spec.length}${spec.length ? " -> " + JSON.stringify(spec.slice(0, 4)) : ""}`);
  }
  // Stability: shared vocabulary between repetitions, as a rough agreement
  // measure. Prose will never be identical; the question is whether it is
  // describing the same document.
  const words = briefs.map((b) => new Set(b.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  const jac = (a: Set<string>, b: Set<string>) =>
    [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size;
  const pairs = [jac(words[0], words[1]), jac(words[0], words[2]), jac(words[1], words[2])];
  console.log(`  vocabulary agreement between repetitions: ${pairs.map((p) => (p * 100).toFixed(0) + "%").join(", ")}`);
}

console.log("\n### brief text, repetition 1 (read it — the numbers cannot tell you if it is orienting or extracting)");
for (const c of corpora) {
  const f = `${OUT}/raw-${c}-O-r1.json`;
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, "utf8"));
  console.log(`\n--- ${c} ---\n${String(d.orientation?.brief ?? "").trim()}`);
}
