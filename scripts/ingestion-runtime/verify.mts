// READ-ONLY post-migration verification. Writes nothing.
import { svc, anon, census, fingerprint, check, summary, errText } from "./lib.mts";
import { writeFileSync } from "node:fs";

console.log("=== READ-ONLY POST-MIGRATION VERIFICATION ===\n");

console.log("[schema] new tables + columns present");
for (const t of ["ingestion_runs", "ingestion_chunks"]) {
  const { error } = await svc.from(t).select("*", { head: true, count: "exact" });
  check(`table ${t} exists`, !error, errText(error));
}
const runCols = "id,user_id,packet_id,entry_point,target_section_id,source_text,source_hash,source_len,segmenter_version,status,total_chunks,completed_chunks,baseline_section_count,baseline_item_count,baseline_content_rev,derived_title,derived_client_name,request_key,error,created_at,updated_at";
// The lease is keyed off updated_at (see claim_chunk); there is no claimed_at.
const chunkCols = "id,run_id,ordinal,source_start,source_end,segment_text,segment_hash,section_hint,is_continuation,status,attempt_count,split_depth,result,error,created_at,updated_at";
for (const [t, cols] of [["ingestion_runs", runCols], ["ingestion_chunks", chunkCols]] as const) {
  const { error } = await svc.from(t).select(cols).limit(1);
  check(`${t} has all expected columns`, !error, errText(error));
}
for (const c of ["content_rev", "origin_ingestion_run_id", "composition_mode"]) {
  const { error } = await svc.from("packets").select(c).limit(1);
  check(`packets.${c} present`, !error, errText(error));
}

console.log("\n[grants] callable RPCs are service-role-only");
const RPCS = {
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
  // anon must be denied entirely (permission denied / not exposed), never executed
  const { error: aerr } = await anon.rpc(fn, args as any);
  const denied = !!aerr && /permission denied|does not exist|not find|schema cache|Unauthorized/i.test(errText(aerr));
  check(`anon cannot execute ${fn}`, denied, aerr ? errText(aerr).slice(0, 90) : "ANON CALL SUCCEEDED");

  // service_role must resolve the exact named signature (not "function not found")
  const { error: serr } = await svc.rpc(fn, args as any);
  const resolved = !serr || !/Could not find the function|schema cache/i.test(errText(serr));
  check(`service_role resolves ${fn} signature`, resolved, serr ? errText(serr).slice(0, 90) : "");
}

console.log("\n[triggers] publish guard + content_rev exist as callable behavior");
// Presence only (behavioral proof happens in the runtime suite).
const { error: cr } = await svc.from("packets").select("content_rev").limit(1);
check("content_rev readable", !cr, errText(cr));

console.log("\n[baseline] genuine data census");
const c = await census();
const fp = await fingerprint();
console.log(JSON.stringify(c, null, 2));
writeFileSync(new URL("./baseline.json", import.meta.url), JSON.stringify({ census: c, fingerprint: fp }, null, 2));
check("baseline captured", Object.values(c).every((n) => n >= 0), JSON.stringify(c));
check("no pre-existing ingestion_runs rows (clean slate)", c.ingestion_runs === 0, `found ${c.ingestion_runs}`);

process.exit(summary("READ-ONLY VERIFICATION") > 0 ? 1 : 0);
