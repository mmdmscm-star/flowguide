// Stage 1 acceptance: re-run the EXACT reported source through a fresh
// ingestion and prove the failure is gone.
//
// Uses the real HTTP routes, the real model, and a disposable user (cleaned up
// by cleanup.mts), so the code path under test is the one the editor uses.
// Source is read from the preserved packet's raw_input, so it is byte-identical
// to what was pasted — not a retyped approximation.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-seg-v3.mts
//
// Consumes real model credits. See docs/investigations/mid-record-chunk-splits.md
import { api, drive, newMetrics, svc, check, summary } from "./e2e.mts";
import { buildMediaLedger } from "../../src/lib/media-ledger.ts";
import { segment, DEFAULT_BUDGET, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";

const EVIDENCE_PACKET = "1d1e9f41-6821-4dc7-8e65-35ce53859a14";

const { data: ev } = await svc.from("packets").select("raw_input").eq("id", EVIDENCE_PACKET).maybeSingle();
const SOURCE: string = (ev as { raw_input?: string } | null)?.raw_input ?? "";
if (!SOURCE) { console.error("could not read the preserved source"); process.exit(1); }
console.log(`source: ${SOURCE.length} chars   segmenter: ${SEGMENTER_VERSION}`);

// ---- plan check (pure, before spending a single model call)
const plan = segment(SOURCE, DEFAULT_BUDGET);
console.log(`\nplanned chunks: ${plan.length}`);
for (const s of plan) {
  // Filenames take both shapes here: "AtriaTC1_x.jpg" and "96824AlmaViaSR_x.jpg",
  // so the leading digit run must be consumed before the owner tag.
  const owners = new Set(
    [...s.text.matchAll(/\/v\d+\/\d*([A-Za-z]+?)\d*_[A-Za-z0-9]+\.jpg/g)].map((m) => m[1]),
  );
  console.log(`  chunk ${s.ordinal} [${s.sourceStart},${s.sourceEnd}) len=${s.text.length} photoOwners=${JSON.stringify([...owners])}`);
}
check("[plan] one chunk per record (3)", plan.length === 3, `got ${plan.length}`);
check("[plan] every chunk begins at a record", plan.every((s) => /^(Atria|AlmaVia|Drake)/.test(s.text.trimStart())),
  plan.map((s) => s.text.slice(0, 22)).join(" | "));

// ---- live run
const m = newMetrics("seg-v3", SOURCE.length);
const res = await api("/api/ingest/organize", {
  method: "POST",
  body: JSON.stringify({ rawText: SOURCE, packetType: "general", requestKey: `segv3-${process.pid}` }),
});
check("[run] organize accepted (201)", res.status === 201, `${res.status} ${JSON.stringify(res.data).slice(0, 160)}`);
if (res.status !== 201) { summary(); process.exit(1); }
const packetId = res.data.packetId as string;
console.log(`\nrun ${res.data.runId}  packet ${packetId}  totalChunks=${res.data.totalChunks}`);
check("[run] planned 3 chunks", res.data.totalChunks === 3, `got ${res.data.totalChunks}`);

const out = await drive(res.data.runId, m);
check("[run] finalized", out.outcome === "finalized", JSON.stringify(out));

// Observe the ROUTE's OWN accounting rather than recomputing it here. An earlier
// version of this script computed the ledger in-process, which masked the
// finalize route skipping it entirely (it read packet_id from a result that
// never contained one). Finalize is idempotent, so calling it again replays the
// accounting and returns the payload.
const fin = await api(`/api/ingest/${res.data.runId}/finalize`, { method: "POST" });
const routeReview = fin.data?.review as { ok?: boolean; failures?: unknown[] } | undefined;
check("[route] finalize returned a media ledger", routeReview !== undefined,
  `review=${JSON.stringify(fin.data)?.slice(0, 160)}`);
check("[route] route's own ledger reports no failures", routeReview?.ok === true,
  JSON.stringify(routeReview?.failures ?? []).slice(0, 200));

// ---- stored result
const { data: secs } = await svc.from("sections").select("id, title").eq("packet_id", packetId).order("sort_order");
const sections = secs ?? [];
check("[result] ONE semantic section for the table", sections.length === 1, `got ${sections.length}: ${JSON.stringify(sections.map((s: any) => s.title))}`);

const { data: items } = await svc.from("items")
  .select("id, title, sort_order").in("section_id", sections.map((s: any) => s.id)).order("sort_order");
const list = (items ?? []) as Array<{ id: string; title: string }>;
console.log(`\nitems (${list.length}):`);
const stored: Array<{ url: string; itemId: string }> = [];
const counts: Record<string, number> = {};
for (const it of list) {
  const { data: ph } = await svc.from("item_photos").select("url").eq("item_id", it.id);
  const urls = (ph ?? []).map((p: any) => p.url);
  counts[it.title] = urls.length;
  for (const u of urls) stored.push({ url: u, itemId: it.id });
  console.log(`  ${JSON.stringify(it.title)} — ${urls.length} photos`);
}

check("[result] exactly 3 items", list.length === 3, `got ${list.length}: ${JSON.stringify(list.map((i) => i.title))}`);
check("[result] no fabricated item", !list.some((i) => /community property/i.test(i.title)),
  JSON.stringify(list.map((i) => i.title)));

const byPrefix = (p: string) => Object.entries(counts).find(([t]) => t.toLowerCase().startsWith(p))?.[1] ?? -1;
check("[photos] Atria has 8", byPrefix("atria") === 8, `got ${byPrefix("atria")}`);
check("[photos] AlmaVia has 2", byPrefix("almavia") === 2, `got ${byPrefix("almavia")}`);
check("[photos] Drake Terrace has 9", byPrefix("drake") === 9, `got ${byPrefix("drake")}`);

// ---- exact media accounting
// Independent cross-check of the route's answer, computed from stored rows.
const ledger = buildMediaLedger({ source: SOURCE, stored });
console.log(`\nledger (independent): source=${ledger.sourceCount} stored=${ledger.storedCount} failures=${ledger.failures.length}`);
for (const f of ledger.failures) console.log(`  ${f.code}: ${f.url.slice(-34)}`);
check("[ledger] 19 source media accounted", ledger.sourceCount === 19, `got ${ledger.sourceCount}`);
check("[ledger] no unresolved review state", ledger.ok, JSON.stringify(ledger.failures.slice(0, 4)));

const { data: run } = await svc.from("ingestion_runs").select("status").eq("id", res.data.runId).maybeSingle();
check("[run] status finalized, not needs_review", (run as any)?.status === "finalized", `${(run as any)?.status}`);

console.log(`\nmodel calls: ${m.modelCalls}  chunk ms: ${m.chunkMs.map((x) => x.toFixed(0)).join(", ")}`);
console.log(`disposable packet ${packetId} — removed by cleanup.mts`);
summary();
