// READ ONLY. Confirms, through the service-role client, that each migration's
// observable artifact is present in the live schema — the evidence for saying
// "already applied" before any history repair.
//
// PostgREST can see tables and columns; it cannot see functions, policies or
// grants. Those rows are marked accordingly rather than claimed.
import { svc } from "./lib.mts";
type Probe = { version: string; what: string; table: string; column?: string };
const PROBES: Probe[] = [
  { version: "0001", what: "professional links", table: "professional_profiles", column: "links" },
  { version: "0002", what: "professional headshot", table: "professional_profiles", column: "headshot_url" },
  { version: "0003", what: "footer label", table: "professional_profiles", column: "footer_label" },
  { version: "0004", what: "packet identity", table: "packets", column: "client_name" },
  { version: "0007", what: "packet_blocks table", table: "packet_blocks" },
  { version: "0011", what: "item_contacts table", table: "item_contacts" },
  { version: "0012", what: "ingestion_runs table", table: "ingestion_runs" },
  { version: "0013", what: "review jsonb", table: "ingestion_runs", column: "review" },
  { version: "0014", what: "item ingestion provenance", table: "items", column: "origin_run_id" },
  { version: "0016", what: "ownership resolution", table: "packets", column: "origin_ingestion_run_id" },
  { version: "0017", what: "library_items table", table: "library_items" },
  { version: "0020", what: "run destination", table: "ingestion_runs", column: "destination" },
  { version: "0021", what: "library_import_proposals", table: "library_import_proposals" },
  { version: "0024", what: "evidence_purge_after", table: "ingestion_runs", column: "evidence_purge_after" },
  { version: "0024", what: "library origin_run_id", table: "library_items", column: "origin_run_id" },
  { version: "0025", what: "fact_ledger", table: "ingestion_chunks", column: "fact_ledger" },
  { version: "0026", what: "packet_deleted_at (MUST BE ABSENT)", table: "ingestion_runs", column: "packet_deleted_at" },
];
for (const p of PROBES) {
  const { error } = await svc.from(p.table).select(p.column ?? "*").limit(1);
  const present = !error;
  const expected = p.version === "0026" ? false : true;
  const verdict = present === expected ? "OK  " : "MISMATCH";
  console.log(`  ${p.version}  ${verdict}  ${present ? "present" : "absent "}  ${p.what}`);
}
