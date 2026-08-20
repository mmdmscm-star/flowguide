// READ ONLY. Which Library entries came from the bulk AI import, and which
// predate it? Established from creation history and lineage, NOT from titles.
//
// Title-based provenance would be circular here: the question is which entries
// belong to the run, and the user's recollection of which four they removed is
// exactly the thing worth corroborating independently.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type E = { id: string; title: string; created_at: string; updated_at: string; revision: number;
           source_packet_item_id: string | null; origin_run_id: string | null };
const all = await rows<E>("library", svc.from("library_items")
  .select("id, title, created_at, updated_at, revision, source_packet_item_id, origin_run_id").order("created_at"));

const runs = await rows<{ id: string; created_at: string; finalized_at: string | null; total_chunks: number }>(
  "runs", svc.from("ingestion_runs").select("id, created_at, finalized_at, total_chunks")
    .eq("destination", "library").order("created_at"));

console.log(`\nLIBRARY IMPORT RUNS`);
for (const r of runs) console.log(`  ${r.id.slice(0, 8)}  created ${r.created_at}  finalized ${r.finalized_at ?? "—"}  chunks ${r.total_chunks}`);

// Cluster by creation minute. A bulk import writes its entries in one burst;
// anything saved by hand on another day sits far outside that window.
const byMinute = new Map<string, number>();
for (const e of all) byMinute.set(e.created_at.slice(0, 16), (byMinute.get(e.created_at.slice(0, 16)) ?? 0) + 1);
console.log(`\nCREATION CLUSTERS (entries per minute)`);
for (const [m, n] of [...byMinute.entries()].sort()) console.log(`  ${m}   ${String(n).padStart(3)}  ${"█".repeat(n)}`);

const bulk = runs.length ? runs[runs.length - 1] : null;
const start = bulk ? new Date(bulk.created_at).getTime() : 0;
const end = bulk?.finalized_at ? new Date(bulk.finalized_at).getTime() : Date.now();
const during = all.filter((e) => { const t = new Date(e.created_at).getTime(); return t >= start - 60_000 && t <= end + 60_000; });
const before = all.filter((e) => new Date(e.created_at).getTime() < start - 60_000);

console.log(`\nSPLIT BY THE BULK RUN'S OWN WINDOW  (${bulk?.created_at} → ${bulk?.finalized_at})`);
console.log(`  created DURING the bulk run ... ${during.length}`);
console.log(`  created BEFORE it ............. ${before.length}`);
console.log(`\n  entries predating the bulk run:`);
for (const e of before) console.log(`    ${e.created_at.slice(0, 16)}  rev ${e.revision}  ${e.source_packet_item_id ? "from a packet item" : "no packet lineage "}  ${e.title}`);

console.log(`\n  LINEAGE SIGNAL`);
console.log(`    entries with source_packet_item_id (saved from a packet) : ${all.filter((e) => e.source_packet_item_id).length}`);
console.log(`    entries with origin_run_id (0024 provenance, post-hoc)   : ${all.filter((e) => e.origin_run_id).length}`);
console.log(`    entries revised since creation (updated_at > created_at) : ${all.filter((e) => new Date(e.updated_at).getTime() - new Date(e.created_at).getTime() > 2000).length}`);
console.log("");
