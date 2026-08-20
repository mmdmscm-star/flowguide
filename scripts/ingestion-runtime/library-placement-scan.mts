// READ ONLY. For each recurring spreadsheet-style column, did this entry get it
// as a DETAIL (recipient sees it) or swept into NOTES (recipient never does)?
//
// The columns are not guessed: they are the labels that recur across many
// entries, which is what a spreadsheet column looks like from the output side.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type E = { id: string; title: string; notes: string | null; details: { label?: string; value?: string }[] | null; created_at: string };
const every = await rows<E>("library", svc.from("library_items").select("id, title, notes, details, created_at").order("created_at"));

// COHORT SPLIT, established from creation history rather than from titles (see
// library-provenance.mts). The 65 entries are two separate imports: a 4-record
// run on 2026-08-19T20:29, and the 61-record bulk run on 2026-08-20T02:30. Only
// the second describes the failure under investigation, so anything claiming to
// characterise "the 61-community import" must exclude the earlier four.
const BULK_CLUSTER = "2026-08-20T02";
const all = every.filter((e) => e.created_at.startsWith(BULK_CLUSTER));
const priorRun = every.filter((e) => !e.created_at.startsWith(BULK_CLUSTER));
console.log(`\nCOHORTS — ${every.length} entries total`);
console.log(`  bulk import (2026-08-20T02:30) ...... ${all.length}   <- the run under investigation`);
console.log(`  earlier 4-record import (20:29) ..... ${priorRun.length}   ${priorRun.map((e) => e.title).join(", ")}`);
console.log(`  EXCLUDED from every figure below: the earlier four.`);
const arr = (v: unknown[] | null) => (Array.isArray(v) ? v : []);

// Duplicate / near-duplicate titles — 61 communities produced 65 entries.
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const byTitle = new Map<string, string[]>();
for (const e of all) { const k = norm(e.title); byTitle.set(k, [...(byTitle.get(k) ?? []), e.title]); }
const dupes = [...byTitle.entries()].filter(([, v]) => v.length > 1);
console.log(`\nENTRY COUNT — ${all.length} entries`);
console.log(`  exact/normalised duplicate titles: ${dupes.length}`);
for (const [, v] of dupes) console.log(`    ${v.join("  |  ")}`);

const COLUMNS = ["Type", "Capacity", "Community Fee", "Second Person Fee", "Care Costs", "Pet Fee"];
const hasDetail = (e: E, col: string) =>
  arr(e.details).some((d) => String((d as { label?: string })?.label ?? "").trim().toLowerCase() === col.toLowerCase());
const inNotes = (e: E, col: string) =>
  new RegExp(`(^|\\n|\\s)${col.replace(/ /g, "\\s")}\\s*:`, "i").test(String(e.notes ?? ""));

console.log(`\nPLACEMENT PER RECURRING COLUMN`);
console.log(`  column               as detail   in notes   neither`);
for (const c of COLUMNS) {
  const d = all.filter((e) => hasDetail(e, c)).length;
  const n = all.filter((e) => !hasDetail(e, c) && inNotes(e, c)).length;
  console.log(`  ${c.padEnd(20)} ${String(d).padStart(7)}   ${String(n).padStart(8)}   ${String(all.length - d - n).padStart(7)}`);
}

// The entries where a recurring column exists ONLY in the private note.
const suspect = all
  .map((e) => ({ e, cols: COLUMNS.filter((c) => !hasDetail(e, c) && inNotes(e, c)) }))
  .filter((x) => x.cols.length > 0)
  .sort((a, b) => b.cols.length - a.cols.length);

console.log(`\nENTRIES WHERE A RECURRING COLUMN IS ONLY IN THE PRIVATE NOTE — ${suspect.length} of ${all.length}`);
console.log(`(prediction: these are the ones a professional would call wrong or partial)\n`);
for (const { e, cols } of suspect)
  console.log(`  ${e.title.slice(0, 44).padEnd(46)} ${cols.join(", ")}`);

const clean = all.filter((e) => !suspect.some((s) => s.e.id === e.id) && COLUMNS.slice(0, 2).every((c) => hasDetail(e, c)));
console.log(`\nCANDIDATE CONTROLS — Type and Capacity both as details, nothing hidden in notes: ${clean.length}`);
for (const e of clean.slice(0, 12)) console.log(`  ${e.title}`);
console.log("");
