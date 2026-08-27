// PRODUCTION SMOKE for photo attribution, the description-attribution
// safeguard, the recordSpan header fix, and the two meanings of 402.
//
// Disposable user, tiny crafted sources, real production routes. Deliberately
// NOT a 65-community benchmark: what is under test is the GATES, and each has
// its own minimal fixture.
//
// The two 402 cases are staged through the STORED FAILURE MARK rather than by
// provoking the provider: fault injection is dead-code-eliminated from the
// production build, and a real credit exhaustion is not something to induce on
// a live account. Classification of the provider's own response is covered by
// capacity-402.test.mts; what production proves here is the consequence of
// each classification — that a capacity mark is retried against the model and
// a permanent mark is not.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-attr-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

async function newRun(chunks: { text: string; items?: unknown[] }[]) {
  const src = chunks.map((c) => c.text).join("\n\n");
  const { data, error } = await svc.rpc("create_library_import_run", {
    p_owner: UID, p_source_text: src, p_source_hash: segmentHash(src), p_source_len: src.length,
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks.map((c, i) => ({
      ordinal: i, source_start: src.indexOf(c.text), source_end: src.indexOf(c.text) + c.text.length,
      segment_text: c.text, segment_hash: segmentHash(c.text),
    })),
  });
  if (error) throw new Error(errText(error));
  return ((data as { run_id?: string })?.run_id ?? (data as unknown as string)) as string;
}

/** Stage crafted chunk results — no model call, so the GATES are what is
 *  exercised rather than the model's mood. */
async function stagedRun(chunks: { text: string; items: unknown[] }[]) {
  const runId = await newRun(chunks);
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
  await svc.rpc("library_close_import_run", { p_owner: UID, p_run_id: runId, p_status: "finalized" }).then(() => {}, () => {});
  await svc.from("ingestion_runs").update({ status: "finalized" }).eq("id", runId).in("status", ["active", "needs_review"]);
};
const photosOf = (p: Record<string, unknown>) => ((p.photos as string[]) ?? []).map((x) => String(x));
const P = (n: string) => `https://res.cloudinary.com/dkmsj5vdx/image/upload/v1782353507/${n}.jpg`;

try {
  // ---- 1. PHOTO OWNERSHIP: a swap is corrected back to the source block -----
  {
    const text = `Alpha Manor — Novato\n Community Phone: (415) 111-2222\nImage 1: ${P("alphaOne")}\n\nBeta Gardens — Novato\n Community Phone: (415) 222-3333\nImage 1: ${P("betaOne")}`;
    // The model hands back each community holding the OTHER's photo.
    const r = await stagedRun([{ text, items: [
      { title: "Alpha Manor — Novato", details: [], links: [], contacts: [], photos: [P("betaOne")] },
      { title: "Beta Gardens — Novato", details: [], links: [], contacts: [], photos: [P("alphaOne")] },
    ] }]);
    const a = r.proposals.find((p) => String(p.title).startsWith("Alpha"))!;
    const b = r.proposals.find((p) => String(p.title).startsWith("Beta"))!;
    check("[1] the swapped photo is returned to its own source block (Alpha)",
      JSON.stringify(photosOf(a)) === JSON.stringify([P("alphaOne")]), JSON.stringify(photosOf(a)));
    check("[1] the swapped photo is returned to its own source block (Beta)",
      JSON.stringify(photosOf(b)) === JSON.stringify([P("betaOne")]), JSON.stringify(photosOf(b)));
    const res = await save(r.runId, [a.id as string, b.id as string]);
    check("[1] both save", res.saved === 2, JSON.stringify(res.results).slice(0, 200));
    const { data: li } = await svc.from("library_items").select("title, photos").eq("user_id", UID);
    const rows = (li ?? []) as { title: string; photos: string[] }[];
    const ra = rows.find((x) => x.title.startsWith("Alpha"))!, rb = rows.find((x) => x.title.startsWith("Beta"))!;
    check("[1] SAVE RETAINED Alpha's photo", JSON.stringify(ra?.photos) === JSON.stringify([P("alphaOne")]), JSON.stringify(ra?.photos));
    check("[1] SAVE RETAINED Beta's photo", JSON.stringify(rb?.photos) === JSON.stringify([P("betaOne")]), JSON.stringify(rb?.photos));
    check("[1] no photo was invented or dropped", rows.flatMap((x) => x.photos ?? []).length === 2, "");
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 2. A SHARED PHOTO MAY LEGITIMATELY APPEAR ON TWO RECORDS ------------
  // The real corpus does this: one image is listed under both Cogir of Rohnert
  // Park and Villa Capri, which is why 344 (community, photo) pairs resolve to
  // 343 distinct URLs. Deduplicating by URL would silently rob one record.
  {
    const shared = P("sharedCampus");
    const text = `Cogir Rohnert — Rohnert Park\n Community Phone: (707) 111-0000\nImage 1: ${shared}\n\nVilla Capri — Rohnert Park\n Community Phone: (707) 222-0000\nImage 1: ${shared}`;
    const r = await stagedRun([{ text, items: [
      { title: "Cogir Rohnert — Rohnert Park", details: [], links: [], contacts: [], photos: [shared] },
      { title: "Villa Capri — Rohnert Park", details: [], links: [], contacts: [], photos: [shared] },
    ] }]);
    const c = r.proposals.find((p) => String(p.title).startsWith("Cogir"))!;
    const v = r.proposals.find((p) => String(p.title).startsWith("Villa"))!;
    check("[2] the shared photo stays on BOTH records", photosOf(c).includes(shared) && photosOf(v).includes(shared),
      `${JSON.stringify(photosOf(c))} / ${JSON.stringify(photosOf(v))}`);
    const res = await save(r.runId, [c.id as string, v.id as string]);
    check("[2] both save", res.saved === 2, JSON.stringify(res.results).slice(0, 200));
    const { data: li } = await svc.from("library_items").select("title, photos").eq("user_id", UID);
    const rows = (li ?? []) as { title: string; photos: string[] }[];
    check("[2] TWO records persist the same URL — 2 pairs, 1 distinct URL",
      rows.flatMap((x) => x.photos ?? []).length === 2 && new Set(rows.flatMap((x) => x.photos ?? [])).size === 1,
      JSON.stringify(rows));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 3. recordSpan: A NAME IN PROSE IS NOT A HEADER ----------------------
  // Alpha's own text names Beta before Beta's header appears. Locating a record
  // by the first occurrence of its bare name put Beta's span start inside
  // Alpha's block — truncating Alpha and handing Alpha's photo to Beta.
  {
    const text = `Alpha House — San Rafael\n Community Phone: (415) 111-2222\nAlpha House and Beta Manor share the same owners.\nImage 1: ${P("alphaOwn")}\n\nBeta Manor — San Rafael\n Community Phone: (415) 333-4444\nImage 1: ${P("betaOwn")}`;
    const r = await stagedRun([{ text, items: [
      { title: "Alpha House — San Rafael", description: "Alpha House and Beta Manor share the same owners.",
        details: [], links: [], contacts: [], photos: [P("alphaOwn")] },
      { title: "Beta Manor — San Rafael", details: [], links: [], contacts: [], photos: [P("betaOwn")] },
    ] }]);
    const a = r.proposals.find((p) => String(p.title).startsWith("Alpha"))!;
    const b = r.proposals.find((p) => String(p.title).startsWith("Beta"))!;
    check("[3] the mentioning record KEEPS its own photo", JSON.stringify(photosOf(a)) === JSON.stringify([P("alphaOwn")]), JSON.stringify(photosOf(a)));
    check("[3] the mentioned record does NOT inherit it", JSON.stringify(photosOf(b)) === JSON.stringify([P("betaOwn")]), JSON.stringify(photosOf(b)));
    check("[3] naming a sibling raises NO attribution warning", ((a.attributionWarnings as string[]) ?? []).length === 0,
      JSON.stringify(a.attributionWarnings));
    const res = await save(r.runId, [a.id as string]);
    check("[3] the cross-referencing record SAVES", res.saved === 1, JSON.stringify(res.results).slice(0, 200));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 4/5. THE REAL CASE: St Michael's source text, emitted on Greenwood --
  // Verbatim from the professional's own source, curly apostrophe included, so
  // the normalised title fallback is exercised too. The two communities share
  // owners, so a name proves nothing — only the source SPAN does.
  {
    const desc = "Greenwood Assisted Living is a locally owned and operated assisted living and memory care community in San Rafael that provides personalized support in a warm, family-centered environment. Guided by a culture that places residents’ needs first, the community offers individualized care plans tailored to each resident and family, along with assistance with daily living, medication management, meal preparation, and engaging social activities.";
    const text = `Greenwood Assisted Living — San Rafael\nType: AL, MC\n Community Phone: (770) 422-7778\n Assisted Living Rooms from $7,000-$9,500/month\n\nSt Michael’s Extended Care — San Rafael\nType: AL\n Community Phone: (415) 453-4600\n${desc}`;
    const r = await stagedRun([{ text, items: [
      { title: "Greenwood Assisted Living — San Rafael", description: desc,
        details: [{ label: "Assisted Living Rooms", value: "$7,000-$9,500/month" }], links: [], contacts: [], photos: [] },
      { title: "St Michael’s Extended Care — San Rafael", description: desc,
        details: [], links: [], contacts: [], photos: [] },
    ] }]);
    const g = r.proposals.find((p) => String(p.title).startsWith("Greenwood"))!;
    const m = r.proposals.find((p) => String(p.title).startsWith("St Michael"))!;

    check("[4] the moved description is WARNED at review", ((g.attributionWarnings as string[]) ?? []).length > 0,
      JSON.stringify(g.attributionWarnings));
    check("[4] the warning names where the text actually sits",
      /St Michael/.test(JSON.stringify(g.attributionWarnings ?? [])), JSON.stringify(g.attributionWarnings));
    const rb = await save(r.runId, [g.id as string]);
    check("[4] the moved description is BLOCKED at save", (rb.results ?? [])[0]?.outcome === "attribution_conflict",
      JSON.stringify(rb.results).slice(0, 220));
    check("[4] nothing was written for the blocked record", rb.saved === 0, JSON.stringify(rb.saved));

    check("[5] the SOURCE record is not warned", ((m.attributionWarnings as string[]) ?? []).length === 0,
      JSON.stringify(m.attributionWarnings));
    const rp = await save(r.runId, [m.id as string]);
    check("[5] the SOURCE record saves normally", rp.saved === 1, JSON.stringify(rp.results).slice(0, 200));
    const { data: li } = await svc.from("library_items").select("title, description").eq("user_id", UID);
    const rows = (li ?? []) as { title: string; description: string }[];
    check("[5] exactly ONE record persisted, and it is the source record",
      rows.length === 1 && rows[0].title.startsWith("St Michael"), JSON.stringify(rows.map((x) => x.title)));
    check("[5] its description survived intact", (rows[0]?.description ?? "").includes("family-centered environment"), "");
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 6. AN ORDINARY SUPPORTED DESCRIPTION SAVES -------------------------
  {
    const d = "Gamma Villa is a small assisted living home with a shaded garden courtyard and twelve private rooms.";
    const text = `Gamma Villa — Petaluma\n Community Phone: (707) 555-0142\n${d}`;
    const r = await stagedRun([{ text, items: [
      { title: "Gamma Villa — Petaluma", description: d, details: [], links: [], contacts: [], photos: [] },
    ] }]);
    const p = r.proposals[0];
    check("[6] no attribution warning", ((p.attributionWarnings as string[]) ?? []).length === 0, JSON.stringify(p.attributionWarnings));
    const res = await save(r.runId, [p.id as string]);
    check("[6] it saves", res.saved === 1, JSON.stringify(res.results).slice(0, 200));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 7/8. NOTES PROVENANCE still holds ----------------------------------
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
    check("[7] an unmarked note IS warned", ((ord.noteWarnings as string[]) ?? []).length > 0, JSON.stringify(ord.noteWarnings));
    const rb = await save(r.runId, [ord.id as string]);
    check("[7] the unmarked note is BLOCKED at save", (rb.results ?? [])[0]?.outcome === "private_note_unverified",
      JSON.stringify(rb.results).slice(0, 200));
    check("[8] a genuinely private note is NOT warned", ((priv.noteWarnings as string[]) ?? []).length === 0, JSON.stringify(priv.noteWarnings));
    const rp = await save(r.runId, [priv.id as string]);
    check("[8] the genuinely private note SAVES", rp.saved === 1, JSON.stringify(rp.results).slice(0, 200));
    await svc.from("library_items").delete().eq("user_id", UID);
    await closeRun(r.runId);
  }

  // ---- 9. A TRANSIENT CAPACITY 402 IS RECOVERABLE --------------------------
  // Staged as the stored mark from a previous attempt. The chunk must be
  // retried against the REAL model — not replayed as permanent, and never
  // subdivided, which is how a provider blip previously shredded an import.
  {
    const text = "Zeta Villa — Marin\n Community Phone: (415) 927-4200\n Studio - $4,200/month";
    const runId = await newRun([{ text }]);
    await svc.from("ingestion_chunks").update({
      status: "failed", attempt_count: 1,   // claim makes this attempt 2 — past AUTO_SPLIT_AT_ATTEMPT
      error: "[capacity] The AI service is temporarily at capacity for this account.",
    }).eq("run_id", runId).eq("ordinal", 0);

    const res = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
    const body = await res.json();
    check("[9] a capacity failure is RETRIED, not refused", res.status === 200, `${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    check("[9] it was NOT subdivided", body?.status !== "split", JSON.stringify(body).slice(0, 160));
    const { data: ch } = await svc.from("ingestion_chunks").select("status, error").eq("run_id", runId).eq("ordinal", 0).single();
    const row = ch as { status: string; error: string };
    check("[9] the chunk completed against the real model", row?.status === "completed", `${row?.status} / ${row?.error}`);
    check("[9] the chunk was not left poisoned", !String(row?.error ?? "").startsWith("[permanent]"), String(row?.error));
    await closeRun(runId);
  }

  // ---- 10. CAPACITY EXHAUSTION STAYS RETRYABLE ----------------------------
  {
    const text = "Eta Court — Marin\n Community Phone: (415) 927-4300\n Studio - $4,300/month";
    const runId = await newRun([{ text }]);
    await svc.from("ingestion_chunks").update({
      status: "failed", attempt_count: 6,   // claim makes this attempt 7 — past MAX_CAPACITY_ATTEMPTS
      error: "[capacity] The AI service is temporarily at capacity for this account.",
    }).eq("run_id", runId).eq("ordinal", 0);
    const res = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
    const body = await res.json();
    check("[10] exhausted capacity answers 429, not 402", res.status === 429, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    check("[10] it is NOT marked permanent", body?.permanent === false, JSON.stringify(body).slice(0, 160));
    check("[10] the message tells the professional to resume", /resume/i.test(String(body?.message ?? "")), String(body?.message));
    check("[10] and promises the text was not lost", /not lost/i.test(String(body?.message ?? "")), String(body?.message));
    await closeRun(runId);
  }

  // ---- 11. A GENUINE / UNKNOWN CREDIT 402 STAYS PERMANENT -----------------
  {
    const text = "Theta Manor — Marin\n Community Phone: (415) 927-4400\n Studio - $4,400/month";
    const runId = await newRun([{ text }]);
    const msg = "This account is out of AI credits. Add credit and resume this import.";
    await svc.from("ingestion_chunks").update({
      status: "failed", attempt_count: 1, error: `[permanent] ${msg}`,
    }).eq("run_id", runId).eq("ordinal", 0);
    const res = await api(`/api/ingest/${runId}/chunks/0`, { method: "POST" });
    const body = await res.json();
    check("[11] a credit 402 stays 402", res.status === 402, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    check("[11] it is reported permanent", body?.permanent === true, JSON.stringify(body).slice(0, 160));
    check("[11] the message reaches the professional intact", String(body?.message ?? "") === msg, String(body?.message));
    check("[11] the internal mark is not leaked into the message",
      !String(body?.message ?? "").includes("[permanent]"), String(body?.message));
    await closeRun(runId);
  }
} finally {
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("ingestion_runs").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count: items } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: runs } = await svc.from("ingestion_runs").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: users } = await svc.from("users").select("id", { count: "exact", head: true }).eq("id", UID);
  const clean = !items && !runs && !users;
  console.log(`\ncleanup: items=${items ?? 0} runs=${runs ?? 0} users=${users ?? 0} — ${clean ? "clean" : "NOT CLEAN"}`);
}
process.exit(summary("PRODUCTION SMOKE — photo attribution, description attribution, 402 duality") > 0 ? 1 : 0);
