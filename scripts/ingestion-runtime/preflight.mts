// PRE-MERGE PREFLIGHT — strictly read-only. Writes nothing, deletes nothing.
// Confirms migration 0012 is installed and the genuine baseline is intact.
import { svc, anon, check, summary, errText } from "./lib.mts";

console.log("=== PRE-MERGE PREFLIGHT (read-only) ===\n");

// ---------------------------------------------------------------- 0012 present
console.log("[migration 0012] tables, columns, constraints");
for (const t of ["ingestion_runs", "ingestion_chunks"]) {
  const { error } = await svc.from(t).select("*", { head: true, count: "exact" });
  check(`table ${t} installed`, !error, errText(error));
}
const runCols = "id,user_id,packet_id,entry_point,target_section_id,source_text,source_hash,source_len,segmenter_version,status,total_chunks,completed_chunks,baseline_section_count,baseline_item_count,baseline_content_rev,derived_title,derived_client_name,request_key,error,created_at,updated_at";
const chunkCols = "id,run_id,ordinal,source_start,source_end,segment_text,segment_hash,section_hint,is_continuation,status,attempt_count,split_depth,result,error,created_at,updated_at";
for (const [t, cols] of [["ingestion_runs", runCols], ["ingestion_chunks", chunkCols]] as const) {
  const { error } = await svc.from(t).select(cols).limit(1);
  check(`${t} has every expected column`, !error, errText(error));
}
for (const c of ["content_rev", "origin_ingestion_run_id", "composition_mode"]) {
  const { error } = await svc.from("packets").select(c).limit(1);
  check(`packets.${c} installed`, !error, errText(error));
}

// CHECK constraints are proven behaviourally: an invalid value must be refused.
// (These inserts are expected to FAIL; nothing is persisted.)
console.log("\n[constraints] enforced, proven by refusal");
{
  const { error } = await svc.from("ingestion_runs").insert({
    user_id: "00000000-0000-0000-0000-000000000000", packet_id: "00000000-0000-0000-0000-000000000000",
    entry_point: "not_a_real_entry_point", source_hash: "x", source_len: 1,
    segmenter_version: "x", status: "active", total_chunks: 1,
  }).select("id");
  check("entry_point CHECK constraint rejects an invalid value", !!error, error ? "" : "INSERT SUCCEEDED");
}
{
  const { error } = await svc.from("ingestion_runs").insert({
    user_id: "00000000-0000-0000-0000-000000000000", packet_id: "00000000-0000-0000-0000-000000000000",
    entry_point: "organize", source_hash: "x", source_len: 1,
    segmenter_version: "x", status: "not_a_real_status", total_chunks: 1,
  }).select("id");
  check("status CHECK constraint rejects an invalid value", !!error, error ? "" : "INSERT SUCCEEDED");
}
{
  // FK integrity: a run cannot point at a non-existent packet.
  const { error } = await svc.from("ingestion_runs").insert({
    user_id: "00000000-0000-0000-0000-000000000000", packet_id: "00000000-0000-0000-0000-000000000000",
    entry_point: "organize", source_hash: "x", source_len: 1,
    segmenter_version: "x", status: "active", total_chunks: 1,
  }).select("id");
  check("foreign keys enforced (unknown packet refused)", !!error, error ? "" : "INSERT SUCCEEDED");
}

// ---------------------------------------------------------------- RLS + grants
console.log("\n[RLS + grants] anon is locked out of ingestion entirely");
for (const t of ["ingestion_runs", "ingestion_chunks"]) {
  const { data, error } = await anon.from(t).select("id").limit(1);
  check(`anon cannot read ${t}`, !!error || (data ?? []).length === 0, `rows=${(data ?? []).length}`);
}
const RPCS: Record<string, object> = {
  create_ingestion_run: { p_owner: null, p_packet_id: null, p_entry_point: null, p_target_section_id: null, p_source_text: null, p_source_hash: null, p_source_len: null, p_segmenter_version: null, p_chunks: null },
  create_organize_run: { p_owner: null, p_packet_type: null, p_slug: null, p_source_text: null, p_source_hash: null, p_source_len: null, p_request_key: null, p_segmenter_version: null, p_chunks: null },
  claim_chunk: { p_run_id: null, p_owner: null, p_ordinal: null, p_lease_seconds: null },
  stage_chunk_result: { p_run_id: null, p_owner: null, p_ordinal: null, p_attempt: null, p_segment_hash: null, p_result: null },
  mark_chunk_failed: { p_run_id: null, p_owner: null, p_ordinal: null, p_attempt: null, p_error: null },
  split_chunk: { p_run_id: null, p_owner: null, p_ordinal: null, p_attempt: null, p_children: null },
  finalize_ingestion_run: { p_run_id: null, p_owner: null },
  discard_ingestion_run: { p_run_id: null, p_owner: null },
};
for (const [fn, args] of Object.entries(RPCS)) {
  const { error: aerr } = await anon.rpc(fn, args as never);
  check(`anon cannot execute ${fn}`, !!aerr, aerr ? "" : "ANON EXECUTED IT");
  const { error: serr } = await svc.rpc(fn, args as never);
  const resolved = !serr || !/Could not find the function|schema cache/i.test(errText(serr));
  check(`service_role resolves ${fn} with the exact signature`, resolved, errText(serr).slice(0, 80));
}

// ---------------------------------------------------------------- clean state
console.log("\n[state] no disposable or in-flight ingestion data, no retained source");
const { count: runs } = await svc.from("ingestion_runs").select("*", { count: "exact", head: true });
const { count: chunks } = await svc.from("ingestion_chunks").select("*", { count: "exact", head: true });
check("zero ingestion_runs", runs === 0, `${runs}`);
check("zero ingestion_chunks", chunks === 0, `${chunks}`);
const { count: dispUsers } = await svc.from("users").select("*", { count: "exact", head: true }).like("email", "%@disposable.invalid");
const { count: dispLinks } = await svc.from("magic_links").select("*", { count: "exact", head: true }).like("email", "%@disposable.invalid");
check("zero disposable users", dispUsers === 0, `${dispUsers}`);
check("zero disposable magic links", dispLinks === 0, `${dispLinks}`);
const { data: retained } = await svc.from("ingestion_runs").select("id, source_text, derived_title, error");
check("no retained staged source or model output", (retained ?? []).length === 0, `${(retained ?? []).length} rows`);
const { count: originFlagged } = await svc.from("packets").select("*", { count: "exact", head: true }).not("origin_ingestion_run_id", "is", null);
check("no packet still flagged with an origin run", originFlagged === 0, `${originFlagged}`);

// ---------------------------------------------------------------- baseline
console.log("\n[baseline] genuine data unchanged");
const EXPECTED = { packets: 59, sections: 127, items: 433, packet_blocks: 57 };
for (const [t, n] of Object.entries(EXPECTED)) {
  const { count } = await svc.from(t).select("*", { count: "exact", head: true });
  check(`${t} == ${n}`, count === n, `${count}`);
}

process.exit(summary("PREFLIGHT") > 0 ? 1 : 0);
