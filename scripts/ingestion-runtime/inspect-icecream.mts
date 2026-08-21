import { svc } from "./lib.mts";
const RUN = "73c7d25b-c27d-4e41-b89e-fd901c93ff9e";
const { data: chunks } = await svc.from("ingestion_chunks")
  .select("ordinal, status, segment_text, result, fact_ledger, source_start, source_end").eq("run_id", RUN).order("ordinal");
console.log(`chunks: ${(chunks ?? []).length}`);
for (const c of (chunks ?? []) as any[])
  console.log(`  #${c.ordinal} ${c.status}  segment=${c.segment_text === null ? "CLEARED" : c.segment_text.length + "ch"}  result=${c.result === null ? "CLEARED" : "present"}  ledger=${c.fact_ledger === null ? "CLEARED" : "present"}`);

const { data: run } = await svc.from("ingestion_runs").select("packet_id, user_id").eq("id", RUN).single();
const pid = (run as any).packet_id;
const { data: secs } = await svc.from("sections").select("id, title").eq("packet_id", pid);
const secIds = (secs ?? []).map((s: any) => s.id);
const { data: items } = await svc.from("items").select("id, title, address, description, notes").in("section_id", secIds).order("sort_order");
console.log(`\npacket ${pid}: ${(secs ?? []).length} section(s), ${(items ?? []).length} items`);
const ids = (items ?? []).map((i: any) => i.id);
const { data: links } = await svc.from("item_links").select("item_id, url, label").in("item_id", ids);
const { data: contacts } = await svc.from("item_contacts").select("item_id, name, phone, email, website").in("item_id", ids);
const { data: details } = await svc.from("item_details").select("item_id, label, value").in("item_id", ids);
const byItem = (rows: any[], id: string) => (rows ?? []).filter((r) => r.item_id === id);
for (const it of (items ?? []) as any[]) {
  const L = byItem(links as any[], it.id), C = byItem(contacts as any[], it.id), D = byItem(details as any[], it.id);
  console.log(`\n  ${it.title}`);
  console.log(`    address:  ${it.address ?? "—"}`);
  console.log(`    links:    ${L.length ? L.map((l: any) => l.url).join(", ") : "NONE"}`);
  console.log(`    contacts: ${C.map((c: any) => [c.name, c.phone, c.email, c.website].filter(Boolean).join(" / ")).join(" | ") || "—"}`);
  console.log(`    details:  ${D.map((d: any) => `${d.label}=${String(d.value).slice(0, 40)}`).join(" | ") || "—"}`);
  console.log(`    desc:     ${String(it.description ?? "").slice(0, 90)}`);
  console.log(`    notes:    ${it.notes ? String(it.notes).slice(0, 90) : "—"}`);
}
