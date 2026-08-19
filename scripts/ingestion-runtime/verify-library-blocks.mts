// Migration 0018 acceptance — Library insertion into a BLOCK-mode FlowGuide.
//
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-library-blocks.mts
//
// Requires the dev server running and serving THIS branch. CONSUMES NO MODEL
// CREDITS: every packet is constructed directly and converted with the real
// convert_packet_to_blocks, so the block structure is the one production makes.
//
// BOUNDED to the new path. It does not re-prove 0017 — verify-library.mts covers
// that — and it does not exercise heading blocks, reordering, or conversion
// beyond using it to obtain a genuine block packet.
//
// THE PROPERTY THAT MATTERS. An item and its packet_blocks row are a bijection
// the database enforces. If insertion could produce one without the other, the
// packet becomes permanently inconsistent AND unpublishable, and no screen in
// the product can even see the orphan to repair it. Half of this file is about
// that single invariant surviving both success and refusal.
import { svc, check, summary, errText } from "./lib.mts";
import { segmentHash, SEGMENTER_VERSION, detectSourceRecords } from "../../src/lib/segmentation.ts";
import { GATE_SOURCE, GATE_TITLES, PHOTO_A, PHOTO_B } from "../../src/lib/__fixtures__/ownership-gate-fixture.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const TAG = "flowguide-blk-" + process.pid;
console.log(`\nblock-mode Library insertion proof — ${BASE}\n`);

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
const otherUsers: string[] = [];

/** A real block packet: built as legacy, then converted with the production RPC. */
async function makeBlockPacket(label: string, withProvenance = false) {
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${label}`, title: `Block proof — ${label}`,
    raw_input: withProvenance ? GATE_SOURCE : "", status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const packetId = (p as { id: string }).id;
  packets.push(packetId);

  const { data: s } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Communities", sort_order: 0 }).select("id").single();
  const sectionId = (s as { id: string }).id;

  const seeded: string[] = [];
  if (withProvenance) {
    const runId = crypto.randomUUID();
    await svc.from("ingestion_runs").insert({
      id: runId, user_id: UID, packet_id: packetId, entry_point: "organize",
      source_hash: segmentHash(GATE_SOURCE), source_len: GATE_SOURCE.length,
      segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
      status: "finalized", total_chunks: 2, completed_chunks: 2,
    });
    const recs = detectSourceRecords(GATE_SOURCE)!.records;
    await svc.from("ingestion_chunks").insert(recs.map((r, ordinal) => ({
      run_id: runId, ordinal, source_start: r.start, source_end: r.end,
      segment_hash: segmentHash(GATE_SOURCE.slice(r.start, r.end)), status: "completed",
    })));
    for (const [i, title] of GATE_TITLES.entries()) {
      const { data: it } = await svc.from("items").insert({
        section_id: sectionId, title, sort_order: i,
        origin_run_id: runId, origin_chunk_ordinal: i, origin_emit_index: 0,
      }).select("id").single();
      seeded.push((it as { id: string }).id);
    }
    await svc.from("item_photos").insert([
      { item_id: seeded[0], url: PHOTO_A, sort_order: 0 },
      { item_id: seeded[1], url: PHOTO_B, sort_order: 0 },
    ]);
  } else {
    const { data: it } = await svc.from("items")
      .insert({ section_id: sectionId, title: "Existing item", sort_order: 0 })
      .select("id").single();
    seeded.push((it as { id: string }).id);
  }

  // The production conversion, not a hand-built block layout.
  const { error: convErr } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: packetId });
  if (convErr) throw new Error(`convert failed: ${convErr.message}`);
  return { packetId, sectionId, seeded };
}

async function blocksOf(packetId: string) {
  const { data } = await svc.from("packet_blocks")
    .select("id, position, block_type, item_id").eq("packet_id", packetId).order("position");
  return (data ?? []) as Array<{ id: string; position: number; block_type: string; item_id: string | null }>;
}
async function itemsOf(packetId: string) {
  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", packetId);
  const { data } = await svc.from("items")
    .select("id, title, library_item_id, library_item_revision, origin_run_id, origin_chunk_ordinal, origin_emit_index")
    .in("section_id", (secs ?? []).map((s: { id: string }) => s.id));
  return (data ?? []) as Array<Record<string, unknown>>;
}

try {
  // A Library entry to insert.
  const { data: lib } = await svc.from("library_items").insert({
    user_id: UID, title: "Brookdale Chanate", address: "3800 Chanate Rd",
    description: "Assisted living and secured memory care.", notes: "",
    details: [{ label: "AL 2 Bedroom", value: "$6,100/mo" }, { label: "Pet fee", value: "$500" }],
    links: [{ url: "https://example.invalid/tour", label: "Tour" }],
    photos: [{ url: "https://cdn.example.invalid/ch.jpg" }],
    contacts: [{ name: "Dana Reed", role: "Director", phone: "555-0100", email: "", website: "" }],
  }).select("id, revision").single();
  const LIB = (lib as { id: string; revision: number });
  libraryIds.push(LIB.id);

  // =======================================================================
  // 1-4, 7-8. The successful insertion.
  // =======================================================================
  const bp = await makeBlockPacket("insert");
  const before = await blocksOf(bp.packetId);
  check("setup: conversion produced a real block packet",
    before.length >= 2 && before.some((b) => b.block_type === "item"),
    JSON.stringify(before.map((b) => [b.position, b.block_type])));

  const beforeItems = (await itemsOf(bp.packetId)).length;
  const maxPos = Math.max(...before.map((b) => b.position));

  const ins = await api(`/api/packets/${bp.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB.id], sectionId: bp.sectionId }),
  });
  check("1. insertion into a block FlowGuide succeeds", ins.status === 200,
    `status ${ins.status} ${JSON.stringify(ins.data).slice(0, 200)}`);
  const newItemId = ins.data?.itemIds?.[0] as string;

  const after = await blocksOf(bp.packetId);
  const afterItems = await itemsOf(bp.packetId);
  check("2a. exactly ONE item was created", afterItems.length === beforeItems + 1,
    `${beforeItems} -> ${afterItems.length}`);
  check("2b. exactly ONE block was created", after.length === before.length + 1,
    `${before.length} -> ${after.length}`);

  const newBlocks = after.filter((b) => b.item_id === newItemId);
  check("2c. exactly ONE block references the new item", newBlocks.length === 1,
    JSON.stringify(newBlocks));
  check("2d. and it is an ITEM block", newBlocks[0]?.block_type === "item", newBlocks[0]?.block_type);

  check("3. the block is APPENDED at max(position) + 1",
    newBlocks[0]?.position === maxPos + 1, `expected ${maxPos + 1}, got ${newBlocks[0]?.position}`);
  const positions = after.map((b) => b.position).sort((a, b) => a - b);
  check("3b. positions remain dense 0..n-1",
    positions.every((p, i) => p === i), JSON.stringify(positions));

  const { error: consErr } = await svc.rpc("assert_packet_block_consistency", { p_packet_id: bp.packetId });
  check("4. assert_packet_block_consistency passes", !consErr,
    consErr ? consErr.message : "bijection intact");

  const newItem = afterItems.find((i) => i.id === newItemId)!;
  check("7. Library lineage is recorded, BOTH columns",
    newItem.library_item_id === LIB.id && Number(newItem.library_item_revision) === LIB.revision,
    JSON.stringify({ id: newItem.library_item_id, rev: newItem.library_item_revision }));
  check("8. 0014 ingestion provenance remains NULL",
    newItem.origin_run_id === null && newItem.origin_chunk_ordinal === null && newItem.origin_emit_index === null,
    JSON.stringify({ run: newItem.origin_run_id, chunk: newItem.origin_chunk_ordinal, emit: newItem.origin_emit_index }));

  // Content actually travelled.
  const { data: det } = await svc.from("item_details").select("label").eq("item_id", newItemId).order("sort_order");
  const { data: pho } = await svc.from("item_photos").select("url").eq("item_id", newItemId);
  check("payload travelled with it", (det ?? []).length === 2 && (pho ?? []).length === 1,
    `${(det ?? []).length} details, ${(pho ?? []).length} photos`);

  // =======================================================================
  // 5. The block editor's own data path returns it.
  // =======================================================================
  const editorSees = await api(`/api/packets/${bp.packetId}/library-candidates`);
  check("5. the new item is visible through the editor's data path",
    (editorSees.data?.items ?? []).some((i: { id: string }) => i.id === newItemId),
    JSON.stringify((editorSees.data?.items ?? []).map((i: { title: string }) => i.title)));

  // =======================================================================
  // 6. Publish still succeeds — this is where an orphan would surface.
  // =======================================================================
  const pub = await api(`/api/packets/${bp.packetId}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("6. the block FlowGuide still publishes", pub.status === 200,
    `status ${pub.status} ${JSON.stringify(pub.data).slice(0, 200)}`);

  // =======================================================================
  // 9. REFUSAL IS ATOMIC — no orphan item, no orphan block.
  // =======================================================================
  // (a) a published packet is not a draft
  const blocksBefore = (await blocksOf(bp.packetId)).length;
  const itemsBefore = (await itemsOf(bp.packetId)).length;
  const refusedDraft = await api(`/api/packets/${bp.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB.id], sectionId: bp.sectionId }),
  });
  check("9a. insertion into a published packet is refused", refusedDraft.status !== 200,
    `status ${refusedDraft.status}`);
  check("9b. and left no orphan item or block",
    (await blocksOf(bp.packetId)).length === blocksBefore &&
    (await itemsOf(bp.packetId)).length === itemsBefore,
    `blocks ${blocksBefore} -> ${(await blocksOf(bp.packetId)).length}`);

  // (b) a Library item belonging to somebody else
  const bp2 = await makeBlockPacket("foreign");
  const { data: other } = await svc.from("users")
    .insert({ email: `${TAG}-other@disposable.invalid` }).select("id").single();
  otherUsers.push((other as { id: string }).id);
  const { data: foreignLib } = await svc.from("library_items").insert({
    user_id: (other as { id: string }).id, title: "Someone else's entry",
    address: "", description: "", notes: "",
    details: [], links: [], photos: [], contacts: [],
  }).select("id").single();

  const b2Blocks = (await blocksOf(bp2.packetId)).length;
  const b2Items = (await itemsOf(bp2.packetId)).length;
  const { error: rpcErr } = await svc.rpc("library_insert_item_block", {
    p_owner: UID, p_packet_id: bp2.packetId,
    p_library_item_id: (foreignLib as { id: string }).id, p_section_id: bp2.sectionId,
  });
  check("9c. a Library item owned by someone else is rejected", !!rpcErr,
    rpcErr ? rpcErr.message.slice(0, 90) : "ACCEPTED — ownership is not enforced");
  check("9d. and the rejection wrote NOTHING — no orphan item, no orphan block",
    (await blocksOf(bp2.packetId)).length === b2Blocks &&
    (await itemsOf(bp2.packetId)).length === b2Items,
    `blocks ${b2Blocks} -> ${(await blocksOf(bp2.packetId)).length}, items ${b2Items} -> ${(await itemsOf(bp2.packetId)).length}`);

  const { error: consErr2 } = await svc.rpc("assert_packet_block_consistency", { p_packet_id: bp2.packetId });
  check("9e. the packet is still consistent after a refusal", !consErr2,
    consErr2 ? consErr2.message : "bijection intact");

  // =======================================================================
  // 10. Mixed origin — a Library item must not switch ownership checking off.
  // =======================================================================
  const bp3 = await makeBlockPacket("mixed", true);
  const ownBefore = await api(`/api/packets/${bp3.packetId}/ownership`);
  check("10a. an imported block packet is CHECKED", ownBefore.data?.checked === true,
    `checked=${ownBefore.data?.checked}`);

  const insMixed = await api(`/api/packets/${bp3.packetId}/items/from-library`, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB.id], sectionId: bp3.sectionId }),
  });
  check("10b. inserting into it succeeds", insMixed.status === 200, `status ${insMixed.status}`);

  const ownAfter = await api(`/api/packets/${bp3.packetId}/ownership`);
  check("10c. ownership is STILL checked after the insertion",
    ownAfter.data?.checked === true, `checked=${ownAfter.data?.checked}`);
  check("10d. and no false finding was produced against it",
    (ownAfter.data?.findings ?? []).length === (ownBefore.data?.findings ?? []).length,
    `before ${(ownBefore.data?.findings ?? []).length}, after ${(ownAfter.data?.findings ?? []).length}`);

  const { error: consErr3 } = await svc.rpc("assert_packet_block_consistency", { p_packet_id: bp3.packetId });
  check("10e. the mixed packet is consistent", !consErr3, consErr3 ? consErr3.message : "intact");

  summary("block-mode Library insertion");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of libraryIds) await svc.from("library_items").delete().eq("id", id);
  for (const id of otherUsers) await svc.from("users").delete().eq("id", id);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);

  // BY ID, not by a predicate that returns nothing once the user is gone.
  const { data: lp } = packets.length ? await svc.from("packets").select("id").in("id", packets) : { data: [] };
  const { data: ll } = libraryIds.length ? await svc.from("library_items").select("id").in("id", libraryIds) : { data: [] };
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const { data: lb } = packets.length ? await svc.from("packet_blocks").select("id").in("packet_id", packets) : { data: [] };
  const stray = (lp ?? []).length + (ll ?? []).length + (lu ?? []).length + (lb ?? []).length;
  console.log(`\ncleanup: ${(lp ?? []).length} packets, ${(lb ?? []).length} blocks, ` +
    `${(ll ?? []).length} library items, ${(lu ?? []).length} users remaining — ` +
    `${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
