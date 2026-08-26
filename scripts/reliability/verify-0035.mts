// 0035: a section cannot be deleted while a section_append is writing into it.
// Every refusal is checked by SQLSTATE, never by message text.
import { svc, anon, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const code = (e: unknown) => (e as { code?: string } | null)?.code ?? "";
let n = 0;

/** A published-shaped packet with one finalized section. */
async function basePacket() {
  const BASE = "base\n"; const key = `${TAG}-${n++}`;
  const { data: o, error } = await svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: key, p_source_text: BASE,
    p_source_hash: segmentHash(BASE), p_source_len: BASE.length, p_request_key: key,
    p_segmenter_version: SEGMENTER_VERSION, p_delimiter_hint: null,
    p_chunks: [{ ordinal: 0, source_start: 0, source_end: BASE.length, segment_text: BASE, segment_hash: segmentHash(BASE) }],
  });
  if (error) throw new Error(errText(error));
  const { packet_id, run_id } = o as { packet_id: string; run_id: string };
  await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1,
    result: { sections: [{ title: "S", items: [{ title: "I", details: [], links: [], photos: [], contacts: [] }] }] } })
    .eq("run_id", run_id).eq("ordinal", 0);
  await svc.rpc("finalize_ingestion_run", { p_run_id: run_id, p_owner: UID });
  const { data: sec } = await svc.from("sections").select("id").eq("packet_id", packet_id).limit(1).single();
  return { packet_id, sectionId: (sec as { id: string }).id };
}
async function startAppend(packet_id: string, sectionId: string) {
  const A = "more\n"; const key = `${TAG}-ap-${n++}`;
  const { data: rid, error } = await svc.rpc("create_ingestion_run", {
    p_owner: UID, p_packet_id: packet_id, p_entry_point: "section_append",
    p_target_section_id: sectionId, p_source_text: A, p_source_hash: segmentHash(A),
    p_source_len: A.length, p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: [{ ordinal: 0, source_start: 0, source_end: A.length, segment_text: A, segment_hash: segmentHash(A) }],
  });
  if (error) throw new Error(`${key}: ${errText(error)}`);
  const RUN = rid as unknown as string;
  await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1,
    result: { items: [{ title: "appended", details: [], links: [], photos: [], contacts: [] }] } })
    .eq("run_id", RUN).eq("ordinal", 0);
  return RUN;
}

try {
  // 1 ---------------------------------------------------------------------
  { const { sectionId } = await basePacket();
    const { error } = await svc.from("sections").delete().eq("id", sectionId);
    check("[1] an ordinary section with no active run still deletes", !error, errText(error)); }

  // 2 + 3 -----------------------------------------------------------------
  { const { packet_id, sectionId } = await basePacket();
    const RUN = await startAppend(packet_id, sectionId);
    const { error } = await svc.from("sections").delete().eq("id", sectionId);
    check("[2] a TARGETED section is refused", !!error, "the delete succeeded");
    check("[2] refused with SQLSTATE FG001", code(error) === "FG001", `code=${code(error)} msg=${errText(error).slice(0,70)}`);
    const { data: still } = await svc.from("sections").select("id").eq("id", sectionId).maybeSingle();
    check("[2] the section is still there", !!still, "");
    const { data: run } = await svc.from("ingestion_runs").select("status").eq("id", RUN).maybeSingle();
    const { data: ch } = await svc.from("ingestion_chunks").select("status, result").eq("run_id", RUN);
    check("[3] THE RUN SURVIVED the blocked delete", (run as {status:string} | null)?.status === "active", JSON.stringify(run));
    check("[3] its completed chunk row survived", (ch ?? []).length === 1, `${(ch ?? []).length} rows`);
    check("[3] AND THE RESULT IS STILL THERE", !!(ch ?? [])[0]?.result, "the staged result was lost");

    // 4 -------------------------------------------------------------------
    await svc.rpc("discard_ingestion_run", { p_run_id: RUN, p_owner: UID });
    const { error: e4 } = await svc.from("sections").delete().eq("id", sectionId);
    check("[4] after DISCARD the section deletes", !e4, errText(e4)); }

  // 5 ---------------------------------------------------------------------
  { const { packet_id, sectionId } = await basePacket();
    const RUN = await startAppend(packet_id, sectionId);
    const { error: fe } = await svc.rpc("finalize_ingestion_run", { p_run_id: RUN, p_owner: UID });
    check("[5] the append finalizes", !fe, errText(fe).slice(0, 90));
    const { error: e5 } = await svc.from("sections").delete().eq("id", sectionId);
    check("[5] after FINALIZE the section deletes", !e5, errText(e5)); }

  // 6 --- packet deletion, and the EXACT measured semantics ---------------
  { const { packet_id, sectionId } = await basePacket();
    const RUN = await startAppend(packet_id, sectionId);
    const { error: de } = await svc.from("packets").delete().eq("id", packet_id);
    check("[6] WHOLE-PACKET DELETION STILL SUCCEEDS", !de, errText(de).slice(0, 90));
    const { data: run } = await svc.from("ingestion_runs").select("id").eq("id", RUN).maybeSingle();
    const { data: ch } = await svc.from("ingestion_chunks").select("ordinal").eq("run_id", RUN);
    // Byte-for-byte the shape measured BEFORE 0035: run gone, chunks gone.
    check("[6] the run is deleted, as before 0035", run === null, JSON.stringify(run));
    check("[6] its chunk rows are deleted, as before 0035", (ch ?? []).length === 0, `${(ch ?? []).length} rows`);
    const { data: sec } = await svc.from("sections").select("id").eq("id", sectionId).maybeSingle();
    check("[6] the section went with the packet", sec === null, ""); }

  // 7 ---------------------------------------------------------------------
  { const { packet_id, sectionId } = await basePacket();
    // An ORGANIZE run has no target_section_id; it must not lock unrelated sections.
    const B = "x\n"; const key = `${TAG}-org-${n++}`;
    const { data: rid } = await svc.rpc("create_ingestion_run", {
      p_owner: UID, p_packet_id: packet_id, p_entry_point: "append", p_target_section_id: null,
      p_source_text: B, p_source_hash: segmentHash(B), p_source_len: B.length,
      p_segmenter_version: SEGMENTER_VERSION,
      p_chunks: [{ ordinal: 0, source_start: 0, source_end: B.length, segment_text: B, segment_hash: segmentHash(B) }],
    });
    void key;
    const { data: r7 } = await svc.from("ingestion_runs").select("status, target_section_id").eq("id", rid as unknown as string).single();
    check("[7] the append run is active with no target", (r7 as {status:string}).status === "active" && (r7 as {target_section_id:string|null}).target_section_id === null, JSON.stringify(r7));
    const { error: e7 } = await svc.from("sections").delete().eq("id", sectionId);
    check("[7] a non-section_append run does NOT block an unrelated section delete", !e7, errText(e7)); }

  // 8 --- no new privilege surface ----------------------------------------
  { const { error } = await anon.rpc("block_section_delete_during_ingest", {});
    check("[8] anon cannot call the trigger function",
      /permission denied|Could not find the function|schema cache/i.test(error ? errText(error) : ""),
      error ? errText(error).slice(0, 80) : "NO ERROR — it is callable"); }

  // 9 --- CONCURRENCY: a delete racing the start of an append -------------
  { const { packet_id, sectionId } = await basePacket();
    // Fire both without awaiting between them. Whatever the interleaving, the
    // invariant is the same: there must never be an ACTIVE run pointing at a
    // section that no longer exists.
    const results = await Promise.allSettled([
      startAppend(packet_id, sectionId),
      svc.from("sections").delete().eq("id", sectionId),
    ]);
    const startedOk = results[0].status === "fulfilled";
    const delRes = results[1].status === "fulfilled" ? (results[1].value as { error: unknown }) : null;
    const deletedOk = !!delRes && !delRes.error;
    console.log(`    race outcome: append_started=${startedOk} section_deleted=${deletedOk}` +
      (delRes?.error ? ` (delete code=${code(delRes.error)})` : ""));
    const { data: sec } = await svc.from("sections").select("id").eq("id", sectionId).maybeSingle();
    const { data: runs } = await svc.from("ingestion_runs")
      .select("id, status, target_section_id").eq("packet_id", packet_id).eq("entry_point", "section_append");
    const dangling = (runs ?? []).filter((r: { status: string; target_section_id: string | null }) =>
      ["active","finalizing"].includes(r.status) && r.target_section_id !== null && sec === null);
    check("[9] NO ACTIVE RUN IS LEFT POINTING AT A DELETED SECTION", dangling.length === 0,
      `${dangling.length} dangling: ${JSON.stringify(dangling)}`);
    check("[9] the outcome is one of the two coherent ones",
      (startedOk && !deletedOk) || (!startedOk && deletedOk) || (startedOk && deletedOk && sec !== null) || (!startedOk && !deletedOk),
      `started=${startedOk} deleted=${deletedOk} sectionStillThere=${sec !== null}`); }
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
process.exit(summary("0035 — section delete guard") > 0 ? 1 : 0);
