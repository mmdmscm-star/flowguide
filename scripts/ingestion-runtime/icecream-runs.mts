import { svc } from "./lib.mts";
const KNOWN = "73c7d25b-c27d-4e41-b89e-fd901c93ff9e";
const { data: k } = await svc.from("ingestion_runs").select("user_id, packet_id").eq("id", KNOWN).single();
const uid = (k as any).user_id;
const { data: runs } = await svc.from("ingestion_runs")
  .select("id, packet_id, entry_point, destination, status, total_chunks, completed_chunks, source_len, source_hash, source_text, error, request_key, segmenter_version, created_at, updated_at, finalized_at")
  .eq("user_id", uid).order("created_at", { ascending: false }).limit(12);
console.log(`runs for this professional: ${(runs ?? []).length}\n`);
for (const r of (runs ?? []) as Record<string, any>[]) {
  console.log(`${r.id}`);
  console.log(`   created ${r.created_at}   updated ${r.updated_at}   finalized ${r.finalized_at ?? "—"}`);
  console.log(`   ${r.destination}/${r.entry_point}  status=${r.status}  chunks ${r.completed_chunks}/${r.total_chunks}  src_len=${r.source_len}  hash=${String(r.source_hash).slice(0, 16)}  seg=${r.segmenter_version}`);
  console.log(`   packet=${r.packet_id}  source_text=${r.source_text === null ? "CLEARED" : String(r.source_text).length + "ch"}  request_key=${r.request_key ?? "—"}`);
  if (r.error) console.log(`   ERROR: ${String(r.error).slice(0, 200)}`);
}
