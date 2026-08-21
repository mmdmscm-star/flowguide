import { svc } from "./lib.mts";
const { data: us } = await svc.from("users").select("id, email").like("email", "flowguide-diag-%");
for (const u of (us ?? []) as { id: string; email: string }[]) {
  const { data: rs } = await svc.from("ingestion_runs")
    .select("id, status, total_chunks, completed_chunks, source_len").eq("user_id", u.id);
  for (const r of (rs ?? []) as Record<string, unknown>[]) {
    const { count: done } = await svc.from("ingestion_chunks")
      .select("id", { count: "exact", head: true }).eq("run_id", r.id as string).eq("status", "completed");
    const { count: led } = await svc.from("ingestion_chunks")
      .select("id", { count: "exact", head: true }).eq("run_id", r.id as string).not("fact_ledger", "is", null);
    console.log(`  ${u.email.split("@")[0]}  run ${String(r.id).slice(0,8)}  ${r.status}  chunks ${done}/${r.total_chunks} complete, ${led} with a ledger`);
  }
}
if (!(us ?? []).length) console.log("  no diagnostic users present (not started, or already cleaned up)");
