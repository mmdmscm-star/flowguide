// WHAT WHOLE-PACKET DELETION DOES TO AN IN-FLIGHT section_append RUN.
//
// Captured BEFORE 0035 so the trigger can be proven not to change it. Prints a
// canonical shape; the 0035 test asserts the identical shape afterwards.
import { svc, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
try {
  const BASE = "base\n", APPEND = "more\n";
  const { data: o } = await svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: TAG, p_source_text: BASE,
    p_source_hash: segmentHash(BASE), p_source_len: BASE.length, p_request_key: `${TAG}-b`,
    p_segmenter_version: SEGMENTER_VERSION, p_delimiter_hint: null,
    p_chunks: [{ ordinal: 0, source_start: 0, source_end: BASE.length, segment_text: BASE, segment_hash: segmentHash(BASE) }],
  });
  const { packet_id, run_id } = o as { packet_id: string; run_id: string };
  await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1,
    result: { sections: [{ title: "S", items: [{ title: "I", details: [], links: [], photos: [], contacts: [] }] }] } })
    .eq("run_id", run_id).eq("ordinal", 0);
  await svc.rpc("finalize_ingestion_run", { p_run_id: run_id, p_owner: UID });
  const { data: sec } = await svc.from("sections").select("id").eq("packet_id", packet_id).limit(1).single();
  const SECID = (sec as { id: string }).id;

  const { data: rid, error: ce } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: packet_id, p_entry_point: "section_append",
    p_target_section_id: SECID, p_source_text: APPEND, p_source_hash: segmentHash(APPEND),
    p_source_len: APPEND.length, p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: [{ ordinal: 0, source_start: 0, source_end: APPEND.length, segment_text: APPEND, segment_hash: segmentHash(APPEND) }],
  });
  if (ce) { console.error(errText(ce)); process.exit(1); }
  const RUN = rid as unknown as string;
  await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1,
    result: { items: [{ title: "appended", details: [], links: [], photos: [], contacts: [] }] } })
    .eq("run_id", RUN).eq("ordinal", 0);

  // ---- delete the whole packet -------------------------------------------
  const { error: de } = await svc.from("packets").delete().eq("id", packet_id);
  console.log(`packet delete error: ${de ? errText(de) : "(none — succeeded)"}`);

  const { data: run } = await svc.from("ingestion_runs").select("*").eq("id", RUN).maybeSingle();
  const { data: chunks } = await svc.from("ingestion_chunks").select("ordinal, status, result").eq("run_id", RUN);
  const r = run as Record<string, unknown> | null;
  console.log(JSON.stringify({
    runStillExists: !!r,
    status: r?.status ?? null,
    packet_id: r?.packet_id ?? null,
    packet_deleted_at_set: !!r?.packet_deleted_at,
    evidence_purge_after_set: !!r?.evidence_purge_after,
    target_section_id: r?.target_section_id ?? null,
    chunkRows: (chunks ?? []).length,
    chunkStatuses: (chunks ?? []).map((c: { status: string }) => c.status),
    chunkResultsIntact: (chunks ?? []).every((c: { result: unknown }) => !!c.result),
  }, null, 2));
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
}
