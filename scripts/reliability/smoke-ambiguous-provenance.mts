// PRODUCTION SMOKE for the parenthetical fallback and provenance containment.
//
// Disposable user, tiny crafted sources, real production routes. Chunk offsets
// TILE the source exactly here, as they do in a real run — the containment
// derives its ranges from them, so a fixture that faked them would prove
// nothing.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-amb-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });
const P = (n: string) => `https://res.cloudinary.com/dkmsj5vdx/image/upload/v1782353507/${n}.jpg`;

async function stagedRun(chunks: { text: string; items: unknown[] }[]) {
  const src = chunks.map((c) => c.text).join("\n\n");
  let at = 0;
  const spans = chunks.map((c) => { const s = src.indexOf(c.text, at); at = s + c.text.length; return { s, e: at }; });
  // chunk ranges must TILE: each ends where the next begins, the last at the end
  const tiled = spans.map((sp, i) => ({ start: i === 0 ? 0 : spans[i].s, end: i + 1 < spans.length ? spans[i + 1].s : src.length }));
  const { data, error } = await svc.rpc("create_library_import_run", {
    p_owner: UID, p_source_text: src, p_source_hash: segmentHash(src), p_source_len: src.length,
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks.map((c, i) => ({
      ordinal: i, source_start: tiled[i].start, source_end: tiled[i].end,
      segment_text: c.text, segment_hash: segmentHash(c.text),
    })),
  });
  if (error) throw new Error(errText(error));
  const runId = ((data as { run_id?: string })?.run_id ?? (data as unknown as string)) as string;
  for (let i = 0; i < chunks.length; i++) {
    await svc.from("ingestion_chunks").update({ status: "completed", attempt_count: 1, result: { items: chunks[i].items } })
      .eq("run_id", runId).eq("ordinal", i);
  }
  const pr = await api(`/api/library/import/${runId}/proposals`, { method: "POST" });
  const body = await pr.json();
  return { runId, status: pr.status, proposals: (body?.proposals ?? []) as Record<string, unknown>[] };
}
const save = async (runId: string, ids: string[]) =>
  (await api(`/api/library/import/${runId}/save`, { method: "POST", body: JSON.stringify({ proposalIds: ids }) })).json();
const closeRun = async (runId: string) => {
  await svc.rpc("library_close_import_run", { p_owner: UID, p_run_id: runId, p_status: "discarded" }).then(() => {}, () => {});
  await svc.from("ingestion_runs").update({ status: "finalized" }).eq("id", runId).in("status", ["active", "needs_review"]);
};
const arr = (p: Record<string, unknown>, k: string) => ((p[k] as string[]) ?? []);
const photosOf = (p: Record<string, unknown>) => ((p.photos as string[]) ?? []).map(String);

try {
  // ---- 1. THE FALLBACK RESOLVES A UNIQUE LEGITIMATE HEADER ----------------
  {
    const text = `Napa Valley Senior Care (formerly called Nazareth Classic Care of Napa) — Napa\nType: AL\n Community Phone: (707) 111-0000\nImage 1: ${P("nvsc1")}`;
    // The model abbreviates the parenthetical — the exact real-world variance.
    const r = await stagedRun([{ text, items: [
      { title: "Napa Valley Senior Care (formerly Nazareth Classic Care)", details: [], links: [], contacts: [], photos: [P("nvsc1")] },
    ] }]);
    const p = r.proposals[0];
    check("[1] the abbreviated title RESOLVES", arr(p, "provenanceWarnings").length === 0, JSON.stringify(arr(p, "provenanceWarnings")));
    check("[1] and it keeps its own photo", JSON.stringify(photosOf(p)) === JSON.stringify([P("nvsc1")]), JSON.stringify(photosOf(p)));
    const res = await save(r.runId, [p.id as string]);
    check("[1] it SAVES", res.saved === 1, JSON.stringify(res.results).slice(0, 200));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 2. A NON-UNIQUE STRIPPED TITLE IS A GUESS, SO IT STAYS UNRESOLVED --
  {
    const text = `Twin Oaks (formerly called Alpha of Napa) — Napa\nType: AL\nImage 1: ${P("twin1")}\n\nTwin Oaks (formerly called Beta of Sonoma) — Sonoma\nType: AL\nImage 1: ${P("twin2")}`;
    const r = await stagedRun([{ text, items: [
      { title: "Twin Oaks (formerly Gamma)", details: [], links: [], contacts: [], photos: [P("twin1")] },
    ] }]);
    const p = r.proposals[0];
    check("[2] two candidate headers => UNRESOLVED, not guessed", arr(p, "provenanceWarnings").length > 0,
      JSON.stringify(arr(p, "provenanceWarnings")));
    check("[2] the warning says the community was not found",
      /could not find this community/i.test(arr(p, "provenanceWarnings")[0] ?? ""), arr(p, "provenanceWarnings")[0]);
    const res = await save(r.runId, [p.id as string]);
    check("[2] it is BLOCKED at save", (res.results ?? [])[0]?.outcome === "ambiguous_provenance",
      JSON.stringify(res.results).slice(0, 220));
    check("[2] nothing was written", res.saved === 0, String(res.saved));
    await closeRun(r.runId);
  }

  // ---- 3/4/5/6. AN UNRESOLVED SIBLING CANNOT MAKE ITS NEIGHBOUR AUTHORITATIVE
  // A is findable and comes first; B follows in the NEXT chunk with a title no
  // normalisation can reach. Without containment A's span runs through B and A
  // collects B's photos, B's private directive and B's description.
  {
    const bDesc = "Beta Court offers memory care in a purpose-built single-storey building close to the coast.";
    const aText = `Alpha Gardens — Napa\nType: AL\n Community Phone: (707) 111-0000\nImage 1: ${P("alpha1")}`;
    const bText = `Beta Court — Napa\nType: AL\n Community Phone: (707) 222-0000\n Private note: the director retires in March.\n${bDesc}\nImage 1: ${P("beta1")}`;
    const r = await stagedRun([
      { text: aText, items: [{ title: "Alpha Gardens", description: bDesc, notes: "the director retires in March.",
                               details: [], links: [], contacts: [], photos: [P("alpha1"), P("beta1")] }] },
      { text: bText, items: [{ title: "Community Nine Hundred", details: [], links: [], contacts: [], photos: [P("beta1")] }] },
    ]);
    const a = r.proposals.find((p) => String(p.title) === "Alpha Gardens")!;
    const b = r.proposals.find((p) => String(p.title) === "Community Nine Hundred")!;

    check("[3] the unresolved record is flagged", arr(b, "provenanceWarnings").length > 0, JSON.stringify(arr(b, "provenanceWarnings")));
    check("[3] the NEIGHBOUR is flagged too, not silently trusted", arr(a, "provenanceWarnings").length > 0,
      JSON.stringify(arr(a, "provenanceWarnings")));
    check("[3] the neighbour's warning says the end of the record is unknown",
      /cannot tell where this record ends/i.test(arr(a, "provenanceWarnings")[0] ?? ""), arr(a, "provenanceWarnings")[0]);

    check("[4] the ambiguous photo is WITHHELD from the neighbour", !photosOf(a).includes(P("beta1")),
      JSON.stringify(photosOf(a)));
    check("[4] the neighbour keeps its own", photosOf(a).includes(P("alpha1")), JSON.stringify(photosOf(a)));
    check("[4] and the withheld photo is NAMED, not silently dropped",
      arr(a, "withheldPhotos").includes(P("beta1")), JSON.stringify(arr(a, "withheldPhotos")));

    check("[5] ambiguous text cannot AUTHORISE the neighbour's private note", arr(a, "noteWarnings").length > 0,
      JSON.stringify(arr(a, "noteWarnings")));

    const ra = await save(r.runId, [a.id as string]);
    check("[6] the neighbour is BLOCKED — ambiguous text establishes no description",
      (ra.results ?? [])[0]?.outcome === "ambiguous_provenance", JSON.stringify(ra.results).slice(0, 220));
    const rb = await save(r.runId, [b.id as string]);
    check("[3] the unresolved record is BLOCKED", (rb.results ?? [])[0]?.outcome === "ambiguous_provenance",
      JSON.stringify(rb.results).slice(0, 220));
    check("[3] nothing was written for either", ra.saved === 0 && rb.saved === 0, `${ra.saved}/${rb.saved}`);
    await closeRun(r.runId);
  }

  // ---- 7. THE CROSS-REFERENCE CASES STAY CLEAN ----------------------------
  // A names its sibling in prose. A name is never a header and never evidence.
  {
    const aDesc = "Alpha House is a locally owned community in San Rafael. Alpha House and Beta Manor share the same owners.";
    const text = `Alpha House — San Rafael\nType: AL\n Community Phone: (415) 111-2222\n${aDesc}\nImage 1: ${P("ah1")}\n\nBeta Manor — San Rafael\nType: AL\n Community Phone: (415) 333-4444\nImage 1: ${P("bm1")}`;
    const r = await stagedRun([{ text, items: [
      { title: "Alpha House — San Rafael", description: aDesc, details: [], links: [], contacts: [], photos: [P("ah1")] },
      { title: "Beta Manor — San Rafael", details: [], links: [], contacts: [], photos: [P("bm1")] },
    ] }]);
    const a = r.proposals.find((p) => String(p.title).startsWith("Alpha"))!;
    const b = r.proposals.find((p) => String(p.title).startsWith("Beta"))!;
    check("[7] naming a sibling raises no provenance warning", arr(a, "provenanceWarnings").length === 0, JSON.stringify(arr(a, "provenanceWarnings")));
    check("[7] nor an attribution warning", arr(a, "attributionWarnings").length === 0, JSON.stringify(arr(a, "attributionWarnings")));
    check("[7] the mentioning record keeps its own photo", JSON.stringify(photosOf(a)) === JSON.stringify([P("ah1")]), JSON.stringify(photosOf(a)));
    check("[7] the mentioned record does not inherit it", JSON.stringify(photosOf(b)) === JSON.stringify([P("bm1")]), JSON.stringify(photosOf(b)));
    const res = await save(r.runId, [a.id as string, b.id as string]);
    check("[7] both SAVE", res.saved === 2, JSON.stringify(res.results).slice(0, 220));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 8. ORDINARY RESOLVABLE RECORDS ARE UNAFFECTED ---------------------
  {
    const d = "Gamma Villa is a small assisted living home with a shaded garden courtyard and twelve private rooms.";
    const text = `Gamma Villa — Petaluma\nType: AL\n Community Phone: (707) 555-0142\n Studio - $4,200/month\n Private note: the owner is selling in spring.\n${d}\nImage 1: ${P("gv1")}\n\nImage 2: ${P("gv2")}`;
    const r = await stagedRun([{ text, items: [
      { title: "Gamma Villa — Petaluma", description: d, notes: "the owner is selling in spring.",
        details: [{ label: "Studio", value: "$4,200/month" }],
        contacts: [{ role: "Community", phone: "(707) 555-0142" }], links: [], photos: [P("gv1")] },
    ] }]);
    const p = r.proposals[0];
    for (const k of ["provenanceWarnings", "attributionWarnings", "noteWarnings", "priceWarnings", "completenessWarnings"])
      check(`[8] no ${k}`, arr(p, k).length === 0, JSON.stringify(arr(p, k)));
    check("[8] the missed photo was still attributed from source",
      JSON.stringify(photosOf(p)) === JSON.stringify([P("gv1"), P("gv2")]), JSON.stringify(photosOf(p)));
    const res = await save(r.runId, [p.id as string]);
    check("[8] it SAVES", res.saved === 1, JSON.stringify(res.results).slice(0, 200));
    const { data: li } = await svc.from("library_items").select("title,photos,details,contacts,notes").eq("user_id", UID);
    const row = ((li ?? [])[0] ?? {}) as Record<string, unknown>;
    check("[8] both photos persisted", ((row.photos as unknown[]) ?? []).length === 2, JSON.stringify(row.photos));
    check("[8] the private note persisted", String(row.notes ?? "").includes("selling in spring"), String(row.notes));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }
} finally {
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("ingestion_runs").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count: items } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: runs } = await svc.from("ingestion_runs").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: users } = await svc.from("users").select("id", { count: "exact", head: true }).eq("id", UID);
  console.log(`\ncleanup: items=${items ?? 0} runs=${runs ?? 0} users=${users ?? 0} — ${!items && !runs && !users ? "clean" : "NOT CLEAN"}`);
}
process.exit(summary("PRODUCTION SMOKE — parenthetical fallback + provenance containment") > 0 ? 1 : 0);
