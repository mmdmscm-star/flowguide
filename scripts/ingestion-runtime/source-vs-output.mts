// READ ONLY, both sides. Joins the spreadsheet (source truth) to the surviving
// 61 bulk-import entries (historical output) and asks one question:
//
//   does a Label whose VALUE is split across a newline in the source cell get
//   misplaced more often than a Label whose value sits on the same line?
//
// The spreadsheet is never written. The Library is never written.
import { svc, errText } from "./lib.mts";
import { readFileSync } from "node:fs";
const SRC = JSON.parse(readFileSync(process.env.SRC ?? "/tmp/source-rows.json", "utf8")) as
  { name: string; contact: string; pricing: string }[];

async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type E = { title: string; notes: string | null; details: { label?: string; value?: string }[] | null; created_at: string };
const bulk = (await rows<E>("library", svc.from("library_items").select("title, notes, details, created_at")))
  .filter((e) => e.created_at.startsWith("2026-08-20T02"));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const byName = new Map(bulk.map((e) => [norm(e.title), e]));

const LABELS = ["Type", "Capacity", "Community Fee", "Second Person Fee", "Care Costs", "Pet Fee"];

/** Is this label's value split across a line break in the source cell? */
function splitValue(cell: string, label: string): "same-line" | "split" | "absent" {
  const lines = cell.split("\n");
  const re = new RegExp(`^\\s*${label.replace(/ /g, "\\s*")}\\s*:`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const after = lines[i].replace(re, "").trim();
    if (!after) return "split";                       // value entirely on the next line
    // A value that ends mid-clause continues onto the following line.
    if (/[,;]$|\b(for|of|to|and|the|based on|than)$/i.test(after)) return "split";
    return "same-line";
  }
  return "absent";
}

const tally: Record<string, Record<string, { detail: number; notes: number; missing: number }>> = {};
let matched = 0;
for (const s of SRC) {
  const e = byName.get(norm(s.name));
  if (!e) continue;
  matched++;
  for (const L of LABELS) {
    // WHICH CELL did this label come from? Contact Information is a short,
    // homogeneous run of `Label: value` lines. Community Profile & Pricing is a
    // long heterogeneous block that opens with a repeat of the name, address,
    // phone and URL, then mixes prose room lists with label lines.
    const inContact = splitValue(s.contact, L) !== "absent";
    const cell = inContact ? s.contact : s.pricing;
    const shape = splitValue(cell, L);
    if (shape === "absent") continue;
    const origin = inContact ? "C:contact" : "D:pricing";
    void origin;
    const inDetail = (e.details ?? []).some((d) => String(d?.label ?? "").trim().toLowerCase().startsWith(L.toLowerCase()));
    const inNotes = new RegExp(`${L.replace(/ /g, "\\s*")}\\s*:`, "i").test(String(e.notes ?? ""));
    tally[L] ??= {};
    tally[L][origin] ??= { detail: 0, notes: 0, missing: 0 };
    const bucket = tally[L][origin];
    tally[L][shape] ??= { detail: 0, notes: 0, missing: 0 };
    if (inDetail) { tally[L][shape].detail++; bucket.detail++; }
    else if (inNotes) { tally[L][shape].notes++; bucket.notes++; }
    else { tally[L][shape].missing++; bucket.missing++; }
  }
}

console.log(`\nSOURCE SHAPE vs OUTPUT PLACEMENT   (${matched}/${SRC.length} source rows joined to a bulk entry)\n`);
console.log(`  label              source shape   -> detail   notes   missing`);
let sameD = 0, sameN = 0, sameM = 0, splD = 0, splN = 0, splM = 0;
for (const L of LABELS) {
  for (const shape of ["same-line", "split"] as const) {
    const t = tally[L]?.[shape];
    if (!t) continue;
    console.log(`  ${L.padEnd(18)} ${shape.padEnd(14)} ->${String(t.detail).padStart(7)}${String(t.notes).padStart(8)}${String(t.missing).padStart(10)}`);
    if (shape === "same-line") { sameD += t.detail; sameN += t.notes; sameM += t.missing; }
    else { splD += t.detail; splN += t.notes; splM += t.missing; }
  }
}
const pct = (a: number, b: number) => (b ? `${Math.round(a / b * 100)}%` : "—");
const sameT = sameD + sameN + sameM, splT = splD + splN + splM;
console.log(`\n  AGGREGATE`);
console.log(`    value on the SAME LINE as its label : ${sameT} facts -> ${pct(sameD, sameT)} became a detail, ${pct(sameN, sameT)} went to notes, ${pct(sameM, sameT)} vanished`);
console.log(`    value SPLIT across a newline ........ ${splT} facts -> ${pct(splD, splT)} became a detail, ${pct(splN, splT)} went to notes, ${pct(splM, splT)} vanished`);

// The comparison that matters: same fact shape, different host cell.
console.log(`\n  BY SOURCE CELL — where the label physically lived`);
const agg: Record<string, { detail: number; notes: number; missing: number }> = {};
for (const L of LABELS) for (const o of ["C:contact", "D:pricing"]) {
  const t = tally[L]?.[o]; if (!t) continue;
  agg[o] ??= { detail: 0, notes: 0, missing: 0 };
  agg[o].detail += t.detail; agg[o].notes += t.notes; agg[o].missing += t.missing;
  console.log(`    ${L.padEnd(18)} ${o.padEnd(11)} detail ${String(t.detail).padStart(3)}   notes ${String(t.notes).padStart(3)}   missing ${String(t.missing).padStart(3)}`);
}
console.log(`\n  AGGREGATE BY CELL`);
for (const [o, t] of Object.entries(agg)) {
  const tot = t.detail + t.notes + t.missing;
  console.log(`    ${o.padEnd(11)} ${String(tot).padStart(3)} facts -> ${pct(t.detail, tot).padStart(4)} detail   ${pct(t.notes, tot).padStart(4)} notes   ${pct(t.missing, tot).padStart(4)} missing`);
}
console.log("");
