// Migration 0017 acceptance — the Library substrate, end to end.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-library.mts
//
// Requires the dev server running and serving THIS branch. CONSUMES NO MODEL
// CREDITS: every packet is constructed directly, so each property is exact and
// repeatable. Everything downstream of that state — the RPCs, the routes, the
// constraints and the trigger — is exercised for real.
//
// Containment: one disposable user, removed in a finally block that verifies the
// removal by id rather than by a predicate that would return nothing anyway.
import { svc, check, summary, errText } from "./lib.mts";
import { segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
import { GATE_SOURCE, GATE_TITLES, PHOTO_A, PHOTO_B } from "../../src/lib/__fixtures__/ownership-gate-fixture.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const TAG = "flowguide-lib-" + process.pid;
console.log(`\nLibrary substrate proof — ${BASE}\n`);

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;
console.log(`disposable user ${UID}\n`);

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const packets: string[] = [];
const libraryIds: string[] = [];

/** A draft packet with one section and one fully-populated item. */
async function makePacket(label: string, withProvenance = false) {
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${label}`, title: `Library proof — ${label}`,
    raw_input: withProvenance ? GATE_SOURCE : "", status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const packetId = (p as { id: string }).id;
  packets.push(packetId);

  const { data: s } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Communities", sort_order: 0 }).select("id").single();
  return { packetId, sectionId: (s as { id: string }).id };
}

/** Ordered payload, deliberately NOT alphabetical, so ordering is provable. */
const DETAILS = [
  { label: "AL Studio", value: "$4,500" },
  { label: "AL 1BR", value: "$5,200" },
  { label: "AL 2BR", value: "$6,100" },
  { label: "Memory Care", value: "$7,000" },
  { label: "Second person fee", value: "$900" },
  { label: "Pet fee", value: "$500" },
];
const LINKS = [
  { url: "https://example.invalid/tour", label: "Schedule a tour" },
  { url: "https://example.invalid/floorplans", label: "Floorplans" },
];
const PHOTOS = [{ url: PHOTO_A }, { url: PHOTO_B }, { url: "https://cdn.example.invalid/c.jpg" }];
const CONTACTS = [
  { name: "Dana Reed", role: "Director", phone: "555-0100", email: "d@example.invalid", website: "" },
  { name: "Sam Ortiz", role: "Concierge", phone: "555-0111", email: "", website: "" },
];

/**
 * Edit a packet item, through the route that MATCHES the packet's composition
 * mode. These packets are legacy, so this is /api/items — the block route
 * passes requireMode:"blocks" and update_item_content raises on a legacy packet.
 *
 * ASSERTS ITS OWN SUCCESS. The first version returned the response and every
 * caller discarded it, so a 400 here was invisible and surfaced later as two
 * failures in the assertions that depended on it. A proof whose SETUP can fail
 * silently does not prove what it claims — it misattributes its own broken
 * arrangement to the thing under test.
 */
async function fillItem(label: string, itemId: string, over: Record<string, unknown> = {}) {
  const r = await api(`/api/items`, {
    method: "PATCH",
    body: JSON.stringify({
      id: itemId,
      title: "Brookdale Chanate", address: "3800 Chanate Rd",
      description: "Assisted living and memory care.", notes: "",
      details: DETAILS, links: LINKS, photos: PHOTOS, contacts: CONTACTS, ...over,
    }),
  });
  check(`setup: ${label}`, r.status === 200, `status ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  return r;
}

const readChildren = async (itemId: string) => {
  const [d, l, ph, c] = await Promise.all([
    svc.from("item_details").select("label, value").eq("item_id", itemId).order("sort_order"),
    svc.from("item_links").select("url, label").eq("item_id", itemId).order("sort_order"),
    svc.from("item_photos").select("url").eq("item_id", itemId).order("sort_order"),
    svc.from("item_contacts").select("name, role").eq("item_id", itemId).order("sort_order"),
  ]);
  return { details: d.data ?? [], links: l.data ?? [], photos: ph.data ?? [], contacts: c.data ?? [] };
};

try {
  // =======================================================================
  // Save → the snapshot
  // =======================================================================
  const base = await makePacket("base");
  const { data: baseItem } = await svc.from("items")
    .insert({ section_id: base.sectionId, title: "seed", sort_order: 0 }).select("id").single();
  const baseItemId = (baseItem as { id: string }).id;

  // Block-mode route is the canonical full-replace writer; this packet is
  // legacy, so use the legacy content route instead.
  const seeded = await api(`/api/items`, {
    method: "PATCH",
    body: JSON.stringify({
      id: baseItemId, title: "Brookdale Chanate", address: "3800 Chanate Rd",
      description: "Assisted living and memory care.", notes: "",
      details: DETAILS, links: LINKS, photos: PHOTOS, contacts: CONTACTS,
    }),
  });
  check("the source item is populated", seeded.status === 200, JSON.stringify(seeded.data).slice(0, 160));

  const saved = await api(`/api/library`, { method: "POST", body: JSON.stringify({ itemId: baseItemId }) });
  check("Save to Library succeeds", saved.status === 200, JSON.stringify(saved.data).slice(0, 200));
  const libId = saved.data?.item?.id as string;
  if (libId) libraryIds.push(libId);
  check("the new entry starts at revision 1", saved.data?.item?.revision === 1,
    `revision=${saved.data?.item?.revision}`);

  // Lineage must be written as BOTH columns, or the CHECK would have rejected it.
  const { data: lin } = await svc.from("items")
    .select("library_item_id, library_item_revision").eq("id", baseItemId).single();
  check("saving records BOTH lineage columns",
    (lin as Record<string, unknown>).library_item_id === libId &&
    Number((lin as Record<string, unknown>).library_item_revision) === 1,
    JSON.stringify(lin));

  // ---- 18. the CHECK actually rejects a half state -----------------------
  const { error: halfErr } = await svc.from("items")
    .update({ library_item_revision: null }).eq("id", baseItemId);
  check("18. a half-lineage write is REJECTED by the CHECK constraint",
    !!halfErr, halfErr ? `rejected: ${halfErr.code}` : "ACCEPTED — the constraint is not doing its job");

  // ---- 7. snapshot fidelity, through Save → Insert ------------------------
  const target = await makePacket("target");
  const inserted = await api(`/api/packets/${target.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [libId], sectionId: target.sectionId }),
  });
  check("insert from Library succeeds", inserted.status === 200, JSON.stringify(inserted.data).slice(0, 200));
  const insertedItemId = inserted.data?.itemIds?.[0] as string;

  const round = await readChildren(insertedItemId);
  check("7a. details survive Save → Insert with ORDER intact",
    JSON.stringify(round.details) === JSON.stringify(DETAILS), JSON.stringify(round.details).slice(0, 200));
  check("7b. links survive with order intact",
    JSON.stringify(round.links) === JSON.stringify(LINKS), JSON.stringify(round.links).slice(0, 160));
  check("7c. photos survive with order intact — it decides the hero photo",
    JSON.stringify(round.photos) === JSON.stringify(PHOTOS), JSON.stringify(round.photos).slice(0, 200));
  check("7d. contacts survive with order intact",
    JSON.stringify(round.contacts) === JSON.stringify(CONTACTS.map((c) => ({ name: c.name, role: c.role }))),
    JSON.stringify(round.contacts).slice(0, 160));

  // ---- 8. no ingestion provenance fabricated -----------------------------
  const { data: prov } = await svc.from("items")
    .select("origin_run_id, origin_chunk_ordinal, origin_emit_index, library_item_id, library_item_revision")
    .eq("id", insertedItemId).single();
  const pr = prov as Record<string, unknown>;
  check("8a. an inserted item carries NO 0014 provenance",
    pr.origin_run_id === null && pr.origin_chunk_ordinal === null && pr.origin_emit_index === null,
    JSON.stringify(pr));
  check("8b. but it does record its Library lineage",
    pr.library_item_id === libId && Number(pr.library_item_revision) === 1, JSON.stringify(pr));

  const own = await api(`/api/packets/${target.packetId}/ownership`);
  check("8c. ownership DECLINES for a Library-only packet rather than claiming it clean",
    own.status === 200 && own.data?.checked === false,
    `status=${own.status} checked=${own.data?.checked}`);

  // ---- 9. search finds a term that exists ONLY in a detail label ---------
  const found = await api(`/api/library?q=${encodeURIComponent("memory care")}`);
  check("9a. search finds an entry by a term only present in a DETAIL label",
    (found.data?.items ?? []).some((i: { id: string }) => i.id === libId),
    JSON.stringify((found.data?.items ?? []).map((i: { title: string }) => i.title)));
  const byContact = await api(`/api/library?q=${encodeURIComponent("Ortiz")}`);
  check("9b. and by a term only present in a CONTACT name",
    (byContact.data?.items ?? []).some((i: { id: string }) => i.id === libId),
    JSON.stringify((byContact.data?.items ?? []).length));
  const byLink = await api(`/api/library?q=${encodeURIComponent("Floorplans")}`);
  check("9c. and by a term only present in a LINK label",
    (byLink.data?.items ?? []).some((i: { id: string }) => i.id === libId),
    JSON.stringify((byLink.data?.items ?? []).length));

  // ---- 3. atomic save-back ------------------------------------------------
  // Improve the descendant, then push. Both writes must land together.
  await fillItem("improve the descendant before pushing", insertedItemId, {
    description: "Assisted living, memory care, and respite.",
    details: [...DETAILS, { label: "Respite", value: "$300/day" }],
  });

  // Prove the SETUP landed before asserting anything about the push. This is
  // what was missing: 3c and 5d were reporting a failed arrangement as a
  // product defect.
  const { data: improved } = await svc.from("items").select("description").eq("id", insertedItemId).single();
  check("setup: the descendant really holds the improved description",
    String((improved as Record<string, unknown>).description).includes("respite"),
    String((improved as Record<string, unknown>).description));
  const pushed = await api(`/api/library/${libId}/update-from-item`, {
    method: "POST", body: JSON.stringify({ itemId: insertedItemId, expectedRevision: 1, action: "update" }),
  });
  check("3a. Update Library version succeeds", pushed.status === 200, JSON.stringify(pushed.data).slice(0, 200));
  check("3b. the Library revision advanced to 2", pushed.data?.revision === 2, `revision=${pushed.data?.revision}`);

  const { data: after } = await svc.from("library_items").select("description, details, revision").eq("id", libId).single();
  const { data: lin2 } = await svc.from("items").select("library_item_revision").eq("id", insertedItemId).single();
  check("3c. the Library snapshot really was replaced",
    String((after as Record<string, unknown>).description).includes("respite"),
    String((after as Record<string, unknown>).description));
  check("3d. AND the descendant's recorded revision was refreshed IN THE SAME WRITE",
    Number((lin2 as Record<string, unknown>).library_item_revision) === 2,
    `descendant revision=${(lin2 as Record<string, unknown>).library_item_revision} library=${(after as Record<string, unknown>).revision}`);

  // ---- 5. optimistic concurrency -----------------------------------------
  // Replay the SAME stale revision 1. It must be refused, and must not clobber
  // the revision-2 content.
  const stale = await api(`/api/library/${libId}/update-from-item`, {
    method: "POST", body: JSON.stringify({ itemId: insertedItemId, expectedRevision: 1, action: "update" }),
  });
  check("5a. a stale reviewed revision is REFUSED with a conflict",
    stale.status === 409 && stale.data?.error === "revision_conflict",
    `status=${stale.status} error=${stale.data?.error}`);
  check("5b. the conflict reports the CURRENT revision, not the stale one",
    stale.data?.currentRevision === 2, `currentRevision=${stale.data?.currentRevision}`);
  check("5c. and carries a recomputed comparison to decide against",
    !!stale.data?.decision && stale.data?.diff !== undefined, JSON.stringify(Object.keys(stale.data ?? {})));

  const { data: unharmed } = await svc.from("library_items").select("revision, description").eq("id", libId).single();
  check("5d. the newer Library content was NOT overwritten",
    Number((unharmed as Record<string, unknown>).revision) === 2 &&
    String((unharmed as Record<string, unknown>).description).includes("respite"),
    JSON.stringify(unharmed));

  // Direct edit with a stale revision must be refused the same way.
  const staleDirect = await api(`/api/library/${libId}`, {
    method: "PATCH", body: JSON.stringify({ title: "Clobbered", expectedRevision: 1 }),
  });
  check("5e. a stale DIRECT edit is refused too",
    staleDirect.status === 409 && staleDirect.data?.error === "revision_conflict",
    `status=${staleDirect.status}`);

  // ---- 4. atomic save as new ---------------------------------------------
  // Prune the descendant, then save as new rather than replacing the base.
  await fillItem("prune the descendant for one recipient", insertedItemId, {
    details: [{ label: "AL 2BR", value: "$6,100" }, { label: "Pet fee", value: "$500" }],
  });
  const asNew = await api(`/api/library/${libId}/update-from-item`, {
    method: "POST", body: JSON.stringify({ itemId: insertedItemId, action: "save_as_new" }),
  });
  check("4a. Save as new succeeds", asNew.status === 200, JSON.stringify(asNew.data).slice(0, 200));
  const newLibId = asNew.data?.libraryItemId as string;
  if (newLibId) libraryIds.push(newLibId);

  const { data: lin3 } = await svc.from("items")
    .select("library_item_id, library_item_revision").eq("id", insertedItemId).single();
  check("4b. ancestry was repointed to the NEW entry, both columns together",
    (lin3 as Record<string, unknown>).library_item_id === newLibId &&
    Number((lin3 as Record<string, unknown>).library_item_revision) === 1, JSON.stringify(lin3));

  const { data: origUntouched } = await svc.from("library_items")
    .select("revision, details").eq("id", libId).single();
  check("4c. the ORIGINAL entry is untouched — the pruning did not reach it",
    Number((origUntouched as Record<string, unknown>).revision) === 2 &&
    JSON.stringify((origUntouched as Record<string, unknown>).details).includes("Memory Care"),
    `revision=${(origUntouched as Record<string, unknown>).revision}`);

  // ---- 6. deletion coherence ---------------------------------------------
  const beforeDelete = await readChildren(insertedItemId);
  const del = await api(`/api/library/${newLibId}`, { method: "DELETE" });
  check("6a. deleting a Library ancestor succeeds", del.status === 200, JSON.stringify(del.data));

  const { data: lin4 } = await svc.from("items")
    .select("library_item_id, library_item_revision").eq("id", insertedItemId).single();
  check("6b. BOTH lineage columns are cleared, not just the id",
    (lin4 as Record<string, unknown>).library_item_id === null &&
    (lin4 as Record<string, unknown>).library_item_revision === null, JSON.stringify(lin4));

  const afterDelete = await readChildren(insertedItemId);
  check("6c. the packet's own content is completely unaffected",
    JSON.stringify(afterDelete) === JSON.stringify(beforeDelete), "content changed");

  const pub = await api(`/api/packets/${target.packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("6d. and the packet still publishes", pub.status === 200,
    `status=${pub.status} ${JSON.stringify(pub.data).slice(0, 160)}`);

  // ---- 8d. mixed origin, against the live database ------------------------
  const mixed = await makePacket("mixed", true);
  const runId = crypto.randomUUID();
  await svc.from("ingestion_runs").insert({
    id: runId, user_id: UID, packet_id: mixed.packetId, entry_point: "organize",
    source_hash: segmentHash(GATE_SOURCE), source_len: GATE_SOURCE.length,
    segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
    status: "finalized", total_chunks: 2, completed_chunks: 2,
  });
  const { records } = (await import("../../src/lib/segmentation.ts")).detectSourceRecords(GATE_SOURCE)!;
  await svc.from("ingestion_chunks").insert(records.map((r, ordinal) => ({
    run_id: runId, ordinal, source_start: r.start, source_end: r.end,
    segment_hash: segmentHash(GATE_SOURCE.slice(r.start, r.end)), status: "completed",
  })));
  const importedIds: string[] = [];
  for (const [i, title] of GATE_TITLES.entries()) {
    const { data: it } = await svc.from("items").insert({
      section_id: mixed.sectionId, title, sort_order: i,
      origin_run_id: runId, origin_chunk_ordinal: i, origin_emit_index: 0,
    }).select("id").single();
    importedIds.push((it as { id: string }).id);
  }
  // Correct placement, so the imported half is clean.
  await svc.from("item_photos").insert([
    { item_id: importedIds[0], url: PHOTO_A, sort_order: 0 },
    { item_id: importedIds[1], url: PHOTO_B, sort_order: 0 },
  ]);
  const ownBefore = await api(`/api/packets/${mixed.packetId}/ownership`);
  check("8d. an imported packet is CHECKED", ownBefore.data?.checked === true,
    `checked=${ownBefore.data?.checked}`);

  await api(`/api/packets/${mixed.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [libId], sectionId: mixed.sectionId }),
  });
  const ownAfter = await api(`/api/packets/${mixed.packetId}/ownership`);
  check("8e. adding a Library item does NOT switch ownership checking off",
    ownAfter.data?.checked === true, `checked=${ownAfter.data?.checked}`);
  check("8f. and produces no false findings against it",
    (ownAfter.data?.findings ?? []).length === (ownBefore.data?.findings ?? []).length,
    `before=${(ownBefore.data?.findings ?? []).length} after=${(ownAfter.data?.findings ?? []).length}`);

  summary("Library substrate proof");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of libraryIds) await svc.from("library_items").delete().eq("id", id);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);

  // BY ID, not by a predicate that would return nothing once the user is gone.
  const { data: lp } = packets.length ? await svc.from("packets").select("id").in("id", packets) : { data: [] };
  const { data: ll } = libraryIds.length ? await svc.from("library_items").select("id").in("id", libraryIds) : { data: [] };
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const stray = (lp ?? []).length + (ll ?? []).length + (lu ?? []).length;
  console.log(`\ncleanup: ${(lp ?? []).length} packets, ${(ll ?? []).length} library items, ` +
    `${(lu ?? []).length} users remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
