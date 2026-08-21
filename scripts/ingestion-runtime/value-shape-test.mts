// READ ONLY. Does the VALUE's shape decide where a labelled fact lands?
//
// Creekwood forced this question. Two adjacent lines in one source cell:
//   Community Fee: $2,500                                   -> details
//   Care Costs: Prices are all-inclusive (care costs …)      -> private note
// Same cell, same label shape, one line apart, opposite destinations. Host cell,
// chunk boundary, line wrapping and narrative ambiguity are all eliminated by
// that single pair. What remains is the value: a scalar versus a sentence.
import { svc, errText } from "./lib.mts";
import { readFileSync } from "node:fs";
const SRC = JSON.parse(readFileSync("/tmp/source-rows.json", "utf8")) as
  { name: string; contact: string; pricing: string }[];
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type E = { title: string; notes: string | null; details: { label?: string; value?: string }[] | null; created_at: string };
const bulk = (await rows<E>("library", svc.from("library_items").select("title, notes, details, created_at")))
  .filter((e) => e.created_at.startsWith("2026-08-20T02"));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const byName = new Map(bulk.map((e) => [norm(e.title), e]));

/** SCALAR: a bare amount or short enumeration. PROSE: a sentence — it has a verb
 *  or reads as a clause rather than a quantity. Deliberately crude and stated
 *  out loud, because the whole claim rests on this split being honest. */
function valueShape(v: string): "scalar" | "prose" {
  const t = v.trim();
  if (/\b(is|are|was|were|based on|included|depends|varies|available|required|equal to|starting at|additional|reflects|listed|will change)\b/i.test(t)) return "prose";
  if (t.split(/\s+/).length > 6) return "prose";
  return "scalar";
}

const LABEL_LINE = /^\s*([A-Z][A-Za-z0-9 /&()'’-]{2,44}):\s*(\S.*)$/;
const tally: Record<string, { detail: number; notes: number; missing: number }> = {
  scalar: { detail: 0, notes: 0, missing: 0 }, prose: { detail: 0, notes: 0, missing: 0 },
};
const proseToDetail: string[] = [];
const scalarToNotes: string[] = [];

for (const s of SRC) {
  const e = byName.get(norm(s.name));
  if (!e) continue;
  for (const cell of [s.contact, s.pricing]) {
    for (const line of cell.split("\n")) {
      const m = LABEL_LINE.exec(line.trim());
      if (!m) continue;
      const [, label, value] = m;
      // Labels whose correct destination is CONTACTS or LINKS, not details.
      // The first version of this test counted them as "missing" and produced a
      // 65% miss rate for scalars that meant nothing at all.
      if (/^(picture|community name|city)\b/i.test(label)) continue;
      if (/^(community phone|contact name|contact title|cell phone|email address|existing website|phone|email|website|address)\b/i.test(label)) continue;
      const shape = valueShape(value);
      const inDetail = (e.details ?? []).some((d) =>
        String(d?.label ?? "").trim().toLowerCase().startsWith(label.trim().toLowerCase().slice(0, 12)));
      const inNotes = new RegExp(label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "i")
        .test(String(e.notes ?? ""));
      if (inDetail) { tally[shape].detail++; if (shape === "prose") proseToDetail.push(`${e.title}: ${label}`); }
      else if (inNotes) { tally[shape].notes++; if (shape === "scalar") scalarToNotes.push(`${e.title}: ${label}`); }
      else tally[shape].missing++;
    }
  }
}
const pct = (a: number, b: number) => (b ? `${Math.round(a / b * 100)}%`.padStart(4) : "   —");
console.log(`\nDOES THE VALUE'S SHAPE DECIDE THE DESTINATION?\n`);
console.log(`  value shape   facts   -> detail   notes   missing`);
for (const k of ["scalar", "prose"] as const) {
  const t = tally[k], n = t.detail + t.notes + t.missing;
  console.log(`  ${k.padEnd(12)} ${String(n).padStart(5)}   -> ${pct(t.detail, n)}    ${pct(t.notes, n)}    ${pct(t.missing, n)}`);
}
console.log(`\n  counter-examples matter more than the headline:`);
console.log(`    PROSE values that still became a detail : ${proseToDetail.length}`);
for (const x of proseToDetail.slice(0, 6)) console.log(`      ${x}`);
console.log(`    SCALAR values that went to notes ....... ${scalarToNotes.length}`);
for (const x of scalarToNotes.slice(0, 6)) console.log(`      ${x}`);
console.log("");
