// Detector precision and recall, measured OFFLINE against both corpora.
// No model calls, no database, no network. Ground truth is the corpora's own.
import { detectFacts } from "../../src/lib/fact-ledger.ts";
import { probe, squash } from "../../src/lib/fact-match.ts";
import { buildRunChunks } from "../../src/lib/ingestion.ts";
import * as V1 from "./fixtures/semantic-corpus.mts";
import * as V2 from "./fixtures/semantic-corpus-v2.mts";

/** A ground-truth fact the detector is DESIGNED to find. Names, roles, titles and
 *  free prose are deliberately out of scope — they are judgement, not shape. */
function inScope(f: { text: string; shape?: string; label?: string; present: boolean }): boolean {
  if (!f.present || !f.text.trim()) return false;
  const k = probe(f.text).kind;
  if (k === "url" || k === "email" || k === "phone" || k === "money") return true;
  if (f.shape === "ranged" || f.shape === "qualified") return true;
  return Boolean(f.label);          // it sat on a Label: value line
}

const near = (a: string, b: string) => {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
};

for (const [name, C] of [["v1", V1], ["v2", V2]] as const) {
  const chunks = buildRunChunks(C.SOURCE);
  const detected = chunks.flatMap((c) => detectFacts(c.segment_text, c.ordinal));
  const truth = (C.RECORDS as any[]).flatMap((r) => r.facts.map((f: any) => ({ ...f, rec: r.key })));
  const scoped = truth.filter(inScope);

  const truePos = detected.filter((d) => truth.some((t) => t.present && near(d.text, t.text)));
  const falsePos = detected.filter((d) => !truth.some((t) => t.present && near(d.text, t.text)));
  const foundTruth = scoped.filter((t) => detected.some((d) => near(d.text, t.text)));

  console.log(`\n${"=".repeat(64)}\nCORPUS ${name.toUpperCase()} — ${chunks.length} chunks`);
  console.log(`  ground-truth facts .......... ${truth.length}  (in scope for detection: ${scoped.length})`);
  console.log(`  detected .................... ${detected.length}`);
  console.log(`  PRECISION ................... ${(truePos.length / detected.length * 100).toFixed(1)}%  (${truePos.length}/${detected.length})`);
  console.log(`  RECALL (in scope) ........... ${(foundTruth.length / scoped.length * 100).toFixed(1)}%  (${foundTruth.length}/${scoped.length})`);

  const byKind: Record<string, number> = {};
  for (const d of detected) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  console.log(`  detected by kind ............ ${JSON.stringify(byKind)}`);
  console.log(`  tier-1 eligible ............. ${detected.filter((d) => d.detailEligible).length} of ${detected.filter((d) => d.kind === "keyvalue").length} key/value facts`);

  if (falsePos.length) {
    console.log(`  FALSE POSITIVES (${falsePos.length}) — detections with no ground-truth fact:`);
    const shown = new Map<string, number>();
    for (const f of falsePos) shown.set(`${f.kind}: ${f.text.slice(0, 56)}`, (shown.get(`${f.kind}: ${f.text.slice(0, 56)}`) ?? 0) + 1);
    for (const [k, n] of [...shown.entries()].slice(0, 14)) console.log(`      ${String(n).padStart(3)}× ${k}`);
  }
  const missed = scoped.filter((t) => !detected.some((d) => near(d.text, t.text)));
  if (missed.length) {
    console.log(`  MISSED (${missed.length}) — in-scope facts the detector did not find:`);
    const shown = new Map<string, number>();
    for (const m of missed) shown.set(`${m.shape}/${m.id}: ${m.text.slice(0, 48)}`, (shown.get(`${m.shape}/${m.id}: ${m.text.slice(0, 48)}`) ?? 0) + 1);
    for (const [k, n] of [...shown.entries()].slice(0, 14)) console.log(`      ${String(n).padStart(3)}× ${k}`);
  }
}
