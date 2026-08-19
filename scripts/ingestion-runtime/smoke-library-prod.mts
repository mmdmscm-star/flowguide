// Post-deploy smoke for Library v1, against PRODUCTION, on disposable data only.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://flowguide-ruddy.vercel.app \
//     npx tsx scripts/ingestion-runtime/smoke-library-prod.mts
//
// NO LIVE FLOWGUIDE IS READ OR WRITTEN. Every packet and Library entry here is
// created by this script under a disposable user and removed in a finally block
// that verifies the removal by id.
//
// Bounded to what this release actually ships: the Library loop in the working
// editor, and the refusal in block mode. It does not re-prove 0016/0017
// internals — those have their own proofs.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE || BASE.includes("localhost")) {
  console.error("FLOWGUIDE_BASE_URL must be the production origin");
  process.exit(2);
}
const TAG = "flowguide-libsmoke-" + process.pid;
console.log(`\nLibrary v1 production smoke — ${BASE}\n`);

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;

async function api(path: string, init: RequestInit = {}, auth = true) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Cookie: COOKIE } : {}), ...(init.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const packets: string[] = [];
const libIds: string[] = [];

async function makePacket(label: string, mode: "legacy" | "blocks") {
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${label}`, title: `Smoke — ${label}`,
    status: "draft", composition_mode: "legacy", raw_input: "",
  }).select("id").single();
  const packetId = (p as { id: string }).id;
  packets.push(packetId);
  const { data: s } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Communities", sort_order: 0 }).select("id").single();
  const sectionId = (s as { id: string }).id;
  const { data: it } = await svc.from("items")
    .insert({ section_id: sectionId, title: "Brookdale Chanate", address: "3800 Chanate Rd",
              description: "Assisted living and memory care.", sort_order: 0 })
    .select("id").single();
  const itemId = (it as { id: string }).id;
  await svc.from("item_details").insert([
    { item_id: itemId, label: "AL Studio", value: "$4,500/mo", sort_order: 0 },
    { item_id: itemId, label: "Memory Care", value: "$7,000/mo", sort_order: 1 },
  ]);
  if (mode === "blocks") {
    const { error } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: packetId });
    if (error) throw new Error(`convert: ${error.message}`);
  }
  return { packetId, sectionId, itemId };
}

try {
  // ---- the route is live and owner-scoped -------------------------------
  const src = await makePacket("source", "legacy");
  const signedOut = await api(`/api/library`, {}, false);
  check("library route is live and rejects signed-out access",
    signedOut.status === 401, `status ${signedOut.status}`);

  const empty = await api(`/api/library`);
  check("a new professional's Library is empty, not erroring",
    empty.status === 200 && (empty.data.items ?? []).length === 0,
    `status ${empty.status} items ${(empty.data.items ?? []).length}`);

  // ---- SAVE --------------------------------------------------------------
  const saved = await api(`/api/library`, {
    method: "POST", body: JSON.stringify({ itemId: src.itemId }),
  });
  check("Save to Library succeeds", saved.status === 200, JSON.stringify(saved.data).slice(0, 160));
  const LIB = saved.data?.item?.id as string;
  if (LIB) libIds.push(LIB);
  check("the entry starts at revision 1", saved.data?.item?.revision === 1);

  // ---- FIND --------------------------------------------------------------
  const found = await api(`/api/library?q=${encodeURIComponent("memory care")}`);
  check("search finds it by a term only present in a DETAIL label",
    (found.data?.items ?? []).some((i: { id: string }) => i.id === LIB),
    JSON.stringify((found.data?.items ?? []).map((i: { title: string }) => i.title)));

  // ---- duplicate warning --------------------------------------------------
  const dupe = await api(`/api/library`, {
    method: "POST", body: JSON.stringify({ itemId: src.itemId }),
  });
  check("a duplicate save WARNS rather than silently merging",
    dupe.status === 409 && dupe.data?.error === "duplicate_candidate",
    `status ${dupe.status} error ${dupe.data?.error}`);

  // ---- INSERT ------------------------------------------------------------
  const target = await makePacket("target", "legacy");
  const ins = await api(`/api/packets/${target.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB], sectionId: target.sectionId }),
  });
  check("Add from Library succeeds", ins.status === 200, JSON.stringify(ins.data).slice(0, 160));
  const newItem = ins.data?.itemIds?.[0] as string;

  const { data: prov } = await svc.from("items")
    .select("library_item_id, library_item_revision, origin_run_id").eq("id", newItem).single();
  const pr = prov as Record<string, unknown>;
  check("lineage recorded, both columns",
    pr.library_item_id === LIB && Number(pr.library_item_revision) === 1, JSON.stringify(pr));
  check("no 0014 ingestion provenance fabricated", pr.origin_run_id === null);

  const { data: det } = await svc.from("item_details").select("label").eq("item_id", newItem).order("sort_order");
  check("payload travelled with order intact",
    JSON.stringify((det ?? []).map((d: { label: string }) => d.label)) === JSON.stringify(["AL Studio", "Memory Care"]),
    JSON.stringify(det));

  // ---- UPDATE SAVED VERSION, with the tailored-descendant safeguard ------
  await svc.from("item_details").delete().eq("item_id", newItem);
  await svc.from("item_details").insert({ item_id: newItem, label: "AL Studio", value: "$4,500/mo", sort_order: 0 });

  const cmp = await api(`/api/library/${LIB}/update-from-item?itemId=${newItem}`);
  check("the comparison reports the trimmed detail as a removal",
    cmp.status === 200 && cmp.data?.diff?.hasRemovals === true,
    JSON.stringify(cmp.data?.diff?.fields?.find((f: { field: string }) => f.field === "details")));
  check("and offers KEEP BOTH first, not replacement",
    cmp.data?.decision?.primary === "save_as_new", `primary=${cmp.data?.decision?.primary}`);

  const asNew = await api(`/api/library/${LIB}/update-from-item`, {
    method: "POST", body: JSON.stringify({ itemId: newItem, action: "save_as_new" }),
  });
  check("Keep both creates a second entry", asNew.status === 200, JSON.stringify(asNew.data).slice(0, 120));
  if (asNew.data?.libraryItemId) libIds.push(asNew.data.libraryItemId);

  const { data: orig } = await svc.from("library_items").select("revision, details").eq("id", LIB).single();
  check("and the ORIGINAL entry is untouched",
    Number((orig as Record<string, unknown>).revision) === 1 &&
    JSON.stringify((orig as Record<string, unknown>).details).includes("Memory Care"),
    `revision ${(orig as Record<string, unknown>).revision}`);

  // ---- optimistic concurrency --------------------------------------------
  const stale = await api(`/api/library/${LIB}`, {
    method: "PATCH", body: JSON.stringify({ title: "Clobbered", expectedRevision: 99 }),
  });
  check("a stale revision is refused, not applied",
    stale.status === 409 && stale.data?.error === "revision_conflict", `status ${stale.status}`);

  // ---- publish still works ------------------------------------------------
  const pub = await api(`/api/packets/${target.packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("a FlowGuide with a Library item publishes", pub.status === 200,
    `status ${pub.status} ${JSON.stringify(pub.data).slice(0, 160)}`);

  // ---- BLOCK MODE IS REFUSED, before any write ----------------------------
  const blockPacket = await makePacket("blocks", "blocks");
  const beforeItems = (await svc.from("items").select("id").eq("section_id", blockPacket.sectionId)).data?.length ?? 0;
  const refused = await api(`/api/packets/${blockPacket.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB], sectionId: blockPacket.sectionId }),
  });
  check("block-mode insertion is REFUSED",
    refused.status === 409 && refused.data?.error === "unsupported_composition",
    `status ${refused.status} error ${refused.data?.error}`);
  const afterItems = (await svc.from("items").select("id").eq("section_id", blockPacket.sectionId)).data?.length ?? 0;
  check("and nothing was written — no orphan item", afterItems === beforeItems,
    `${beforeItems} -> ${afterItems}`);
  const { error: consErr } = await svc.rpc("assert_packet_block_consistency", { p_packet_id: blockPacket.packetId });
  check("the block FlowGuide is still consistent", !consErr, consErr ? consErr.message : "intact");

  // ---- the dropped function is really gone --------------------------------
  const { error: goneErr } = await svc.rpc("library_insert_item_block", {
    p_owner: UID, p_packet_id: blockPacket.packetId, p_library_item_id: LIB, p_section_id: blockPacket.sectionId,
  });
  check("library_insert_item_block no longer exists in production",
    !!goneErr, goneErr ? goneErr.message.slice(0, 80) : "STILL PRESENT — 0019 did not apply");

  summary("Library v1 production smoke");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of libIds) await svc.from("library_items").delete().eq("id", id);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);

  const { data: lp } = packets.length ? await svc.from("packets").select("id").in("id", packets) : { data: [] };
  const { data: ll } = libIds.length ? await svc.from("library_items").select("id").in("id", libIds) : { data: [] };
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const stray = (lp ?? []).length + (ll ?? []).length + (lu ?? []).length;
  console.log(`\ncleanup: ${(lp ?? []).length} packets, ${(ll ?? []).length} library items, ` +
    `${(lu ?? []).length} users remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
