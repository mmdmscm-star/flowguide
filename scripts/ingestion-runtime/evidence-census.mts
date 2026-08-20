// READ ONLY. Availability census — does real source material survive?
// Reports COUNTS and SIZES, not content.
import { svc } from "./lib.mts";
const { data: runs, error } = await svc.from("ingestion_runs")
  .select("id, destination, entry_point, status, source_text, source_len, total_chunks, created_at, finalized_at, evidence_purge_after")
  .order("created_at", { ascending: false }).limit(60);
if (error) throw new Error(JSON.stringify(error));
const R = (runs ?? []) as any[];
console.log(`ingestion_runs (most recent ${R.length}):\n`);
console.log("  created            dest     status      chunks  src_len  source_text  expiry");
for (const r of R.slice(0, 30)) {
  console.log(`  ${String(r.created_at).slice(0,16)}  ${String(r.destination).padEnd(7)}  ${String(r.status).padEnd(10)}  ${String(r.total_chunks).padStart(6)}  ${String(r.source_len).padStart(7)}  ${r.source_text === null ? "CLEARED    " : String(r.source_text.length).padStart(7)+"ch "}  ${r.evidence_purge_after ? "stamped" : "-"}`);
}
const withSource = R.filter((r) => r.source_text !== null);
console.log(`\n  runs still holding source_text: ${withSource.length} of ${R.length}`);
console.log(`  largest surviving source: ${withSource.length ? Math.max(...withSource.map((r) => r.source_text.length)) : 0} chars`);

const { count: chunkCount } = await svc.from("ingestion_chunks").select("id", { count: "exact", head: true }).not("segment_text", "is", null);
const { count: ledgerCount } = await svc.from("ingestion_chunks").select("id", { count: "exact", head: true }).not("fact_ledger", "is", null);
console.log(`\n  chunks still holding segment_text: ${chunkCount}`);
console.log(`  chunks holding a fact_ledger:      ${ledgerCount}`);

const { data: li } = await svc.from("library_items").select("id, user_id, origin_run_id, origin_chunk_ordinal, created_at").order("created_at");
const L = (li ?? []) as any[];
const byUser: Record<string, number> = {};
for (const l of L) byUser[l.user_id] = (byUser[l.user_id] ?? 0) + 1;
console.log(`\n  library_items: ${L.length} total across ${Object.keys(byUser).length} user(s)`);
console.log(`  with origin_run_id recorded: ${L.filter((l) => l.origin_run_id).length}`);
const runIds = new Set(L.filter((l)=>l.origin_run_id).map((l)=>l.origin_run_id));
console.log(`  distinct origin runs referenced: ${runIds.size}`);
if (runIds.size) {
  const { data: orig } = await svc.from("ingestion_runs").select("id, source_text, created_at, total_chunks").in("id", [...runIds]);
  for (const o of (orig ?? []) as any[])
    console.log(`    run ${String(o.id).slice(0,8)} ${String(o.created_at).slice(0,16)} chunks=${o.total_chunks} source=${o.source_text===null?"CLEARED":o.source_text.length+"ch"}`);
}
