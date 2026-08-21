// The DATA-SIDE half of the 0026 preflight, run through the existing
// service-role PostgREST client. READ ONLY — selects only.
//
// It cannot cover the catalog-side rows (FK definitions, constraint existence,
// function bodies, RLS flags, grants, cron.job): PostgREST exposes the `public`
// schema's tables and existing RPCs, not information_schema or pg_catalog.
// Those rows still need the SQL editor. Said plainly rather than implied.
import { svc, errText } from "./lib.mts";
async function rows<T>(l: string, q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await q; if (error) throw new Error(`${l}: ${errText(error)}`); return data ?? [];
}
type R = { id: string; destination: string; packet_id: string | null; status: string;
           evidence_purge_after: string | null; error: string | null };
const runs = await rows<R>("runs", svc.from("ingestion_runs")
  .select("id, destination, packet_id, status, evidence_purge_after, error"));
const packets = new Set((await rows<{ id: string }>("packets", svc.from("packets").select("id"))).map((p) => p.id));
const chunks = await rows<{ id: string; segment_text: string | null; fact_ledger: unknown }>(
  "chunks", svc.from("ingestion_chunks").select("id, segment_text, fact_ledger"));
const lib = await rows<{ origin_run_id: string | null }>("library", svc.from("library_items").select("origin_run_id"));

const violating = runs.filter((r) => !((r.destination === "packet" && r.packet_id !== null)
                                    || (r.destination === "library" && r.packet_id === null)));
const missingPacket = runs.filter((r) => r.destination === "packet" && r.packet_id !== null && !packets.has(r.packet_id));
const libWithPacket = runs.filter((r) => r.destination === "library" && r.packet_id !== null);

const line = (ord: string, name: string, expected: string, actual: string) =>
  console.log(`  ${ord.padStart(5)}  ${name.padEnd(58)} exp ${expected.padEnd(6)} got ${actual.padEnd(6)} ${expected === "report" ? "INFO" : expected === actual ? "PASS" : "FAIL"}`);

console.log(`\n0026 PREFLIGHT — data-side rows only (service-role read)\n`);
line("9", "rows violating the PROPOSED coherence rule", "0", String(violating.length));
line("10", "packet runs whose packet row is already missing", "0", String(missingPacket.length));
line("11", "library runs carrying a packet_id", "0", String(libWithPacket.length));
line("14.6", "orphan runs today (packet already gone)", "report", String(missingPacket.length));
line("20", "discarded/finalized runs in the system", "report",
  String(runs.filter((r) => r.status === "discarded" || r.status === "finalized").length));
line("21", "runs already carrying an expiry", "report", String(runs.filter((r) => r.evidence_purge_after).length));
line("22", "chunks holding retained evidence (segment_text)", "report",
  String(chunks.filter((c) => c.segment_text !== null).length));
line("23", "packet runs that would newly retain evidence", "report",
  String(runs.filter((r) => r.destination === "packet").length));
line("—", "library entries referencing a run (orphan-delete guard)", "report",
  String(lib.filter((l) => l.origin_run_id).length));
line("—", "runs currently holding run-level error text", "report",
  String(runs.filter((r) => String(r.error ?? "").trim()).length));

if (violating.length) {
  console.log(`\n  VIOLATIONS — the new constraint could not be created:`);
  for (const r of violating.slice(0, 10)) console.log(`     ${r.id} ${r.destination} packet_id=${r.packet_id}`);
}
console.log(`\n  total runs ${runs.length}   total chunks ${chunks.length}\n`);
