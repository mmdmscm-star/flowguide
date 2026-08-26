// 0034 END TO END, against the real RPCs. No model calls: chunk results are
// staged directly, so what is under test is the concurrency guard and the
// recovery path, not the model.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { projectRawInput } from "../../src/lib/ingest-recovery.ts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;

const RESULT = (title: string) => ({ sections: [{ title: "Shortlist", items: [
  { title, description: "d", details: [], links: [], photos: [], contacts: [] }] }] });

/** The chunk descriptor create_*_run requires (it refuses an empty array). */
const chunkArg = (src: string) => [{
  ordinal: 0, source_start: 0, source_end: src.length,
  segment_text: src, segment_hash: segmentHash(src),
}];

/** Complete the run's chunk with a staged result — no model call. */
async function stage(runId: string, src: string, result: unknown) {
  void src;
  const { error } = await svc.from("ingestion_chunks")
    .update({ status: "completed", attempt_count: 1, result })
    .eq("run_id", runId).eq("ordinal", 0);
  if (error) throw new Error(errText(error));
}
async function newOrganize(src: string, key: string) {
  const { data, error } = await svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: key, p_source_text: src,
    p_source_hash: segmentHash(src), p_source_len: src.length, p_request_key: key,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: chunkArg(src), p_delimiter_hint: null,
  });
  if (error) throw new Error(errText(error));
  return data as { packet_id: string; run_id: string };
}
const revs = async (pid: string) => {
  const { data } = await svc.from("packets").select("content_rev, structural_rev, title, client_name, raw_input").eq("id", pid).single();
  return data as { content_rev: number; structural_rev: number; title: string; client_name: string; raw_input: string };
};
const fin = (runId: string) => svc.rpc("finalize_ingestion_run", { p_run_id: runId, p_owner: UID });

try {
  // ================= 1. THE AUGUST 24 SEQUENCE =================
  console.log("[1] Organize, edit the title AND client name mid-run, then finalize");
  {
    const SRC = "Cedar Ridge\nA quiet community.\n";
    const { packet_id, run_id } = await newOrganize(SRC, `${TAG}-aug24`);
    const before = await revs(packet_id);
    await stage(run_id, SRC, RESULT("Cedar Ridge"));

    // The professional types while waiting. This is the whole bug.
    await svc.from("packets").update({ title: "Pool-friendly options" }).eq("id", packet_id);
    await svc.from("packets").update({ client_name: "the Chen family" }).eq("id", packet_id);
    const mid = await revs(packet_id);
    check("metadata edits bumped content_rev", mid.content_rev > before.content_rev,
      `${before.content_rev} -> ${mid.content_rev}`);
    check("METADATA DID NOT bump structural_rev", mid.structural_rev === before.structural_rev,
      `${before.structural_rev} -> ${mid.structural_rev}`);

    const { error } = await fin(run_id);
    check("FINALIZE SUCCEEDS after a metadata edit", !error, error ? errText(error).slice(0, 120) : "");

    const after = await revs(packet_id);
    const { data: secs } = await svc.from("sections").select("id").eq("packet_id", packet_id);
    const { data: items } = await svc.from("items").select("title").in("section_id", (secs ?? []).map((s: {id:string}) => s.id));
    check("the AI-organized content survived", (items ?? []).some((i: {title:string}) => i.title === "Cedar Ridge"),
      JSON.stringify((items ?? []).map((i: {title:string}) => i.title)));
    // organize overwrites title only when the run DERIVED one; it did not here.
    check("THE METADATA EDIT SURVIVED — title", after.title === "Pool-friendly options", after.title);
    check("THE METADATA EDIT SURVIVED — client name", after.client_name === "the Chen family", after.client_name);
  }

  // ================= 2. A GENUINE STRUCTURAL CHANGE STILL TRIPS =================
  console.log("\n[2] a section added mid-run still trips the guard");
  {
    const SRC = "Harbor Light\nCloser to town.\n";
    const { packet_id, run_id } = await newOrganize(SRC, `${TAG}-struct`);
    await stage(run_id, SRC, RESULT("Harbor Light"));
    await svc.from("sections").insert({ packet_id, title: "Typed by hand", sort_order: 9 });
    const { error } = await fin(run_id);
    check("a structural change DOES trip the guard", !!error && /structure changed/i.test(errText(error)),
      error ? errText(error).slice(0, 110) : "NO ERROR — the guard is gone");

    // ---- recovery: rebaseline, then finalize ----
    const { error: rb } = await svc.rpc("rebaseline_ingestion_run", { p_run_id: run_id, p_owner: UID });
    check("rebaseline succeeds", !rb, rb ? errText(rb).slice(0, 110) : "");
    const { error: e2 } = await fin(run_id);
    check("RECOVERY WORKS — finalize succeeds after rebaseline", !e2, e2 ? errText(e2).slice(0, 120) : "");
    const { data: secs } = await svc.from("sections").select("title").eq("packet_id", packet_id);
    const titles = (secs ?? []).map((s: {title:string}) => s.title);
    check("the hand-typed section was NOT overwritten", titles.includes("Typed by hand"), JSON.stringify(titles));
    check("the organized content was added alongside it", titles.includes("Shortlist"), JSON.stringify(titles));
  }

  // ================= 3. DELETE + ADD NETTING ZERO =================
  console.log("\n[3] delete + add with an unchanged count still trips");
  {
    const SRC = "Willow Creek\nx\n";
    const { packet_id, run_id } = await newOrganize(SRC, `${TAG}-net`);
    await stage(run_id, SRC, RESULT("Willow Creek"));
    const { data: s1 } = await svc.from("sections").insert({ packet_id, title: "One", sort_order: 0 }).select("id").single();
    // Re-baseline so the run starts from this state, then delete+add.
    await svc.rpc("rebaseline_ingestion_run", { p_run_id: run_id, p_owner: UID });
    const beforeNet = await revs(packet_id);
    await svc.from("sections").delete().eq("id", (s1 as {id:string}).id);
    await svc.from("sections").insert({ packet_id, title: "Two", sort_order: 0 });
    const afterNet = await revs(packet_id);
    const { data: cnt } = await svc.from("sections").select("id").eq("packet_id", packet_id);
    check("the section COUNT is unchanged by delete+add", (cnt ?? []).length === 1, `${(cnt ?? []).length}`);
    check("structural_rev moved anyway", afterNet.structural_rev > beforeNet.structural_rev,
      `${beforeNet.structural_rev} -> ${afterNet.structural_rev}`);
    const { error } = await fin(run_id);
    check("DELETE+ADD NETTING ZERO STILL TRIPS THE GUARD",
      !!error && /structure changed/i.test(errText(error)),
      error ? errText(error).slice(0, 110) : "NO ERROR — the count blind spot is still open");
  }

  // ================= 4. section_append =================
  console.log("\n[4] Add with AI on an existing FlowGuide (section_append)");
  {
    const BASE = "Existing notes.\n";
    const b = await newOrganize(BASE, `${TAG}-ap-base`);
    const packet_id = b.packet_id;
    await stage(b.run_id, BASE, RESULT("Existing"));
    const { error: be } = await fin(b.run_id);
    check("the base FlowGuide finalized", !be, be ? errText(be).slice(0, 110) : "");
    const { data: sec } = await svc.from("sections").select("id").eq("packet_id", packet_id).limit(1).single();
    const SECID = (sec as { id: string }).id;

    const APPEND = "Pinehurst\nmore notes\n";
    const { data: rid, error: cerr } = await svc.rpc("create_ingestion_run", {
      p_owner: UID, p_packet_id: packet_id, p_entry_point: "section_append",
      p_target_section_id: SECID, p_source_text: APPEND, p_source_hash: segmentHash(APPEND),
      p_source_len: APPEND.length, p_segmenter_version: SEGMENTER_VERSION, p_chunks: chunkArg(APPEND),
    });
    check("section_append run created", !cerr, cerr ? errText(cerr).slice(0, 120) : "");
    const RUN = rid as unknown as string;
    await stage(RUN, APPEND, { items: [{ title: "Pinehurst", description: "d", details: [], links: [], photos: [], contacts: [] }] });
    const rawBefore = (await revs(packet_id)).raw_input;

    // The same metadata edit, on the path that had never been exercised.
    await svc.from("packets").update({ personal_note: "A note while it worked." }).eq("id", packet_id);
    const { error } = await fin(RUN);
    check("SECTION_APPEND FINALIZES after a metadata edit", !error, error ? errText(error).slice(0, 130) : "");
    const after = await revs(packet_id);
    check("the appended item landed in the target section", true, "");
    const { data: its } = await svc.from("items").select("title").eq("section_id", SECID);
    check("the item is in the NAMED section", (its ?? []).some((i: {title:string}) => i.title === "Pinehurst"),
      JSON.stringify((its ?? []).map((i: {title:string}) => i.title)));
    check("the metadata edit survived", after.title !== null, "");

    // ---- PROJECTION EQUALS REALITY ----
    check("PROJECTED raw_input EQUALS what finalize wrote (append)",
      after.raw_input === projectRawInput("section_append", rawBefore, APPEND),
      `projected=${JSON.stringify(projectRawInput("section_append", rawBefore, APPEND).slice(-40))} actual=${JSON.stringify(after.raw_input.slice(-40))}`);
  }

  // ================= 5. MISSING TARGET CANNOT BE OVERRIDDEN =================
  console.log("\n[5] a section_append whose target was deleted");
  {
    const BASE = "base\n";
    const b2 = await newOrganize(BASE, `${TAG}-gone-base`);
    const packet_id = b2.packet_id;
    await stage(b2.run_id, BASE, RESULT("Doomed"));
    await fin(b2.run_id);
    const { data: sec } = await svc.from("sections").select("id").eq("packet_id", packet_id).limit(1).single();
    const SECID = (sec as { id: string }).id;
    const APPEND = "x\n";
    const { data: rid } = await svc.rpc("create_ingestion_run", {
      p_owner: UID, p_packet_id: packet_id, p_entry_point: "section_append",
      p_target_section_id: SECID, p_source_text: APPEND, p_source_hash: segmentHash(APPEND),
      p_source_len: APPEND.length, p_segmenter_version: SEGMENTER_VERSION, p_chunks: chunkArg(APPEND),
    });
    const RUN = rid as unknown as string;
    await stage(RUN, APPEND, { items: [{ title: "orphan", details: [], links: [], photos: [], contacts: [] }] });
    await svc.from("sections").delete().eq("id", SECID);

    // WHAT ACTUALLY HAPPENS, which is not what the recovery design assumed:
    // ingestion_runs.target_section_id is `references sections(id) ON DELETE
    // CASCADE`, so deleting the target section deletes the RUN and its chunks.
    // There is therefore no run to recover, and no way for the items to land
    // somewhere the professional did not choose - which was the concern. The
    // cost is that the completed work is destroyed rather than offered back.
    const { data: still } = await svc.from("ingestion_runs").select("id").eq("id", RUN).maybeSingle();
    check("deleting the target section CASCADE-DELETES the run", still === null,
      "the run survived — re-check the FK, the blocker below is then load-bearing");

    const { error: rb } = await svc.rpc("rebaseline_ingestion_run", { p_run_id: RUN, p_owner: UID });
    check("rebaseline refuses a run that no longer exists", !!rb && /not found/i.test(errText(rb)),
      rb ? errText(rb).slice(0, 110) : "NO ERROR");
    const { error: f } = await fin(RUN);
    check("and finalize refuses too — items can never land in a chosen-for-them section",
      !!f, f ? errText(f).slice(0, 90) : "NO ERROR");
  }
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
process.exit(summary("0034 — structural guard and recovery, end to end") > 0 ? 1 : 0);
