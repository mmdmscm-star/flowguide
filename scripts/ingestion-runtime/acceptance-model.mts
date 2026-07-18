// Scenarios 1-5: the five real product flows, through the real HTTP routes and
// the real configured model. No fault injection.
import {
  api, drive, packetContent, newMetrics, bump, report, organize, results,
  UID, TAG, makeSource, check, summary, svc, errText,
} from "./e2e.mts";
import { writeFileSync } from "node:fs";

const FIXTURE_40 = makeSource(40);
const FIXTURE_BIG = makeSource(110);
const FIXTURE_SMALL = makeSource(2);

// Ground truth the generator guarantees, for fidelity scoring.
const { community } = await import(
  new URL("../../docs/investigations/fixtures/senior-placement-source.mjs", import.meta.url).href
);
function truthFor(n: number) {
  const names: string[] = [], sites: string[] = [], phones: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = community(i) as string;
    names.push(b.split("\n")[0]);
    const w = b.match(/https:\/\/[^\s]+/); if (w) sites.push(w[0]);
    const p = b.match(/\(707\) 555-\d{4}/); if (p) phones.push(p[0]);
  }
  return { names, sites, phones };
}

// Fidelity is scored as recall against the generator's ground truth. The model
// legitimately rewords descriptions, so titles are matched loosely (normalised
// substring), and links/phones exactly since they are copyable strings.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Past index 29 the generator reuses base names with a " 2" suffix, so
// "goldenmeadows2".includes("goldenmeadows") matches the WRONG (earlier) index.
// Resolve to the most specific name: exact match first, then longest substring.
function matchIndex(title: string, names: string[]): number {
  const t = norm(title);
  const exact = names.findIndex((nm) => norm(nm) === t);
  if (exact >= 0) return exact;
  let best = -1, bestLen = -1;
  names.forEach((nm, i) => {
    const n = norm(nm);
    if ((t.includes(n) || n.includes(t)) && n.length > bestLen) { best = i; bestLen = n.length; }
  });
  return best;
}
function fidelity(label: string, content: any, n: number) {
  const t = truthFor(n);
  const blob = JSON.stringify(content).toLowerCase();
  // Each source name must be claimed by a DISTINCT item, so duplicates in the
  // output cannot inflate recall.
  const claimed = new Set<number>();
  for (const it of content.items) {
    const idx = matchIndex(it.title, t.names);
    if (idx >= 0 && !claimed.has(idx)) claimed.add(idx);
  }
  const nameHits = claimed.size;
  const siteHits = t.sites.filter((u) => blob.includes(u.toLowerCase())).length;
  const phoneHits = t.phones.filter((p) => blob.replace(/\s/g, "").includes(p.replace(/\s/g, "").toLowerCase())).length;
  const addrHits = content.items.filter((i: any) => (i.address || "").trim().length > 0).length;
  console.log(`    fidelity: items=${content.items.length}/${n}  names=${nameHits}/${n}  sites=${siteHits}/${t.sites.length}  phones=${phoneHits}/${t.phones.length}  withAddress=${addrHits}`);
  console.log(`    links=${content.links.length} contacts=${content.contacts.length} details=${content.details.length} sections=${content.secs.length}`);
  return { nameHits, siteHits, phoneHits, addrHits, n, sites: t.sites.length, phones: t.phones.length };
}

// Ordering: items must follow source order. Score as longest non-decreasing run
// over first-appearance index, so one misplacement doesn't read as total chaos.
function orderScore(content: any, n: number) {
  const t = truthFor(n);
  const seq: number[] = [];
  const ordered = [...content.items].sort((a: any, b: any) => {
    const sa = content.secs.findIndex((s: any) => s.id === a.section_id);
    const sb = content.secs.findIndex((s: any) => s.id === b.section_id);
    return sa - sb || a.sort_order - b.sort_order;
  });
  for (const it of ordered) {
    const idx = matchIndex(it.title, t.names);
    if (idx >= 0) seq.push(idx);
  }
  let best = 0, cur = 0;
  for (let i = 0; i < seq.length; i++) { cur = i > 0 && seq[i] >= seq[i - 1] ? cur + 1 : 1; best = Math.max(best, cur); }
  console.log(`    order: ${best}/${seq.length} items in non-decreasing source order`);
  return { best, total: seq.length };
}

const evidence: any = {};

// ---------------------------------------------------------------- 1. 40 items
console.log("[1] Organize with AI — original ~40-item fixture (REAL MODEL)");
{
  const r = await organize("organize-40", FIXTURE_40);
  check("[40] run finalized", r.outcome === "finalized", String(r.outcome) + " " + JSON.stringify((r as any).driveInfo ?? {}).slice(0, 200));
  report(r.m);
  if (r.packetId) {
    const c = await packetContent(r.packetId);
    check("[40] produced sections", c.secs.length > 0, `${c.secs.length}`);
    check("[40] produced a plausible number of items", c.items.length >= 30, `${c.items.length} items`);
    const f = fidelity("40", c, 40);
    const o = orderScore(c, 40);
    check("[40] name recall >= 90%", f.nameHits / 40 >= 0.9, `${f.nameHits}/40`);
    check("[40] website links preserved >= 80%", f.siteHits / f.sites >= 0.8, `${f.siteHits}/${f.sites}`);
    check("[40] contact phones preserved >= 80%", f.phoneHits / f.phones >= 0.8, `${f.phoneHits}/${f.phones}`);
    check("[40] addresses captured on >= 90% of items", f.addrHits / c.items.length >= 0.9, `${f.addrHits}/${c.items.length}`);
    check("[40] source order largely preserved", o.best / Math.max(1, o.total) >= 0.85, `${o.best}/${o.total}`);
    evidence.f40 = { metrics: r.m, fidelity: f, order: o, sections: c.secs.length, items: c.items.length };
  }
  const slow = Math.max(0, ...r.m.chunkMs);
  check("[40] slowest model chunk far under the 60s boundary", slow < 45000, `${(slow / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- 2. larger
console.log("\n[2] Organize with AI — substantially larger fixture (REAL MODEL)");
{
  const r = await organize("organize-big", FIXTURE_BIG);
  check("[big] run finalized", r.outcome === "finalized", String(r.outcome) + " " + JSON.stringify((r as any).driveInfo ?? {}).slice(0, 200));
  report(r.m);
  check("[big] required more chunks than the 40-item run", r.m.initialChunks > (evidence.f40?.metrics?.initialChunks ?? 0), `${r.m.initialChunks}`);
  if (r.packetId) {
    const c = await packetContent(r.packetId);
    const f = fidelity("big", c, 110);
    const o = orderScore(c, 110);
    check("[big] produced a plausible number of items", c.items.length >= 90, `${c.items.length} items`);
    check("[big] name recall >= 85%", f.nameHits / 110 >= 0.85, `${f.nameHits}/110`);
    check("[big] source order largely preserved", o.best / Math.max(1, o.total) >= 0.8, `${o.best}/${o.total}`);
    evidence.fBig = { metrics: r.m, fidelity: f, order: o, sections: c.secs.length, items: c.items.length };
  }
  const slow = Math.max(0, ...r.m.chunkMs);
  check("[big] slowest model chunk far under the 60s boundary", slow < 45000, `${(slow / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- 3. one chunk
console.log("\n[3] Organize with AI — small single-chunk fixture (REAL MODEL)");
{
  const r = await organize("organize-small", FIXTURE_SMALL);
  check("[small] run finalized", r.outcome === "finalized", String(r.outcome));
  report(r.m);
  check("[small] was a single-chunk run", r.m.initialChunks === 1, `${r.m.initialChunks} chunks`);
  if (r.packetId) {
    const c = await packetContent(r.packetId);
    check("[small] produced items", c.items.length >= 2, `${c.items.length}`);
    evidence.fSmall = { metrics: r.m, sections: c.secs.length, items: c.items.length };
  }
}

// ---------------------------------------------------------------- 4. append
console.log("\n[4] General 'Add with AI' on an existing legacy packet (REAL MODEL)");
{
  // Build the base packet through the product's own Organize flow.
  const base = await organize("append-base", makeSource(3));
  check("[append] base packet ready", base.outcome === "finalized", String(base.outcome));
  const before = await packetContent(base.packetId!);

  const addText = makeSource(6);
  const m = newMetrics("append", addText.length);
  const t0 = performance.now();
  const start = await api(`/api/packets/${base.packetId}/ingest`, {
    method: "POST", body: JSON.stringify({ entryPoint: "append", rawText: addText }),
  });
  bump(m, start.status);
  check("[append] ingest accepted (201)", start.status === 201, `${start.status} ${JSON.stringify(start.data).slice(0, 120)}`);
  if (start.status === 201) {
    m.initialChunks = start.data.totalChunks;
    const out = await drive(start.data.runId, m);
    m.totalMs += performance.now() - t0;
    check("[append] run finalized", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));
    report(m);
    const after = await packetContent(base.packetId!);
    check("[append] added new sections", after.secs.length > before.secs.length, `${before.secs.length} -> ${after.secs.length}`);
    check("[append] added new items", after.items.length > before.items.length, `${before.items.length} -> ${after.items.length}`);
    check("[append] pre-existing items preserved", before.items.every((b: any) => after.items.some((a: any) => a.id === b.id)), "some prior items lost");
    evidence.append = { metrics: m, before: before.items.length, after: after.items.length };
  }
}

// ---------------------------------------------------------------- 5. section append
console.log("\n[5] Section-level 'Add items with AI' on a legacy packet (REAL MODEL)");
{
  const base = await organize("secappend-base", makeSource(3));
  check("[section] base packet ready", base.outcome === "finalized", String(base.outcome));
  const before = await packetContent(base.packetId!);
  const target = before.secs[0];
  check("[section] has a target section", !!target, "no sections");

  const addText = makeSource(5);
  const m = newMetrics("section_append", addText.length);
  const t0 = performance.now();
  const start = await api(`/api/packets/${base.packetId}/ingest`, {
    method: "POST",
    body: JSON.stringify({ entryPoint: "section_append", rawText: addText, targetSectionId: target.id }),
  });
  bump(m, start.status);
  check("[section] ingest accepted (201)", start.status === 201, `${start.status} ${JSON.stringify(start.data).slice(0, 140)}`);
  if (start.status === 201) {
    m.initialChunks = start.data.totalChunks;
    const out = await drive(start.data.runId, m);
    m.totalMs += performance.now() - t0;
    check("[section] run finalized", out.outcome === "finalized", String(out.outcome) + " " + JSON.stringify(out).slice(0, 160));
    report(m);
    const after = await packetContent(base.packetId!);
    check("[section] created NO new sections", after.secs.length === before.secs.length, `${before.secs.length} -> ${after.secs.length}`);
    check("[section] added items", after.items.length > before.items.length, `${before.items.length} -> ${after.items.length}`);
    const added = after.items.filter((a: any) => !before.items.some((b: any) => b.id === a.id));
    check("[section] every new item landed in the TARGET section", added.length > 0 && added.every((a: any) => a.section_id === target.id), `${added.length} added, ${new Set(added.map((a: any) => a.section_id)).size} distinct sections`);
    const orders = added.map((a: any) => a.sort_order).sort((x: number, y: number) => x - y);
    check("[section] appended after existing items (no reordering)", orders[0] >= before.items.filter((b: any) => b.section_id === target.id).length, `first new sort_order=${orders[0]}`);
    evidence.sectionAppend = { metrics: m, before: before.items.length, after: after.items.length, added: added.length };
  }
}

console.log("\n=== SLOWEST MODEL CHUNK ACROSS ALL REAL-MODEL RUNS ===");
const allChunks = results.flatMap((r) => r.chunkMs);
const slowest = Math.max(0, ...allChunks);
console.log(`  slowest single chunk: ${(slowest / 1000).toFixed(2)}s over ${allChunks.length} model calls (60s boundary)`);
console.log(`  median chunk: ${(([...allChunks].sort((a, b) => a - b)[Math.floor(allChunks.length / 2)] ?? 0) / 1000).toFixed(2)}s`);
check("NO model request approached the 60s failure boundary", slowest < 45000, `${(slowest / 1000).toFixed(1)}s`);

evidence.slowestChunkMs = slowest;
evidence.allRuns = results;
writeFileSync(new URL("./evidence-model.json", import.meta.url), JSON.stringify(evidence, null, 2));
process.exit(summary("REAL-MODEL ACCEPTANCE") > 0 ? 1 : 0);
