import { svc } from "./lib.mts";
const { data } = await svc.from("ingestion_runs")
  .select("id, user_id, destination, entry_point, status, total_chunks, source_len, source_text, created_at")
  .order("created_at", { ascending: false }).limit(10);
for (const r of (data ?? []) as Record<string, any>[]) {
  const head = r.source_text ? String(r.source_text).slice(0, 60).replace(/\s+/g, " ") : "";
  console.log(`${String(r.created_at).slice(0, 19)}  ${String(r.destination).padEnd(7)} ${String(r.status).padEnd(9)} chunks=${String(r.total_chunks).padStart(3)} len=${String(r.source_len).padStart(6)} src=${r.source_text === null ? "CLEARED" : "present"}  ${r.id}`);
  if (head) console.log(`      ${head}…`);
}
