// THE RECOVERY PATH OVER HTTP — the route and its verdict, not just the RPCs.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers||{}) } });

const SRC = "Cedar Ridge\nA quiet community.\nPhoto: https://cdn.example.com/a.jpg\n";
const RESULT = { sections: [{ title: "Shortlist", items: [
  { title: "Cedar Ridge", description: "d", details: [], links: [],
    photos: ["https://cdn.example.com/a.jpg"], contacts: [] }] }] };

async function freshRun(key: string) {
  const { data, error } = await svc.rpc("create_organize_run", {
    p_owner: UID, p_packet_type: "general", p_slug: key, p_source_text: SRC,
    p_source_hash: segmentHash(SRC), p_source_len: SRC.length, p_request_key: key,
    p_segmenter_version: SEGMENTER_VERSION, p_delimiter_hint: null,
    p_chunks: [{ ordinal: 0, source_start: 0, source_end: SRC.length, segment_text: SRC, segment_hash: segmentHash(SRC) }],
  });
  if (error) throw new Error(errText(error));
  const { packet_id, run_id } = data as { packet_id: string; run_id: string };
  await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1, result: RESULT })
    .eq("run_id", run_id).eq("ordinal", 0);
  return { packet_id, run_id };
}

try {
  // ---- 1. RECOVERABLE: a hand-typed section during the run -----------------
  console.log("[1] structural change -> 409 with an offerable recovery");
  {
    const { packet_id, run_id } = await freshRun(`${TAG}-ok`);
    await svc.from("sections").insert({ packet_id, title: "Typed by hand", sort_order: 9 });
    const res = await api(`/api/ingest/${run_id}/finalize`, { method: "POST" });
    const body = await res.json();
    check("the route answers 409", res.status === 409, String(res.status));
    check("with error=structure_changed", body?.error === "structure_changed", JSON.stringify(body).slice(0, 120));
    check("AND OFFERS RECOVERY", body?.recovery?.canApply === true, JSON.stringify(body?.recovery));
    check("the message says nothing is lost", /nothing has been lost/i.test(String(body?.message)), String(body?.message).slice(0, 90));

    const res2 = await api(`/api/ingest/${run_id}/finalize`, {
      method: "POST", body: JSON.stringify({ acceptStructuralChange: true }) });
    const body2 = await res2.json();
    check("APPLY ANYWAY SUCCEEDS", res2.ok && body2?.ok === true, `${res2.status} ${JSON.stringify(body2).slice(0,110)}`);
    const { data: secs } = await svc.from("sections").select("title").eq("packet_id", packet_id);
    const titles = (secs ?? []).map((s: {title:string}) => s.title);
    check("the hand-typed section survived", titles.includes("Typed by hand"), JSON.stringify(titles));
    check("the organized content was added", titles.includes("Shortlist"), JSON.stringify(titles));
    const { data: run } = await svc.from("ingestion_runs").select("status").eq("id", run_id).single();
    check("the run is finalized, not stranded", (run as {status:string}).status === "finalized", JSON.stringify(run));
  }

  // ---- 2. NOT RECOVERABLE: a photo pasted in from outside ------------------
  console.log("\n[2] an external photo pasted mid-run -> recovery WITHHELD");
  {
    const { packet_id, run_id } = await freshRun(`${TAG}-media`);
    const { data: sec } = await svc.from("sections").insert({ packet_id, title: "Hand", sort_order: 9 }).select("id").single();
    const { data: it } = await svc.from("items").insert({ section_id: (sec as {id:string}).id, title: "X", sort_order: 0 }).select("id").single();
    await svc.from("item_photos").insert({ item_id: (it as {id:string}).id,
      url: "https://images.example.net/pasted-during-the-run.jpg", storage_path: "", sort_order: 0 });

    const res = await api(`/api/ingest/${run_id}/finalize`, { method: "POST" });
    const body = await res.json();
    check("the route answers 409", res.status === 409, String(res.status));
    check("RECOVERY IS WITHHELD", body?.recovery?.canApply === false, JSON.stringify(body?.recovery));
    check("and names the reason", (body?.recovery?.blockers ?? []).some((b: {code:string}) => b.code === "media_not_in_source"),
      JSON.stringify(body?.recovery?.blockers));
    check("the message warns about publishing", /unpublishable/i.test(String(body?.message)), String(body?.message).slice(0, 110));
    const { data: run } = await svc.from("ingestion_runs").select("status").eq("id", run_id).single();
    check("the run is left active so nothing is destroyed", (run as {status:string}).status === "active", "");
  }
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
process.exit(summary("RECOVERY over HTTP") > 0 ? 1 : 0);
