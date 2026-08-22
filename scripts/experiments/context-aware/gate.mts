// The pre-recorded B2 gate, checked item by item on the raw transcripts.
import { readFileSync, readdirSync } from "node:fs";
import { root } from "./lib.mts";
const OUT = `${root}/scripts/experiments/context-aware/out`;

function items(corpus: string, arm: string, rep: number) {
  const d = JSON.parse(readFileSync(`${OUT}/raw-${corpus}-${arm}-r${rep}.json`, "utf8"));
  const out: any[] = [];
  for (const c of d.calls) {
    if (!c.content) continue;
    const t = String(c.content).replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
    try { const r = JSON.parse(t);
      out.push(...(r.items ?? []), ...((r.sections ?? []).flatMap((s: any) => s.items ?? [])));
    } catch { /* counted as malformed elsewhere */ }
  }
  return out;
}
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const digits = (s: unknown) => String(s ?? "").replace(/\D+/g, "");

// ---- ice cream: titles, phones, websites must not regress ----------------
console.log("### ice cream — exact titles / phones / websites");
for (const rep of [1, 2, 3]) {
  const a = items("icecream", "A", rep), b = items("icecream", "B3", rep);
  const titles = (xs: any[]) => xs.map((i) => String(i.title ?? "")).sort();
  const phones = (xs: any[]) => [...new Set(JSON.stringify(xs).match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [])].map(digits).sort();
  const sites = (xs: any[]) => [...new Set((JSON.stringify(xs).match(/[a-z0-9.-]+\.(com|net|org)/gi) ?? []))].map(norm).sort();
  const ta = titles(a), tb = titles(b);
  const same = JSON.stringify(ta) === JSON.stringify(tb);
  console.log(`r${rep}: titles ${a.length}/${b.length} items, identical=${same}`);
  if (!same) {
    console.log(`   A-only: ${JSON.stringify(ta.filter((t) => !tb.includes(t)))}`);
    console.log(`   B-only: ${JSON.stringify(tb.filter((t) => !ta.includes(t)))}`);
  }
  console.log(`   phones A=${phones(a).length} B2=${phones(b).length} identical=${JSON.stringify(phones(a)) === JSON.stringify(phones(b))}`);
  console.log(`   sites  A=${sites(a).length} B2=${sites(b).length} identical=${JSON.stringify(sites(a)) === JSON.stringify(sites(b))}`);
}

// ---- cross-vertical: the contamination control ---------------------------
console.log("\n### cross-vertical — one chunk, so B2 has no deficit to repair");
for (const rep of [1, 2, 3]) {
  const a = items("crossvert", "A", rep), b = items("crossvert", "B3", rep);
  const key = (xs: any[]) => xs.map((i) => JSON.stringify([i.title, i.address, i.details, i.links, i.photos, i.contacts])).sort();
  const ka = key(a), kb = key(b);
  const identical = ka.filter((x) => kb.includes(x)).length;
  console.log(`r${rep}: ${a.length} vs ${b.length} items, byte-identical items: ${identical}/${a.length}`);
  console.log(`   titles A: ${JSON.stringify(a.map((i) => i.title))}`);
  console.log(`   titles B3:${JSON.stringify(b.map((i) => i.title))}`);
}
