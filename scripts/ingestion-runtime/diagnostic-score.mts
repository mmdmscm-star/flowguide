// Scores the traced diagnostic. Four-way comparison, per fact:
//
//   spreadsheet cell  ->  historical Library entry  ->  run 1 proposal  ->  run 2 proposal
//
// PLACEMENT and CONTENT are scored separately on purpose. A fact that reached
// the output intact but in the wrong field is a different defect from one that
// never arrived, and mixing them produces a number that cannot be acted on.
import { readFileSync } from "node:fs";
import { svc, errText } from "./lib.mts";
import { locate, isRecipientVisible, type Field } from "../../src/lib/placement.ts";
import { probe, squash } from "../../src/lib/fact-match.ts";

type Run = { n: number; runId: string; chunks: any[]; proposals: any[] };
const runs: Run[] = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
const SRC = JSON.parse(readFileSync("/tmp/diag-source.json", "utf8")) as
  { row: number; name: string; cells: string[] }[];

async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
const hist = (await rows<any>("library", svc.from("library_items")
  .select("title, address, description, notes, details, links, photos, contacts, created_at")))
  .filter((e) => String(e.created_at).startsWith("2026-08-20T02"));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = <T extends { title?: string; payload?: any }>(list: T[], name: string) => {
  const key = norm(name);
  return list.find((x) => {
    const t = norm(String((x as any).title ?? (x as any).payload?.title ?? ""));
    return t === key || t.startsWith(key.slice(0, 14)) || key.startsWith(t.slice(0, 14));
  });
};

/** Labelled facts in the source cells. */
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z0-9 /&()'’.+-]{1,44}):\s*(\S.*)$/;
const CONTACT_LABEL = /^(community phone|contact name|contact title|cell phone|email address|existing website|phone|email|website)\b/i;
type Fact = { label: string; value: string; contactish: boolean };
function factsOf(cells: string[]): Fact[] {
  const out: Fact[] = [];
  for (const cell of cells.slice(2, 4))                    // Contact Information, Profile & Pricing
    for (const line of String(cell ?? "").split("\n")) {
      const m = LABEL_LINE.exec(line.trim());
      if (!m) continue;
      const label = m[1].trim(), value = m[2].trim();
      if (/^picture\b/i.test(label)) continue;
      out.push({ label, value, contactish: CONTACT_LABEL.test(label) });
    }
  return out;
}

const where = (item: any, value: string): Field[] => (item ? locate(item, value) : []);
const dest = (f: Field[]) => (f.length === 0 ? "ABSENT" : f.includes("details") ? "details"
  : f.includes("notes") ? "notes" : f[0]);

console.log(`\n${"=".repeat(74)}\nTRACED DIAGNOSTIC — placement, four-way\n${"=".repeat(74)}`);
console.log(`  run 1 ${runs[0].runId}   ${runs[0].chunks.length} chunks  ${runs[0].proposals.length} proposals`);
console.log(`  run 2 ${runs[1].runId}   ${runs[1].chunks.length} chunks  ${runs[1].proposals.length} proposals\n`);

const tally = { hist: { details: 0, notes: 0, other: 0, absent: 0 },
                r1: { details: 0, notes: 0, other: 0, absent: 0 },
                r2: { details: 0, notes: 0, other: 0, absent: 0 } };
const flips: string[] = [];
const perRecord: { name: string; facts: number; h: string; a: string; b: string; changed: number }[] = [];

for (const s of SRC) {
  const facts = factsOf(s.cells).filter((f) => !f.contactish);
  if (!facts.length) { perRecord.push({ name: s.name, facts: 0, h: "—", a: "—", b: "—", changed: 0 }); continue; }
  const H = pick(hist, s.name);
  const A = pick(runs[0].proposals, s.name)?.payload;
  const B = pick(runs[1].proposals, s.name)?.payload;
  let cH = { d: 0, n: 0 }, cA = { d: 0, n: 0 }, cB = { d: 0, n: 0 }, changed = 0;
  for (const f of facts) {
    const dh = dest(where(H, f.value)), da = dest(where(A, f.value)), db = dest(where(B, f.value));
    for (const [k, d] of [["hist", dh], ["r1", da], ["r2", db]] as const) {
      const t = tally[k as "hist"];
      if (d === "details") t.details++; else if (d === "notes") t.notes++;
      else if (d === "ABSENT") t.absent++; else t.other++;
    }
    if (dh === "details") cH.d++; else if (dh === "notes") cH.n++;
    if (da === "details") cA.d++; else if (da === "notes") cA.n++;
    if (db === "details") cB.d++; else if (db === "notes") cB.n++;
    if (da !== db) { changed++; flips.push(`${s.name} · ${f.label}: run1=${da}  run2=${db}`); }
  }
  perRecord.push({ name: s.name, facts: facts.length,
    h: `${cH.d}d/${cH.n}n`, a: `${cA.d}d/${cA.n}n`, b: `${cB.d}d/${cB.n}n`, changed });
}

const pct = (a: number, t: number) => (t ? `${Math.round(a / t * 100)}%`.padStart(4) : "   —");
console.log(`  AGGREGATE PLACEMENT of labelled non-contact facts`);
console.log(`                    details   notes   elsewhere   absent`);
for (const [k, label] of [["hist", "historical"], ["r1", "run 1     "], ["r2", "run 2     "]] as const) {
  const t = tally[k as "hist"], n = t.details + t.notes + t.other + t.absent;
  console.log(`  ${label}   ${pct(t.details, n)}    ${pct(t.notes, n)}     ${pct(t.other, n)}      ${pct(t.absent, n)}     (n=${n})`);
}

console.log(`\n  RUN-TO-RUN STABILITY — same paste, same code, same record`);
console.log(`    facts whose destination CHANGED between run 1 and run 2: ${flips.length}`);
for (const f of flips.slice(0, 25)) console.log(`      ${f}`);
if (flips.length > 25) console.log(`      …and ${flips.length - 25} more`);

console.log(`\n  PER RECORD   (d=details n=notes, of labelled non-contact facts)`);
console.log(`    ${"record".padEnd(44)} facts   hist     run1     run2   changed`);
for (const r of perRecord)
  console.log(`    ${r.name.slice(0, 42).padEnd(44)} ${String(r.facts).padStart(5)}   ${r.h.padEnd(8)} ${r.a.padEnd(8)} ${r.b.padEnd(7)} ${r.changed || ""}`);
console.log("");
