// Judge a Library import's proposals against the exact source, community by
// community. Pure analysis — no model calls, no database writes.
import { readFileSync } from "node:fs";
import { planContinuationMerges, communityKey } from "../../src/lib/library-continuation.ts";
import { auditPrices, pricesIn } from "../../src/lib/price-provenance.ts";

const props = JSON.parse(readFileSync(process.argv[2], "utf8")).proposals as any[];
const sheet = JSON.parse(readFileSync(process.argv[3], "utf8")) as string[][];
const data = sheet.slice(1).filter(r => r.some(c => String(c).trim()));

const plans = planContinuationMerges(props);
const absorbed = new Set(plans.map(p => p.absorb.id));
const final = props.filter(p => !absorbed.has(p.id)).map(p => plans.find(x => x.keep.id === p.id)?.merged ?? p) as any[];

// SOURCE-TO-RECORD MATCHING. Exact key first; then containment either way, so
// "Primrose" pairs with "Primrose Alzheimer's Living" and the "(formerly called
// …)" rows pair with their short names. Unmatched is reported, never silently
// skipped — an unaudited community is not a passing one.
const srcRows = data.map(r => ({ title: String(r[0] ?? "").split("\n")[0].trim(), blob: r.map(String).join("\n") }));
const used = new Set<number>();
function sourceFor(title: string): { i: number; blob: string } | null {
  const k = communityKey(title);
  let i = srcRows.findIndex((s, idx) => !used.has(idx) && communityKey(s.title) === k);
  if (i === -1) i = srcRows.findIndex((s, idx) => {
    if (used.has(idx)) return false;
    const sk = communityKey(s.title);
    return sk.length > 5 && k.length > 5 && (sk.startsWith(k) || k.startsWith(sk));
  });
  if (i === -1) return null;
  used.add(i); return { i, blob: srcRows[i].blob };
}

console.log(`proposals in: ${props.length}   merges applied: ${plans.length}   FINAL RECORDS: ${final.length}   source communities: ${data.length}`);
for (const p of plans) console.log(`   merged: "${p.keep.title}" + "${p.absorb.title}" -> "${(p.merged as any).title}"`);

const notes = final.filter(f => String(f.notes ?? "").trim());
console.log(`\nrecords with non-empty private notes: ${notes.length}`);
for (const n of notes) console.log(`   ! ${n.title}: ${JSON.stringify(String(n.notes).slice(0, 140))}`);

let priceFail = 0, unmatched: string[] = [], thin: string[] = [], lostVals = 0;
for (const f of final) {
  const s = sourceFor(String(f.title ?? ""));
  if (!s) { unmatched.push(String(f.title)); continue; }
  const a = auditPrices(f, s.blob);
  const srcVals = new Set(pricesIn(s.blob).map(v => v.replace(/[^\d.]/g, "")));
  const shown = new Set(pricesIn(JSON.stringify(f)).map(v => v.replace(/[^\d.]/g, "")));
  const missing = [...srcVals].filter(v => !shown.has(v));
  if (missing.length) lostVals += missing.length;
  if (!a.ok || missing.length) {
    priceFail++;
    console.log(`\n  !! ${f.title}`);
    if (a.unsupported.length)       console.log(`     shows values NOT in its source : ${JSON.stringify(a.unsupported)}`);
    if (a.unsupportedRanges.length) console.log(`     shows RANGES not in its source : ${JSON.stringify(a.unsupportedRanges)}`);
    if (missing.length)             console.log(`     source values NOT shown        : ${missing.length} (${missing.slice(0,8).join(", ")})`);
  }
  if (String(f.description ?? "").trim().length < 40 || !(f.details ?? []).length) thin.push(String(f.title));
}
console.log(`\n${"=".repeat(70)}`);
console.log(`communities failing the price audit : ${priceFail}/${final.length}`);
console.log(`source dollar values not shown      : ${lostVals}`);
console.log(`records unmatched to a source row   : ${unmatched.length} ${unmatched.length ? JSON.stringify(unmatched) : ""}`);
console.log(`records with thin description/details: ${thin.length} ${thin.length ? JSON.stringify(thin) : ""}`);
console.log(`with photos ${final.filter(f=>(f.photos??[]).length).length}  contacts ${final.filter(f=>(f.contacts??[]).length).length}  links ${final.filter(f=>(f.links??[]).length).length}`);
