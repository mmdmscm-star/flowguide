// Migration 0016 acceptance: the ownership gate, end to end, against the real
// routes and the real database.
//
//   wrong ownership -> publish BLOCKED -> Move or Keep -> recompute -> publish
//   SUCCEEDS -> the Keep stays discoverable and reversible -> cleanup
//
// CONSUMES NO MODEL CREDITS. The packet state is constructed directly, so the
// misplacement is exact and repeatable rather than something a model has to be
// coaxed into producing. Everything downstream of that state — the gate, the
// RPCs, the recompute — is exercised through the actual HTTP routes.
//
//   npx tsx scripts/ingestion-runtime/verify-ownership-gate.mts
//
// RUN IT TWICE. It detects whether 0016 is applied and asserts the behaviour
// that is correct for that state:
//
//   BEFORE applying — a packet with a blocking finding must return 503
//     (verification unavailable: the decisions table cannot be read, so nothing
//     may be concluded), while a CLEAN packet must publish normally. That pair
//     is the deployment property: the gate's blast radius before the migration
//     is exactly the packets that should be blocked anyway.
//
//   AFTER applying — the full resolution lifecycle.
//
// Containment: one disposable user, removed at the end. Nothing else is touched.
import { svc, check, summary, errText } from "./lib.mts";
import { detectSourceRecords, segmentHash, SEGMENTER_VERSION } from "../../src/lib/segmentation.ts";
import { GATE_SOURCE, GATE_TITLES, PHOTO_A, PHOTO_B } from "../../src/lib/__fixtures__/ownership-gate-fixture.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const TAG = "flowguide-own-" + process.pid;

// The fixture is shared with ownership-gate-fixture.test.mts, which proves it
// really does produce the finding this script is written to exercise. A fixture
// that silently stopped being misplaced would make every assertion below pass
// by finding nothing.
const SOURCE = GATE_SOURCE;

const records = detectSourceRecords(SOURCE);
if (!records || records.records.length !== 2) {
  console.error("fixture is not tabular — the detector found no two records");
  process.exit(1);
}

// ---------------------------------------------------------------- is 0016 in?
const { error: probe } = await svc.from("item_media_decisions").select("id").limit(1);
const APPLIED = !probe;
console.log(`migration 0016: ${APPLIED ? "APPLIED" : "NOT APPLIED"}${probe ? ` (${probe.message})` : ""}`);
console.log(`base ${BASE}\n`);

// ---------------------------------------------------------------- session
const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = user.id as string;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;
console.log(`disposable user ${UID}\n`);

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/**
 * A packet whose provenance is real and whose photo placement is a parameter.
 * `misplace` attaches record 0's photo to item 1, which is what the gate exists
 * to catch; without it the packet is genuinely clean.
 */
async function makePacket(label: string, misplace: boolean) {
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${label}-${crypto.randomUUID().slice(0, 8)}`,
    title: `Ownership gate — ${label}`, raw_input: SOURCE,
    status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const packetId = (p as { id: string }).id;

  const { data: s } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Communities", sort_order: 0 })
    .select("id").single();
  const sectionId = (s as { id: string }).id;

  const runId = crypto.randomUUID();
  await svc.from("ingestion_runs").insert({
    id: runId, user_id: UID, packet_id: packetId, entry_point: "organize",
    source_hash: segmentHash(SOURCE), source_len: SOURCE.length,
    segmenter_version: SEGMENTER_VERSION, source_offset_base: 0,
    status: "finalized", total_chunks: 2, completed_chunks: 2,
  });
  await svc.from("ingestion_chunks").insert(records!.records.map((r, ordinal) => ({
    run_id: runId, ordinal, source_start: r.start, source_end: r.end,
    segment_hash: segmentHash(SOURCE.slice(r.start, r.end)), status: "completed",
  })));

  const ids: string[] = [];
  for (const [i, title] of GATE_TITLES.entries()) {
    const { data: it } = await svc.from("items").insert({
      section_id: sectionId, title, sort_order: i,
      origin_run_id: runId, origin_chunk_ordinal: i, origin_emit_index: 0,
    }).select("id").single();
    ids.push((it as { id: string }).id);
  }

  // Alpha's photo lands on Bravo when misplacing; otherwise each keeps its own.
  await svc.from("item_photos").insert([
    { item_id: misplace ? ids[1] : ids[0], url: PHOTO_A, sort_order: 0 },
    { item_id: ids[1], url: PHOTO_B, sort_order: misplace ? 1 : 0 },
  ]);

  return { packetId, itemIds: ids };
}

const publish = (id: string) =>
  api(`/api/packets/${id}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });

const ownership = (id: string) => api(`/api/packets/${id}/ownership`);

const resolve = (id: string, body: object) =>
  api(`/api/packets/${id}/ownership`, { method: "POST", body: JSON.stringify(body) });

const created: string[] = [];

try {
  // =========================================================================
  // The clean control. It must behave identically whether or not 0016 exists,
  // because a packet with nothing to suppress never consults the decisions
  // table at all.
  // =========================================================================
  const clean = await makePacket("clean", false);
  created.push(clean.packetId);

  const cleanOwn = await ownership(clean.packetId);
  check("clean packet: ownership readable", cleanOwn.status === 200, `status ${cleanOwn.status}`);
  check("clean packet: no findings", (cleanOwn.data.findings ?? []).length === 0,
    JSON.stringify(cleanOwn.data.findings));
  check("clean packet: was actually checked, not skipped", cleanOwn.data.checked === true);

  const cleanPub = await publish(clean.packetId);
  check("clean packet: PUBLISHES regardless of 0016", cleanPub.status === 200,
    `status ${cleanPub.status} ${JSON.stringify(cleanPub.data).slice(0, 200)}`);

  // =========================================================================
  // The blocked packet.
  // =========================================================================
  const wrong = await makePacket("misplaced", true);
  created.push(wrong.packetId);

  if (!APPLIED) {
    // The whole point of the trust policy: an unreadable decisions table is not
    // a clean check. It must neither publish nor accuse.
    const blockedPub = await publish(wrong.packetId);
    check("pre-0016: a blocking finding does NOT publish", blockedPub.status !== 200,
      `status ${blockedPub.status}`);
    check("pre-0016: it reports UNAVAILABLE, not a finding",
      blockedPub.status === 503 && blockedPub.data.error === "ownership_unavailable",
      `status ${blockedPub.status} error ${blockedPub.data.error}`);
    check("pre-0016: it is marked retryable", blockedPub.data.retryable === true);
    check("pre-0016: it accuses nobody", !blockedPub.data.findings);

    const { data: still } = await svc.from("packets").select("status").eq("id", wrong.packetId).single();
    check("pre-0016: the packet really is still a draft", (still as { status: string }).status === "draft");

    console.log("\nPre-apply behaviour confirmed. Apply 0016, then run this again.");
    summary("ownership gate (pre-apply)");
  } else {
    // ---- blocked
    const pub1 = await publish(wrong.packetId);
    check("publish is BLOCKED by the misplaced photo",
      pub1.status === 409 && pub1.data.error === "ownership_unresolved",
      `status ${pub1.status} ${JSON.stringify(pub1.data).slice(0, 200)}`);
    check("the block names the photo", (pub1.data.findings ?? []).some((f: { url: string }) => f.url === PHOTO_A));

    // ---- what is offered
    const own1 = await ownership(wrong.packetId);
    const finding = (own1.data.findings ?? []).find((f: { url: string }) => f.url === PHOTO_A);
    check("the finding offers Move and Keep", !!finding && finding.actions.includes("move") && finding.actions.includes("keep"),
      JSON.stringify(finding));
    check("Move proposes the item the SOURCE names", finding?.proposedItemId === wrong.itemIds[0],
      `proposed ${finding?.proposedItemId} expected ${wrong.itemIds[0]}`);

    // ---- a destination the source did not propose is refused
    const bogus = await resolve(wrong.packetId, {
      action: "move", itemId: finding.itemId, url: PHOTO_A, toItemId: wrong.itemIds[1],
    });
    check("a destination the source did not name is REFUSED",
      bogus.status === 409 && bogus.data.error === "destination_mismatch",
      `status ${bogus.status} error ${bogus.data.error}`);

    // ---- Keep, and publish
    const kept = await resolve(wrong.packetId, { action: "keep", itemId: finding.itemId, url: PHOTO_A });
    check("Keep is accepted", kept.status === 200, `status ${kept.status} ${JSON.stringify(kept.data).slice(0, 200)}`);
    check("Keep clears the block", kept.data.blockingCount === 0, `blocking ${kept.data.blockingCount}`);
    check("Keep is DISCOVERABLE afterwards", (kept.data.kept ?? []).some((k: { url: string }) => k.url === PHOTO_A),
      JSON.stringify(kept.data.kept));
    check("and carries a title a human can recognise",
      (kept.data.kept ?? [])[0]?.itemTitle === GATE_TITLES[1], JSON.stringify(kept.data.kept));

    const pub2 = await publish(wrong.packetId);
    check("publish SUCCEEDS once the finding is resolved", pub2.status === 200,
      `status ${pub2.status} ${JSON.stringify(pub2.data).slice(0, 200)}`);

    // ---- the Keep survives a fresh read, by anyone, later
    const own2 = await ownership(wrong.packetId);
    check("the Keep is still there on a fresh recompute",
      (own2.data.kept ?? []).some((k: { url: string }) => k.url === PHOTO_A));
    check("and its finding stays suppressed", own2.data.blockingCount === 0);

    // ---- reversible
    await svc.from("packets").update({ status: "draft" }).eq("id", wrong.packetId);
    const undone = await resolve(wrong.packetId, { action: "unkeep", itemId: finding.itemId, url: PHOTO_A });
    check("the Keep can be undone", undone.status === 200, `status ${undone.status}`);
    check("undoing it brings the finding BACK", undone.data.blockingCount === 1,
      `blocking ${undone.data.blockingCount}`);
    check("and the decision is gone", (undone.data.kept ?? []).length === 0, JSON.stringify(undone.data.kept));

    const pub3 = await publish(wrong.packetId);
    check("so publishing is blocked again", pub3.status === 409, `status ${pub3.status}`);

    // ---- Move: the other resolution, on a second packet
    const moved = await makePacket("moved", true);
    created.push(moved.packetId);
    const own3 = await ownership(moved.packetId);
    const f2 = (own3.data.findings ?? []).find((f: { url: string }) => f.url === PHOTO_A);
    const mv = await resolve(moved.packetId, {
      action: "move", itemId: f2.itemId, url: PHOTO_A, toItemId: f2.proposedItemId,
    });
    check("Move is accepted", mv.status === 200, `status ${mv.status} ${JSON.stringify(mv.data).slice(0, 200)}`);
    check("Move clears the block WITHOUT recording a decision",
      mv.data.blockingCount === 0 && (mv.data.kept ?? []).length === 0,
      `blocking ${mv.data.blockingCount} kept ${JSON.stringify(mv.data.kept)}`);

    const { data: photos } = await svc.from("item_photos")
      .select("item_id, url").eq("url", PHOTO_A);
    check("the photo really moved to the item the source names",
      (photos ?? []).length === 1 && (photos as { item_id: string }[])[0].item_id === moved.itemIds[0],
      JSON.stringify(photos));

    const pub4 = await publish(moved.packetId);
    check("and the moved packet publishes", pub4.status === 200, `status ${pub4.status}`);

    summary("ownership gate (post-apply)");
  }
} finally {
  // ---------------------------------------------------------------- cleanup
  for (const id of created) await svc.from("packets").delete().eq("id", id);
  await svc.from("users").delete().eq("id", UID);

  // Check the packets BY ID. Querying them by user_id after deleting the user
  // returns nothing whether or not they survived, which would report success
  // for a failed cleanup.
  const { data: leftPackets } = await svc.from("packets").select("id").in("id", created.length ? created : ["-"]);
  const { data: leftUsers } = await svc.from("users").select("id").eq("id", UID);
  const { data: leftRuns } = await svc.from("ingestion_runs").select("id").eq("user_id", UID);
  const stray = (leftPackets ?? []).length + (leftUsers ?? []).length + (leftRuns ?? []).length;
  console.log(`\ncleanup: ${(leftPackets ?? []).length} packets, ${(leftUsers ?? []).length} users, ` +
    `${(leftRuns ?? []).length} runs remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
