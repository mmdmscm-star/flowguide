// STEP 2 GATE. Replays the claim parser and the precedence ladder over the
// PRESERVED run 1 / run 2 evidence. No production change, no model calls.
//
// It answers three questions:
//   1. does enforcement make two runs of identical input agree?
//   2. is every claim accounted for?
//   3. what does the parser DECLINE — reported by name, never hidden
import { readFileSync } from "node:fs";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { reconcile, blocksMaterialization } from "../../src/lib/reconcile.ts";

const runs = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// CLAIM -> RECORD ATTRIBUTION.
//
// A chunk usually holds more than one record. Reconciling every claim in the
// chunk against every item in it makes record A's facts look like orphans of
// record B, which inflated the first replay's orphan count roughly fivefold and
// made 19 of 20 proposals look unreviewable.
//
// The source is one record per tab-separated row, and every row opens with the
// community name — so a block that IS a known record name starts a new group.
// This is a real prerequisite of the layer, not an artefact of the replay: in
// production the same attribution must exist, and record boundaries are the
// model's judgement (Class C), so the layer has to consume them rather than
// re-derive them.
const NAMES: string[] = JSON.parse(readFileSync("/tmp/diag-source.json", "utf8")).map((r: any) => r.name);
function attribute(parsed: any, titles: string[]) {
  const groups: { name: string; claims: any[]; fragments: any[] }[] = [];
  let cur: { name: string; claims: any[]; fragments: any[] } | null = null;
  const all = [...parsed.claims.map((c: any) => ({ k: "c", line: c.line, v: c })),
               ...parsed.fragments.map((f: any) => ({ k: "f", line: f.line, v: f }))]
    .sort((a, b) => a.line - b.line);
  for (const e of all) {
    const text = e.k === "c" ? String(e.v.raw ?? "") : String(e.v.text ?? "");
    const hit = NAMES.find((n) => norm(text).startsWith(norm(n)) && norm(n).length > 8);
    if (hit && (!cur || cur.name !== hit)) { cur = { name: hit, claims: [], fragments: [] }; groups.push(cur); }
    if (!cur) { cur = { name: titles[0] ?? "", claims: [], fragments: [] }; groups.push(cur); }
    if (e.k === "c") cur.claims.push(e.v); else cur.fragments.push(e.v);
  }
  return groups;
}

type Row = { chunk: number; idx: number; title: string; counts: any; res: any[]; frags: any[] };
function analyse(run: any): Row[] {
  const out: Row[] = [];
  for (const c of run.chunks) {
    if (c.status !== "completed" || !c.segment_text) continue;
    const items = [...(c.result?.items ?? []), ...((c.result?.sections ?? []).flatMap((s: any) => s.items ?? []))];
    const parsed = parseClaims(c.segment_text, c.ordinal);
    const titles = items.map((it: any) => String(it?.title ?? ""));
    const groups = attribute(parsed, titles);
    for (const [i, item] of items.entries()) {
      const title = String((item as any).title ?? "");
      const g = groups.find((x) => norm(x.name).startsWith(norm(title).slice(0, 12))
                                || norm(title).startsWith(norm(x.name).slice(0, 12)))
             ?? (groups.length === 1 ? groups[0] : { claims: [], fragments: [] } as any);
      const r = reconcile({ claims: g.claims, fragments: g.fragments }, item as Record<string, unknown>);
      out.push({ chunk: c.ordinal, idx: i, title, counts: r.counts, res: r.resolutions, frags: r.orphaned });
    }
    if (!items.length) {
      const r = reconcile(parsed, null);
      out.push({ chunk: c.ordinal, idx: -1, title: "(no item)", counts: r.counts, res: r.resolutions, frags: r.fragments });
    }
  }
  return out;
}
const A = analyse(runs[0]), B = analyse(runs[1]);

// ---- accounting -------------------------------------------------------------
const sum = (rows: Row[]) => rows.reduce((t, r) => ({
  claims: t.claims + r.counts.claims, accepted: t.accepted + r.counts.accepted,
  repaired: t.repaired + r.counts.repaired, unresolved: t.unresolved + r.counts.unresolved,
  frags: t.frags + r.counts.fragments }), { claims: 0, accepted: 0, repaired: 0, unresolved: 0, frags: 0 });

console.log(`\n${"=".repeat(72)}\nSTEP 2 — OFFLINE RECONCILIATION REPLAY\n${"=".repeat(72)}`);
for (const [n, rows] of [[1, A], [2, B]] as const) {
  const s = sum(rows);
  console.log(`\n  run ${n}: ${s.claims} claims  ->  ${s.accepted} accepted, ${s.repaired} repaired, ${s.unresolved} unresolved`);
  console.log(`          identity holds: ${s.accepted + s.repaired + s.unresolved === s.claims}`);
  console.log(`          non-claim fragments declined: ${s.frags}  (of which ${rows.reduce((t, r) => t + r.counts.orphaned, 0)} appear NOWHERE in the item)`);
}

// ---- convergence: the question the design rests on --------------------------
// Enforcement means a claim's destination is decided by the CONTRACT, not by
// the model. So agreement is measured on the enforced destination.
const key = (r: any) => `${r.label ?? r.value}|${r.value}`;
const destOf = (rows: Row[], title: string) => {
  const m = new Map<string, string>();
  for (const row of rows) if (norm(row.title) === norm(title))
    for (const r of row.res) m.set(key(r), r.want ?? "UNRESOLVED");
  return m;
};
const observedOf = (rows: Row[], title: string) => {
  const m = new Map<string, string>();
  for (const row of rows) if (norm(row.title) === norm(title))
    for (const r of row.res) m.set(key(r), r.found.length ? r.found.join("+") : "absent");
  return m;
};
const titles = [...new Set([...A, ...B].map((r) => r.title).filter((t) => t && t !== "(no item)"))];
let beforeDisagree = 0, afterDisagree = 0, compared = 0;
const stillDiffer: string[] = [];
for (const t of titles) {
  const oa = observedOf(A, t), ob = observedOf(B, t);
  const ea = destOf(A, t), eb = destOf(B, t);
  for (const k of new Set([...oa.keys(), ...ob.keys()])) {
    if (!oa.has(k) || !ob.has(k)) continue;
    compared++;
    if (oa.get(k) !== ob.get(k)) beforeDisagree++;
    if (ea.get(k) !== eb.get(k)) { afterDisagree++; stillDiffer.push(`${t} · ${k.split("|")[0]}`); }
  }
}
console.log(`\n  RUN-TO-RUN AGREEMENT on claims present in both runs (n=${compared})`);
console.log(`    as the model left it ....... ${beforeDisagree} disagree`);
console.log(`    under the contract ......... ${afterDisagree} disagree`);
if (stillDiffer.length) for (const x of [...new Set(stillDiffer)].slice(0, 12)) console.log(`      ${x}`);

// ---- what the parser declines ----------------------------------------------
const reasons: Record<string, number> = {};
for (const r of A) for (const f of r.frags) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
console.log(`\n  WHAT THE PARSER DECLINES TO CLAIM  (run 1; reported, never hidden)`);
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}×  ${k}`);
const proseFrags = [...new Set(A.flatMap((r) => r.frags).filter((f) => f.reason === "prose appended to a labelled line").map((f) => f.text.slice(0, 88)))];
if (proseFrags.length) {
  console.log(`\n  PROSE SPLIT OFF A LABELLED LINE — these become UNRESOLVED:`);
  for (const f of proseFrags.slice(0, 6)) console.log(`    ${f}…`);
}
const blocked = A.filter((r) => r.counts.unresolved > 0 || r.counts.orphaned > 0);
console.log(`\n  MATERIALIZATION: ${blocked.length} of ${A.length} proposals would be held for review (run 1)`);
console.log("");


// ---- RECALL GATE ------------------------------------------------------------
// Accounting completeness says nothing about a claim never detected, so recall
// is measured directly against the source: every explicit `Label: value` line in
// the 20 records must be claimed by the parser.
import { readFileSync as rf } from "node:fs";
const SRC = JSON.parse(rf("/tmp/diag-source.json", "utf8")) as { name: string; cells: string[] }[];
const LABEL_LINE = /^\s*[-•*]?\s*([A-Za-z0-9][A-Za-z0-9 /&()'’.+-]{0,47}):\s*(\S.*)$/;
let expected = 0, claimed = 0;
const missed: string[] = [];
for (const rec of SRC) {
  const blob = rec.cells.join("\t");
  const got = new Set(parseClaims(blob).claims.filter((c) => c.kind === "labelled").map((c) => `${c.label}`));
  for (const cell of rec.cells.slice(2, 4))
    for (const line of String(cell ?? "").split("\n")) {
      const m = LABEL_LINE.exec(line.trim());
      // A URL is not a labelled line — the parser claims it as kind "url".
      // Counting it as a missed LABEL measures my regex, not the parser.
      if (!m || /^picture\b/i.test(m[1]) || /^https?$/i.test(m[1]) || /^\s*https?:\/\//i.test(line)) continue;
      expected++;
      if (got.has(m[1].trim())) claimed++;
      else if (missed.length < 12) missed.push(`${rec.name} · ${m[1]}: ${m[2].slice(0, 40)}`);
    }
}
console.log(`  RECALL on explicit Label: value lines in the 20-record source`);
console.log(`    ${claimed}/${expected} claimed  =  ${(claimed / expected * 100).toFixed(1)}%`);
if (missed.length) { console.log(`    MISSED:`); for (const m of missed) console.log(`      ${m}`); }
console.log("");
