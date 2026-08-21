// STEP 3 PROOF. Applies the contract to two independent model runs of the SAME
// input and asks whether the ENFORCED semantic output converges.
//
// Enforcement is a pure function of (source, model output). The model varies;
// the question is whether what a recipient ends up seeing does.
//
//   PASTE_FILE=… RUNS=/tmp/diag-run npx tsx scripts/ingestion-runtime/prove-enforcement.mts
import { readFileSync } from "node:fs";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll } from "../../src/lib/attribution.ts";
import { reconcile } from "../../src/lib/reconcile.ts";
import { enforceItem, sourceGrantsPrivacy } from "../../src/lib/enforce.ts";

const PASTE = readFileSync(process.env.PASTE_FILE ?? "diagnostic-paste.txt", "utf8");
const PREFIX = process.env.RUNS ?? "/tmp/diag-run";
const LABEL = process.env.LABEL ?? "corpus";
const runs = [1, 2].map((n) => JSON.parse(readFileSync(`${PREFIX}${n}.json`, "utf8")));
const ENV = recordEnvelopes(PASTE);
if (!ENV) { console.error("not structurally a table"); process.exit(1); }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Out = { record: number; name: string; enforced: Record<string, unknown> | null;
             repaired: number; sourceUnresolved: number; applied: string[];
             /** The labels the CONTRACT governs for this record. */
             governed: string[] };

function enforceRun(run: any): { out: Map<number, Out>; totals: Record<string, number> } {
  const out = new Map<number, Out>();
  const totals = { recognized: 0, accepted: 0, repaired: 0, sourceUnresolved: 0, attrUnresolved: 0, unaccounted: 0 };
  const byRec = new Map<number, any>();
  for (const p of run.proposals) {
    const e = ENV!.find((x) => norm(x.name).startsWith(norm(String(p.payload?.title ?? "")).slice(0, 12))
                            || norm(String(p.payload?.title ?? "")).startsWith(norm(x.name).slice(0, 12)));
    if (e) byRec.set(e.index, p.payload);
  }

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
    const item = byRec.get(rec) ?? null;
    const r = reconcile({ claims: g.claims, ambiguous: g.ambiguous, fragments: g.fragments }, item);
    totals.accepted += r.counts.accepted; totals.repaired += r.counts.repaired;
    totals.sourceUnresolved += r.counts.sourceUnresolved;
    const e = item ? enforceItem(item, r.resolutions, g.claims, { privacyGranted: g.privacy }) : null;
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

const A = enforceRun(runs[0]), B = enforceRun(runs[1]);
console.log(`\n${"=".repeat(72)}\nSTEP 3 ENFORCEMENT PROOF — ${LABEL}\n${"=".repeat(72)}`);
for (const [n, X] of [[1, A], [2, B]] as const) {
  console.log(`  run ${n}: recognized ${X.totals.recognized}  accepted ${X.totals.accepted}  repaired ${X.totals.repaired}` +
              `  source_unresolved ${X.totals.sourceUnresolved}  attr_unresolved ${X.totals.attrUnresolved}  UNACCOUNTED ${X.totals.unaccounted}`);
}
let gSame = 0, gDiff = 0, fSame = 0, fDiff = 0;
const gDiffer: string[] = [], fDiffer: string[] = [];
for (const e of ENV) {
  const a = A.out.get(e.index), b = B.out.get(e.index);
  if (!a || !b) continue;
  if (governedSemantic(a) === governedSemantic(b)) gSame++; else { gDiff++; gDiffer.push(e.name); }
  if (semantic(a.enforced) === semantic(b.enforced)) fSame++; else { fDiff++; fDiffer.push(e.name); }
}
console.log(`\n  CONTRACT-GOVERNED CONVERGENCE ... ${gSame}/${gSame + gDiff} records identical`);
if (gDiffer.length) for (const d of gDiffer) console.log(`    DIFFERS: ${d}`);
console.log(`  WHOLE-ITEM CONVERGENCE .......... ${fSame}/${fSame + fDiff} records identical`);
console.log(`    the gap is content the contract deliberately does NOT govern —`);
console.log(`    unlabelled pricing, titles, descriptions — all still model-authored.`);
if (fDiffer.length) for (const d of fDiffer.slice(0, 6)) console.log(`      varies: ${d}`);

// A repair that adds something the source never said would be a false repair.
let falseRepairs = 0;
for (const X of [A, B]) for (const o of X.out.values())
  for (const act of o.applied) if (act.startsWith("details += ") && !PASTE.includes(act.slice(11).trim())) falseRepairs++;
console.log(`  false repairs (label not present in the source): ${falseRepairs}`);
console.log(`  records still holding unresolved source units: ${[...A.out.values()].filter((o) => o.sourceUnresolved > 0).length}/${ENV.length}`);
console.log("");
