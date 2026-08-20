// READ ONLY. Show one Library entry exactly as stored, for semantic review.
//   FLOWGUIDE_RT_CONFIRM=1 TITLE="Mountain View" npx tsx scripts/ingestion-runtime/inspect-entry.mts
import { svc, errText } from "./lib.mts";
const TITLE = process.env.TITLE;
if (!TITLE) { console.error('TITLE="…" required'); process.exit(1); }
const { data, error } = await svc.from("library_items")
  .select("id, title, address, description, notes, details, links, photos, contacts, created_at")
  .ilike("title", `%${TITLE}%`);
if (error) throw new Error(errText(error));
for (const e of (data ?? []) as Record<string, any>[]) {
  console.log(`\n${"=".repeat(70)}\n${e.title}   (created ${String(e.created_at).slice(0, 16)})`);
  console.log(`  address:     ${e.address ?? "—"}`);
  console.log(`  description: ${(e.description ?? "—").slice(0, 200)}`);
  console.log(`  details (${(e.details ?? []).length}):`);
  for (const d of e.details ?? []) console.log(`      ${String(d.label ?? "").padEnd(28)} ${d.value ?? ""}`);
  console.log(`  contacts (${(e.contacts ?? []).length}): ${(e.contacts ?? []).map((c: any) => [c.name, c.role, c.phone, c.email].filter(Boolean).join(" / ")).join("  |  ") || "—"}`);
  console.log(`  links: ${(e.links ?? []).map((l: any) => l.label ?? l.url).join(", ") || "—"}   photos: ${(e.photos ?? []).length}`);
  console.log(`  NOTES:\n      ${(e.notes ?? "—").replace(/\n/g, "\n      ")}`);
}
