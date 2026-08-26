// PRODUCTION SMOKE for the Library importer's runtime boundaries.
// Disposable user, tiny crafted sources, real routes. No full 65-community run:
// what is under test is the GATES, and each has its own minimal fixture.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers||{}) } });

/** Stage a run with crafted chunk results — no model call, so the GATES are
 *  what is exercised rather than the model's mood. */
async function stagedRun(chunks: { text: string; items: unknown[] }[]) {
  const src = chunks.map((c) => c.text).join("\n\n");
  const { data, error } = await svc.rpc("create_library_import_run", {
    p_owner: UID, p_source_text: src, p_source_hash: segmentHash(src), p_source_len: src.length,
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks.map((c, i) => ({
      ordinal: i, source_start: 0, source_end: c.text.length,
      segment_text: c.text, segment_hash: segmentHash(c.text),
    })),
  });
  if (error) throw new Error(errText(error));
  const runId = (data as { run_id?: string })?.run_id ?? (data as unknown as string);
  for (let i = 0; i < chunks.length; i++) {
    await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1, result: { items: chunks[i].items } })
      .eq("run_id", runId).eq("ordinal", i);
  }
  const pr = await api(`/api/library/import/${runId}/proposals`, { method: "POST" });
  const body = await pr.json();
  return { runId, status: pr.status, proposals: (body?.proposals ?? []) as Record<string, unknown>[], merged: body?.merged };
}
const save = async (runId: string, ids: string[]) =>
  (await api(`/api/library/import/${runId}/save`, { method: "POST", body: JSON.stringify({ proposalIds: ids }) })).json();
/** Only one library import may be active per user, so each fixture closes its
 *  own run before the next begins. */
const closeRun = async (runId: string) => {
  await svc.rpc("library_close_import_run", { p_owner: UID, p_run_id: runId, p_status: "finalized" })
    .then(() => {}, () => {});
  await svc.from("ingestion_runs").update({ status: "finalized" }).eq("id", runId).eq("status", "active");
};

try {
  // ---- 1. cross-chunk halves recombine ------------------------------------
  {
    const r = await stagedRun([
      { text: "Alpha Manor — Novato\n Community Phone: (415) 111-2222\n Studio - $4,000/month",
        items: [{ title: "Alpha Manor — Novato", details: [{ label: "Studio", value: "$4,000/month" }],
                  contacts: [{ role: "Community", phone: "(415) 111-2222" }], links: [], photos: [] }] },
      { text: "A quiet community with a garden.\nAlpha Manor photos follow.",
        items: [{ title: "Alpha Manor", description: "A quiet community with a garden.", details: [], links: [], photos: ["https://cdn.example.com/a.jpg"] }] },
    ]);
    check("[1] two halves become ONE record", r.proposals.length === 1, `${r.proposals.length} proposals`);
    check("[1] the merge was reported", r.merged === 1, String(r.merged));
    const p = r.proposals[0];
    check("[1] pricing from the first half survived", JSON.stringify(p).includes("$4,000"), "");
    check("[1] description from the second half survived", JSON.stringify(p).includes("quiet community"), "");
    check("[1] photos from the second half survived", (p.photos as unknown[]).length === 1, "");
    check("[1] both source chunks are recorded", JSON.stringify(p.sourceOrdinals) === "[0,1]", JSON.stringify(p.sourceOrdinals));
    const res = await save(r.runId, [p.id as string]);
    check("[1] the merged record SAVES", res.saved === 1, JSON.stringify(res).slice(0, 160));
    await closeRun(r.runId);
  }

  // ---- 2/3. pricing: blended blocked, supported saves ----------------------
  {
    const text = "Beta Gardens — Napa\n Shared Studio\n - $5,595-$6,250/month\n Additional PDF entry / possible updated pricing:\n Shared Studio\n - $5,200/month";
    const r = await stagedRun([{ text, items: [
      { title: "Beta Gardens — Napa", details: [{ label: "Shared Studio", value: "$5,200-$6,250/month" }], links: [], photos: [], contacts: [] },
      { title: "Gamma House", details: [{ label: "Shared Studio", value: "$5,595-$6,250/month" }], links: [], photos: [], contacts: [] },
    ] }]);
    check("[2] both proposals materialised", r.proposals.length === 2, `${r.proposals.length}`);
    const blended = r.proposals.find((p) => String(p.title).startsWith("Beta"))!;
    const good = r.proposals.find((p) => String(p.title).startsWith("Gamma"))!;
    check("[2] the blended range is WARNED at review", ((blended.priceWarnings as string[]) ?? []).length > 0,
      JSON.stringify(blended.priceWarnings));
    const rb = await save(r.runId, [blended.id as string]);
    check("[2] the blended range is BLOCKED at save", (rb.results ?? [])[0]?.outcome === "unsupported_price",
      JSON.stringify(rb.results).slice(0, 190));
    check("[2] the refusal names the value", /\$5,200-\$6,250/.test(JSON.stringify(rb.results)), "");
    const rg = await save(r.runId, [good.id as string]);
    check("[3] SUPPORTED pricing saves normally", rg.saved === 1, JSON.stringify(rg.results).slice(0, 160));
    await closeRun(r.runId);
  }

  // ---- 4/5. notes: unmarked blocked, genuinely private passes --------------
  {
    const text = "Delta Place — Sonoma\n Community Phone: (707) 555-0100\n Private note: the director retires in March.\n Assisted Living rooms currently have a waitlist.";
    const r = await stagedRun([{ text, items: [
      { title: "Delta Place — Sonoma", notes: "the director retires in March.",
        contacts: [{ role: "Community", phone: "(707) 555-0100" }], details: [], links: [], photos: [] },
      { title: "Epsilon Court", notes: "Assisted Living rooms currently have a waitlist.",
        details: [], links: [], photos: [], contacts: [] },
    ] }]);
    const priv = r.proposals.find((p) => String(p.title).startsWith("Delta"))!;
    const ord = r.proposals.find((p) => String(p.title).startsWith("Epsilon"))!;
    check("[5] a genuinely private note is NOT warned", ((priv.noteWarnings as string[]) ?? []).length === 0,
      JSON.stringify(priv.noteWarnings));
    check("[4] an unmarked note IS warned", ((ord.noteWarnings as string[]) ?? []).length > 0,
      JSON.stringify(ord.noteWarnings));
    const rb = await save(r.runId, [ord.id as string]);
    check("[4] the unmarked note is BLOCKED at save", (rb.results ?? [])[0]?.outcome === "private_note_unverified",
      JSON.stringify(rb.results).slice(0, 190));
    const rp = await save(r.runId, [priv.id as string]);
    check("[5] the genuinely private note SAVES", rp.saved === 1, JSON.stringify(rp.results).slice(0, 160));
    await closeRun(r.runId);
  }

  // ---- 6/7. contacts, websites, emails ------------------------------------
  {
    const text = "Zeta Villa — Marin\n Community Phone: (415) 927-4200\n Contact Name: Leslye Peterson\n Contact Title: Marketing Director\n Cell Phone: (781) 635-6032\n Email Address: l.p@example.com\n Existing Website: https://www.zetavilla.example.com";
    const r = await stagedRun([{ text, items: [
      { title: "Zeta Villa — Marin", details: [], photos: [],
        links: [{ url: "https://zetavilla.example.com/", label: "Website" }],
        contacts: [{ role: "Community", phone: "(415) 927-4200" },
                   { name: "Leslye Peterson", role: "Marketing Director", phone: "(781) 635-6032", email: "l.p@example.com" }] },
    ] }]);
    const p = r.proposals[0];
    check("[6] BOTH phones survive", (p.contacts as unknown[]).length === 2, JSON.stringify(p.contacts));
    check("[6] no completeness warning", ((p.completenessWarnings as string[]) ?? []).length === 0,
      JSON.stringify(p.completenessWarnings));
    check("[7] the canonicalised website is not a false loss",
      !JSON.stringify(p.completenessWarnings ?? []).includes("website"), JSON.stringify(p.completenessWarnings));
    const res = await save(r.runId, [p.id as string]);
    check("[6] it saves", res.saved === 1, JSON.stringify(res.results).slice(0, 150));
    const { data: li } = await svc.from("library_items").select("contacts, links").eq("user_id", UID).order("created_at", { ascending: false }).limit(1);
    const row = (li ?? [])[0] as { contacts?: unknown[]; links?: unknown[] };
    check("[6] BOTH contacts persisted into the Library row", (row?.contacts ?? []).length === 2, JSON.stringify(row?.contacts));
    check("[7] the website persisted", (row?.links ?? []).length === 1, JSON.stringify(row?.links));
    await closeRun(r.runId);
  }
} finally {
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} library rows for the disposable user — ${count ? "NOT CLEAN" : "clean"}`);
}
process.exit(summary("PRODUCTION SMOKE — Library importer gates") > 0 ? 1 : 0);
