import { svc } from "./lib.mts";
const { data: k } = await svc.from("ingestion_runs").select("user_id").eq("id", "73c7d25b-c27d-4e41-b89e-fd901c93ff9e").single();
const uid = (k as any).user_id;
const { data: pk } = await svc.from("packets")
  .select("id, title, slug, status, origin_ingestion_run_id, created_at, updated_at, raw_input")
  .eq("user_id", uid).gte("created_at", "2026-08-21T00:00:00Z").order("created_at");
console.log(`packets created by this professional on 2026-08-21: ${(pk ?? []).length}\n`);
for (const p of (pk ?? []) as Record<string, any>[]) {
  const { count: secs } = await svc.from("sections").select("id", { count: "exact", head: true }).eq("packet_id", p.id);
  const { data: sids } = await svc.from("sections").select("id").eq("packet_id", p.id);
  const ids = (sids ?? []).map((s: any) => s.id);
  const { count: items } = ids.length ? await svc.from("items").select("id", { count: "exact", head: true }).in("section_id", ids) : { count: 0 };
  console.log(`${p.id}  ${String(p.created_at).slice(0, 19)}  ${String(p.status).padEnd(9)} "${p.title}"`);
  console.log(`    sections=${secs} items=${items}  origin_run=${p.origin_ingestion_run_id ?? "—"}  raw_input=${p.raw_input ? String(p.raw_input).length + "ch" : "empty"}`);
}
