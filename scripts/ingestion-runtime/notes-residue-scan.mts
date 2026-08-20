// READ ONLY. Does this entry's private note contain FACTS ABOUT THE COMMUNITY,
// or professional commentary about a client?
//
// The distinction is the user's, and it is sharper than "did a known column end
// up in notes":
//
//   FACT      "Pet deposit: $1,000"  ·  "Respite … 14-day minimum - $250/day"
//             Reusable, true of the community regardless of who is being helped.
//             Belongs with the other pricing/community details.
//
//   COMMENTARY "five minutes closer to the family's home and closer to Lynn's
//             doctor" — true only for THIS client, and therefore not reusable
//             at all.
//
// The earlier column scan could not see this. Mountain View has ten well-formed
// details and reads as clean by that measure, while its note carries four prices
// the professional wants in the Library. Three blind spots caused that miss and
// are corrected here: label VARIANTS ("Community Fee AL" is a Community Fee),
// QUALIFIED labels inside notes ("Second person fee (relative only):"), and
// PROSE facts with no label shape at all.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type E = { id: string; title: string; notes: string | null; details: { label?: string }[] | null; created_at: string };
const every = await rows<E>("library", svc.from("library_items").select("id, title, notes, details, created_at").order("created_at"));
const bulk = every.filter((e) => e.created_at.startsWith("2026-08-20T02"));

const MONEY = /\$\s?[\d,]+/g;
const QUANT = /\b\d+[- ]?(?:day|days|month|months|year|years|bed|beds|resident|residents|hour|hours|night|nights)\b/gi;
const KVISH = /(^|[.;]\s*)([A-Z][A-Za-z0-9 /&()'’-]{2,44}):\s*\S/g;
// Words that mark commentary ABOUT A CLIENT rather than about the community.
const CONTEXTUAL = /\b(family|families|daughter|son|husband|wife|mother|father|client|closer to|prefers|preferred|doctor|physician|drive|minutes from|for (?:her|him|them)|she |he )\b/i;

type Row = { title: string; money: number; quant: number; kvish: number; contextual: boolean; note: string };
const noted: Row[] = bulk.filter((e) => (e.notes ?? "").trim()).map((e) => {
  const n = String(e.notes);
  return {
    title: e.title, note: n,
    money: (n.match(MONEY) ?? []).length,
    quant: (n.match(QUANT) ?? []).length,
    kvish: [...n.matchAll(KVISH)].length,
    contextual: CONTEXTUAL.test(n),
  };
});
const factual = noted.filter((r) => r.money + r.quant + r.kvish > 0);
const commentary = noted.filter((r) => r.money + r.quant + r.kvish === 0);

console.log(`\nPRIVATE NOTES IN THE 61-RECORD IMPORT\n`);
console.log(`  entries with a note ....................... ${noted.length}/${bulk.length}`);
console.log(`  notes with a PRICED or LABELLED fact ...... ${factual.length}`);
console.log(`  notes with a fact but no number ........... ${commentary.length}`);
console.log(`  notes containing CLIENT CONTEXT ........... ${noted.filter((r) => r.contextual).length}   <- what a private note is FOR`);

console.log(`\n  FACTUAL RESIDUE, worst first  (money / quantities / label-shaped)`);
for (const r of factual.sort((a, b) => (b.money + b.quant + b.kvish) - (a.money + a.quant + a.kvish))) {
  console.log(`    ${r.title.slice(0, 42).padEnd(44)} $${String(r.money).padStart(2)}  q${String(r.quant).padStart(2)}  kv${String(r.kvish).padStart(2)}`);
  console.log(`        ${r.note.replace(/\s+/g, " ").slice(0, 150)}${r.note.length > 150 ? "…" : ""}`);
}
if (commentary.length) {
  // NOT commentary. Reading them shows they are still facts about the
  // community — "Formerly called Nazareth Classic Care", "Not yet licensed",
  // "CCRC (entrance fee + monthly fee)" — they simply carry no digits, which is
  // all my numeric test could ever have told me. Naming this bucket "candidate
  // true private notes" would have been the classifier flattering itself.
  console.log(`\n  NOTES WITH NO NUMBER (still community facts, not client context)`);
  for (const r of commentary) console.log(`    ${r.title.slice(0, 42).padEnd(44)} ${r.note.replace(/\s+/g, " ").slice(0, 110)}`);
}
console.log("");
