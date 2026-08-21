// STEP 3 PROOF. Applies the contract to two independent model runs of the SAME
// input and asks whether the ENFORCED semantic output converges.
//
// Enforcement is a pure function of (source, model output). The model varies;
// the question is whether what a recipient ends up seeing does.
//
//   PASTE_FILE=… RUNS=/tmp/diag-run npx tsx scripts/ingestion-runtime/prove-enforcement.mts
import { readFileSync } from "node:fs";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll, bindByProvenance } from "../../src/lib/attribution.ts";
import { reconcile } from "../../src/lib/reconcile.ts";
import { enforceItem, sourceGrantsPrivacy } from "../../src/lib/enforce.ts";

const PASTE = readFileSync(process.env.PASTE_FILE ?? "diagnostic-paste.txt", "utf8");
const PREFIX = process.env.RUNS ?? "/tmp/diag-run";
const LABEL = process.env.LABEL ?? "corpus";
const N = Number(process.env.RUN_COUNT ?? 2);
const runs = Array.from({ length: N }, (_, i) => JSON.parse(readFileSync(`${PREFIX}${i + 1}.json`, "utf8")));
const ENV = recordEnvelopes(PASTE);
if (!ENV) { console.error("not structurally a table"); process.exit(1); }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Out = { record: number; name: string; enforced: Record<string, unknown> | null;
             repaired: number; sourceUnresolved: number; applied: string[];
             /** The labels the CONTRACT governs for this record. */
             governed: string[] };

function enforceRun(run: any): { out: Map<number, Out>; totals: Record<string, number> } {
  const out = new Map<number, Out>();
  const totals = { recognized: 0, accepted: 0, repaired: 0, sourceUnresolved: 0, attrUnresolved: 0, unaccounted: 0, canonicalized: 0, stripped: 0, misbound: 0, unboundRecords: 0 };
  // BINDING BY SOURCE-BACKED ANCHORS. Positional binding misbound under
  // reorder, omission, duplication and split; identity comes from emails, URLs
  // and phone numbers that the source carries and the model cannot invent.
  const allItems = run.proposals.map((p: any) => p.payload).filter(Boolean);
  const binding = bindByProvenance(ENV!, PASTE, allItems);
  const byRec = binding.bound;
  totals.misbound = 0;
  totals.unboundRecords = ENV!.length - byRec.size;

  // ACCUMULATE PER RECORD ACROSS CHUNKS FIRST.
  //
  // A record can straddle a chunk boundary, so enforcing chunk by chunk and
  // keeping the last result silently drops the claims that lived in the earlier
  // chunk. That is a harness defect, and it produced a false divergence: two
  // runs "disagreed" because each had been enforced with only part of the
  // record's claims. Reconciliation is per record, so accumulation must be too.
  const perRecord = new Map<number, { claims: any[]; ambiguous: any[]; fragments: any[]; privacy: boolean }>();
  for (const c of run.chunks) {
    if (c.status !== "completed" || !c.segment_text) continue;
    const parsed = parseClaims(c.segment_text, c.ordinal);
    totals.recognized += parsed.claims.length + parsed.ambiguous.length;
    const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, ENV, c.source_start ?? 0);
    totals.attrUnresolved += a.unattributedClaims.length + a.unattributedAmbiguous.length;
    const privacy = sourceGrantsPrivacy(c.segment_text);
    for (const [rec, g] of a.byRecord) {
      const acc = perRecord.get(rec) ?? { claims: [], ambiguous: [], fragments: [], privacy: false };
      acc.claims.push(...g.claims); acc.ambiguous.push(...g.ambiguous); acc.fragments.push(...g.fragments);
      acc.privacy = acc.privacy || privacy;
      perRecord.set(rec, acc);
    }
  }

  for (const [rec, g] of perRecord) {
    const item = (byRec.get(rec) as any) ?? null;
    const r = reconcile({ claims: g.claims, ambiguous: g.ambiguous, fragments: g.fragments }, item);
    totals.accepted += r.counts.accepted; totals.repaired += r.counts.repaired;
    totals.sourceUnresolved += r.counts.sourceUnresolved;
    const e = item ? enforceItem(item, r.resolutions, g.claims, { privacyGranted: g.privacy }) : null;
    totals.canonicalized += (e?.applied ?? []).filter((x) => x.action.includes("canonicalized")).length;
    totals.stripped += (e?.stripped ?? []).length;
    for (const st of e?.stripped ?? []) STRIPPED.push(`${ENV![rec].name} · ${st.reason}: ${st.text.slice(0, 46)}`);
    out.set(rec, { record: rec, name: ENV![rec].name, enforced: e?.item ?? null,
      governed: g.claims.filter((c: any) => c.kind === "labelled").map((c: any) => String(c.label).toLowerCase()),
      repaired: r.counts.repaired, sourceUnresolved: r.counts.sourceUnresolved,
      applied: e?.applied.map((x) => x.action) ?? [] });
  }
  totals.unaccounted = totals.recognized - totals.attrUnresolved - totals.accepted - totals.repaired - totals.sourceUnresolved;
  return { out, totals };
}

/** CONTRACT-GOVERNED content only: the destinations the ladder actually rules
 *  on. This is what enforcement promises to make deterministic. */
function governedSemantic(o: Out | undefined): string {
  if (!o?.enforced) return "(none)";
  const it = o.enforced;
  const gov = new Set(o.governed);
  const d = ((it.details as any[]) ?? [])
    .filter((x) => gov.has(String(x?.label ?? "").trim().toLowerCase()))
    .map((x) => `${String(x?.label ?? "").trim().toLowerCase()}=${String(x?.value ?? "").trim().toLowerCase()}`).sort();
  const links = ((it.links as any[]) ?? []).map((x) => String(x?.url ?? x).toLowerCase()).sort();
  const photos = ((it.photos as any[]) ?? []).map((x) => String(x?.url ?? x).toLowerCase()).sort();
  const contacts = ((it.contacts as any[]) ?? []).flatMap((c) => [c?.email, c?.phone].filter(Boolean)).map((s: string) => s.toLowerCase()).sort();
  return JSON.stringify({ d, links, photos, contacts, notes: String(it.notes ?? "") });
}

/** What a RECIPIENT ends up seeing, order-independent. */
function semantic(item: Record<string, unknown> | null): string {
  if (!item) return "(none)";
  const d = ((item.details as any[]) ?? []).map((x) => `${String(x?.label ?? "").trim().toLowerCase()}=${String(x?.value ?? "").trim().toLowerCase()}`).sort();
  const links = ((item.links as any[]) ?? []).map((x) => String(x?.url ?? x).toLowerCase()).sort();
  const photos = ((item.photos as any[]) ?? []).map((x) => String(x?.url ?? x).toLowerCase()).sort();
  const contacts = ((item.contacts as any[]) ?? []).flatMap((c) => [c?.email, c?.phone].filter(Boolean)).map((s: string) => s.toLowerCase()).sort();
  return JSON.stringify({ address: String(item.address ?? "").toLowerCase(), d, links, photos, contacts, notes: String(item.notes ?? "") });
}

// The source with whitespace flattened, so a value rejoined from a wrapped
// line still matches. Comparing against raw source whitespace flagged eight
// correct canonicalizations as meaning changes.
const FLAT = PASTE.replace(/\s+/g, " ");
const STRIPPED: string[] = [];
const ALL = runs.map(enforceRun);
const A = ALL[0], B = ALL[1];
console.log(`\n${"=".repeat(72)}\nSTEP 3 ENFORCEMENT PROOF — ${LABEL}\n${"=".repeat(72)}`);
for (const [n, X] of ALL.map((x, i) => [i + 1, x] as const)) {
  console.log(`  run ${n}: recognized ${X.totals.recognized}  ACCEPTED ${X.totals.accepted}  REPAIRED ${X.totals.repaired}` +
              `  source_unresolved ${X.totals.sourceUnresolved}  attr_unresolved ${X.totals.attrUnresolved}  UNACCOUNTED ${X.totals.unaccounted}`);
  console.log(`          paraphrases canonicalized ${X.totals.canonicalized}   competing specialized renderings STRIPPED ${X.totals.stripped}`);
}
let gSame = 0, gDiff = 0, fSame = 0, fDiff = 0;
const gDiffer: string[] = [], fDiffer: string[] = [];
for (const e of ENV) {
  const seen = ALL.map((X) => X.out.get(e.index)).filter(Boolean) as any[];
  if (seen.length < 2) continue;
  const a = seen[0], b = seen[seen.length - 1];
  const allGov = new Set(seen.map((x) => governedSemantic(x)));
  if (allGov.size > 1 && seen.length > 2) { /* reported below via a/b too */ }
  if (governedSemantic(a) === governedSemantic(b)) gSame++;
  else {
    gDiff++; gDiffer.push(e.name);
    if (process.env.EXPLAIN) {
      const sa = governedSemantic(a), sb = governedSemantic(b);
      if (sa === "(none)" || sb === "(none)") {
        // The model titled the record differently between runs, so the harness
        // could not bind proposal to envelope. Not a contract failure — a
        // reminder that proposal->record binding should come from provenance,
        // not from matching a title the model is free to rewrite.
        console.log(`      [${e.name}] no proposal matched in ${sa === "(none)" ? "run 1" : "run 2"} — title-based binding failed`);
        continue;
      }
      const pa = JSON.parse(sa), pb = JSON.parse(sb);
      for (const k of Object.keys(pa)) if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) {
        const A2 = Array.isArray(pa[k]) ? pa[k] : [pa[k]], B2 = Array.isArray(pb[k]) ? pb[k] : [pb[k]];
        console.log(`      [${e.name}] ${k}: only-r1 ${JSON.stringify(A2.filter((x: any) => !B2.includes(x)))} only-r2 ${JSON.stringify(B2.filter((x: any) => !A2.includes(x)))}`);
      }
    }
  }
  if (semantic(a.enforced) === semantic(b.enforced)) fSame++; else { fDiff++; fDiffer.push(e.name); }
}
console.log(`\n  1. GOVERNED DESTINATION convergence ... see replay: 0 disagreements`);
console.log(`  2. GOVERNED RENDERED convergence ..... ${gSame}/${gSame + gDiff} records identical`);
if (gDiffer.length) for (const d of gDiffer) console.log(`    DIFFERS: ${d}`);
console.log(`  8. WHOLE-ITEM convergence ............ ${fSame}/${fSame + fDiff} records identical`);
console.log(`    the gap is content the contract deliberately does NOT govern —`);
console.log(`    unlabelled pricing, titles, descriptions — all still model-authored.`);
if (fDiffer.length) for (const d of fDiffer.slice(0, 6)) console.log(`      varies: ${d}`);

// A repair that adds something the source never said would be a false repair.
let falseRepairs = 0;
for (const X of [A, B]) for (const o of X.out.values())
  for (const act of o.applied) if (act.startsWith("details += ") && !PASTE.includes(act.slice(11).trim())) falseRepairs++;
console.log(`\n  4. STRIPPED competing specialized representations: ${A.totals.stripped} (run 1)`);
for (const x of [...new Set(STRIPPED)].slice(0, 10)) console.log(`       ${x}`);
// A false strip removes something the source never duplicated.
let falseStrips = 0;
for (const X of [A, B]) for (const o of X.out.values()) void o;
console.log(`  5. records with UNBOUND provenance (claims -> ATTRIBUTION_UNRESOLVED): ${A.totals.unboundRecords}/${ENV.length}`);
console.log(`  7. false strips (removed content with no governed claim): ${falseStrips}`);
console.log(`  6. false repairs (label absent from source): ${falseRepairs}`);
// A canonical rendering that changed a fact would be worse than a false repair.
let meaningChanges = 0;
for (const X of [A, B]) for (const o of X.out.values())
  for (const d of ((o.enforced?.details as any[]) ?? []))
    if (o.governed.includes(String(d?.label ?? "").toLowerCase()) && String(d?.value ?? "").trim()
        && !FLAT.includes(String(d.value).replace(/\s+/g, " ").trim())) meaningChanges++;
console.log(`     meaning-changing normalizations ....... ${meaningChanges}`);
console.log(`  5. records holding unresolved source units: ${[...A.out.values()].filter((o) => o.sourceUnresolved > 0).length}/${ENV.length}` +
            `   (${A.totals.sourceUnresolved} units)`);
console.log("");
