// READ ONLY. Scores my structural predictors against the professional's own
// judgement of which entries came out wrong.
//
// The point is not to be right. It is to find where a predictor is BLIND, since
// that is what the traced rerun has to cover.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
// The professional's verdicts, verbatim from their review.
const BAD = ["Cogir of Vallejo Hills", "Varenna at Fountaingrove", "Mountain View Assisted Living",
  "Villa Capri", "Pine Ridge Terrace", "The Vincent", "Oakmont Gardens",
  "The Bluffs at Hamilton Hills", "Atria Tamalpais Creek", "The Redwoods", "Enso Village"];
const GOOD = ["Solstice Senior Living", "AlmaVia of San Rafael", "Aegis Living San Rafael",
  "Bello Gardens", "Clearwater at Sonoma Hills", "Valley Orchards Retirement Community",
  "Creekwood Senior Home", "Aegis Living Napa", "The Ridge at Healdsburg", "Solano Life House"];
const UNSURE = ["Friends House", "Tamalpais Marin"];

type E = { title: string; notes: string | null; details: { label?: string }[] | null; created_at: string };
const bulk = (await rows<E>("library", svc.from("library_items").select("title, notes, details, created_at")))
  .filter((e) => e.created_at.startsWith("2026-08-20T02"));
const find = (n: string) => bulk.find((e) => e.title.toLowerCase().includes(n.toLowerCase().slice(0, 22)));

const COLUMNS = ["Type", "Capacity", "Community Fee", "Second Person Fee", "Care Costs", "Pet Fee"];
const columnScan = (e: E) => COLUMNS.some((c) =>
  !(e.details ?? []).some((d) => String(d?.label ?? "").trim().toLowerCase() === c.toLowerCase()) &&
  new RegExp(`(^|\\n|\\s)${c.replace(/ /g, "\\s")}\\s*:`, "i").test(String(e.notes ?? "")));
const hasNote = (e: E) => Boolean((e.notes ?? "").trim());

const score = (label: string, pred: (e: E) => boolean) => {
  const tp = BAD.filter((n) => { const e = find(n); return e && pred(e); }).length;
  const fn = BAD.filter((n) => { const e = find(n); return e && !pred(e); });
  const fp = GOOD.filter((n) => { const e = find(n); return e && pred(e); });
  console.log(`\n  ${label}`);
  console.log(`    caught ${tp}/${BAD.length} known-bad     flagged ${fp.length}/${GOOD.length} known-good`);
  if (fn.length) console.log(`    MISSED: ${fn.join(", ")}`);
  if (fp.length) console.log(`    flagged a good one: ${fp.join(", ")}`);
};

console.log(`\nPREDICTOR SCORING against the professional's review`);
console.log(`  known-bad ${BAD.length}   known-good ${GOOD.length}   unsure ${UNSURE.length}`);
const missing = [...BAD, ...GOOD, ...UNSURE].filter((n) => !find(n));
if (missing.length) console.log(`  NOT FOUND in the bulk cohort: ${missing.join(", ")}`);
score("column scan  — a known column sits only in notes", columnScan);
score("note present — the entry has ANY private note at all", hasNote);

console.log(`\n  THE UNSURE TWO — did the source actually carry pricing?`);
for (const n of UNSURE) { const e = find(n); if (e) console.log(`    ${e.title.padEnd(34)} note: ${e.notes ? `"${String(e.notes).slice(0, 60)}"` : "none"}`); }
console.log("");
