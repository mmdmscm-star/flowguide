// STEP 2 GATE, v2. Replays claim extraction, STRUCTURAL record attribution and
// the precedence ladder over the preserved run 1 / run 2 evidence.
// No production change, no model calls.
//
// Accounting identities asserted end-to-end:
//   detected   = attributed + attribution_unresolved
//   attributed = accepted + repaired + content_unresolved
import { readFileSync } from "node:fs";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll } from "../../src/lib/attribution.ts";
import { reconcile } from "../../src/lib/reconcile.ts";

const PASTE = readFileSync("diagnostic-paste.txt", "utf8");
const runs = [1, 2].map((n) => JSON.parse(readFileSync(`/tmp/diag-run${n}.json`, "utf8")));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const ENV = recordEnvelopes(PASTE);
if (!ENV) { console.error("source is not structurally a table — attribution unavailable"); process.exit(1); }

type Row = { record: number; name: string; title: string; counts: any; res: any[]; orphaned: any[] };
function analyse(run: any) {
  const rows: Row[] = [];
  let detected = 0, attributed = 0, attrUnresolved = 0;
  const proposalsByRecord = new Map<number, any>();
  for (const p of run.proposals) {
    const e = ENV!.find((x) => norm(x.name).startsWith(norm(String(p.payload?.title ?? "")).slice(0, 12))
                            || norm(String(p.payload?.title ?? "")).startsWith(norm(x.name).slice(0, 12)));
    if (e) proposalsByRecord.set(e.index, p.payload);
  }
  for (const c of run.chunks) {
    if (c.status !== "completed" || !c.segment_text) continue;
    const parsed = parseClaims(c.segment_text, c.ordinal);
    detected += parsed.claims.length + parsed.ambiguous.length;
    const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, ENV, c.source_start ?? 0);
    attrUnresolved += a.unattributedClaims.length + a.unattributedAmbiguous.length;
    for (const [rec, group] of a.byRecord) {
      attributed += group.claims.length + group.ambiguous.length;
      const item = proposalsByRecord.get(rec) ?? null;
      // A record the model never produced an item for: its claims are not
      // dropped, they are ATTRIBUTION_UNRESOLVED against a missing proposal.
      const r = reconcile({ claims: group.claims, ambiguous: group.ambiguous, fragments: group.fragments }, item);
      rows.push({ record: rec, name: ENV![rec].name, title: String(item?.title ?? "(no proposal)"),
                  counts: r.counts, res: r.resolutions, orphaned: r.orphaned });
    }
  }
  return { rows, detected, attributed, attrUnresolved };
}

const A = analyse(runs[0]), B = analyse(runs[1]);
console.log(`\n${"=".repeat(74)}\nSTEP 2 GATE — offline replay with structural attribution\n${"=".repeat(74)}`);
console.log(`  record envelopes from seg-v4 detectSourceRecords: ${ENV.length}\n`);

for (const [n, X] of [[1, A], [2, B]] as const) {
  const acc = X.rows.reduce((t, r) => t + r.counts.accepted, 0);
  const rep = X.rows.reduce((t, r) => t + r.counts.repaired, 0);
  const cun = X.rows.reduce((t, r) => t + r.counts.unresolved, 0);
  const sun = X.rows.reduce((t, r) => t + r.counts.sourceUnresolved, 0);
  console.log(`  RUN ${n}`);
  console.log(`    recognized source units ..... ${X.detected}`);
  console.log(`    attributed .................. ${X.attributed}`);
  console.log(`    ATTRIBUTION_UNRESOLVED ...... ${X.attrUnresolved}`);
  console.log(`      identity 1: detected = attributed + attribution_unresolved  -> ${X.detected === X.attributed + X.attrUnresolved}`);
  console.log(`    ACCEPTED .................... ${acc}`);
  console.log(`    REPAIRED .................... ${rep}`);
  console.log(`    CONTENT_UNRESOLVED .......... ${cun}`);
  console.log(`    SOURCE_UNRESOLVED ........... ${sun}   (recognized, pairing not provable)`);
  console.log(`      identity 2: attributed = accepted + repaired + content_unresolved + source_unresolved -> ${X.attributed === acc + rep + cun + sun}`);
  console.log(`    UNACCOUNTED ................. ${X.detected - X.attrUnresolved - acc - rep - cun - sun}\n`);
}

// ---- run-to-run agreement under the contract --------------------------------
const key = (r: any) => `${r.label ?? ""}|${r.value}`;
const enforced = (X: typeof A, rec: number) => {
  const m = new Map<string, string>();
  for (const row of X.rows) if (row.record === rec) for (const r of row.res) m.set(key(r), r.want ?? "UNRESOLVED");
  return m;
};
const observed = (X: typeof A, rec: number) => {
  const m = new Map<string, string>();
  for (const row of X.rows) if (row.record === rec) for (const r of row.res) m.set(key(r), r.found.length ? r.found.join("+") : "absent");
  return m;
};
let before = 0, after = 0, compared = 0;
for (const e of ENV) {
  const oa = observed(A, e.index), ob = observed(B, e.index), ea = enforced(A, e.index), eb = enforced(B, e.index);
  for (const k of new Set([...oa.keys(), ...ob.keys()])) {
    if (!oa.has(k) || !ob.has(k)) continue;
    compared++;
    if (oa.get(k) !== ob.get(k)) before++;
    if (ea.get(k) !== eb.get(k)) after++;
  }
}
console.log(`  RUN-TO-RUN AGREEMENT (n=${compared})   as the model left it: ${before} disagree   under the contract: ${after} disagree`);

// ---- what is still held, and exactly why ------------------------------------
const held = A.rows.filter((r) => r.counts.unresolved > 0 || r.counts.sourceUnresolved > 0 || r.orphaned.length > 0);
console.log(`\n  HELD FOR REVIEW: ${held.length} of ${ENV.length} records (run 1)`);
const why: Record<string, number> = {};
for (const r of held) {
  for (const x of r.res.filter((y: any) => y.outcome === "CONTENT_UNRESOLVED" || y.outcome === "SOURCE_UNRESOLVED"))
    why[`${x.outcome}: ${x.why}`] = (why[`${x.outcome}: ${x.why}`] ?? 0) + 1;
  for (const f of r.orphaned) why[`fragment: ${f.reason}`] = (why[`fragment: ${f.reason}`] ?? 0) + 1;
}
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}×  ${k}`);
console.log(`\n  records held, by name:`);
for (const r of held) console.log(`    ${r.name.slice(0, 40).padEnd(42)} unresolved=${r.counts.unresolved} orphaned=${r.orphaned.length}`);

// ---- pricing claim class: precision / recall --------------------------------
let pClaims = 0, pAmbig = 0;
for (const c of runs[0].chunks) {
  if (c.status !== "completed" || !c.segment_text) continue;
  const p = parseClaims(c.segment_text, c.ordinal);
  pClaims += p.claims.filter((x) => x.kind === "pricing").length;
  pAmbig += p.ambiguous.length;
}
const pAcc = A.rows.reduce((t, r) => t + r.res.filter((x: any) => x.why?.startsWith("pricing anchors agree")).length, 0);
const pRep = A.rows.reduce((t, r) => t + r.res.filter((x: any) => x.why === "priced fact not found in the proposal").length, 0);
console.log(`\n  UNLABELLED PRICING CLAIM CLASS (run 1)`);
console.log(`    claimed (confident) ......... ${pClaims}`);
console.log(`    declined as ambiguous ....... ${pAmbig}`);
console.log(`    of the claimed: matched in the proposal ${pAcc}, not found ${pRep}`);
console.log(`    match rate .................. ${pClaims ? (pAcc / (pAcc + pRep) * 100).toFixed(1) : "—"}%`);
console.log("");

// ---- RECALL GATE ------------------------------------------------------------
// Accounting completeness is silent about a claim never detected, so recall is
// measured directly against the source: every explicit `Label: value` line in
// the 20 records must be claimed.
const SRC = JSON.parse(readFileSync("/tmp/diag-source.json", "utf8")) as { name: string; cells: string[] }[];
const LABEL_LINE = /^\s*[-•*]?\s*([A-Za-z0-9][A-Za-z0-9 /&()'’.+-]{0,47}):\s*(\S.*)$/;
let expected = 0, claimed = 0;
const missed: string[] = [];
for (const rec of SRC) {
  const got = new Set(parseClaims(rec.cells.join("\t")).claims
    .filter((c) => c.kind === "labelled").map((c) => c.label));
  for (const cell of rec.cells.slice(2, 4))
    for (const line of String(cell ?? "").split("\n")) {
      const m = LABEL_LINE.exec(line.trim());
      if (!m || /^picture\b/i.test(m[1]) || /^https?$/i.test(m[1]) || /^\s*https?:\/\//i.test(line)) continue;
      expected++;
      if (got.has(m[1].trim())) claimed++;
      else if (missed.length < 10) missed.push(`${rec.name} · ${m[1]}`);
    }
}
console.log(`  RECALL on explicit Label: value lines in the 20-record source`);
console.log(`    ${claimed}/${expected} = ${(claimed / expected * 100).toFixed(1)}%${missed.length ? "   MISSED: " + missed.join(", ") : ""}`);
console.log("");
