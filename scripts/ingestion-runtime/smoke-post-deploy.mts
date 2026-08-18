// Post-deploy smoke test, against PRODUCTION, on disposable data only.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://flowguide-ruddy.vercel.app \
//     npx tsx scripts/ingestion-runtime/smoke-post-deploy.mts
//
// NO LIVE CLIENT PACKET IS READ OR WRITTEN. Every packet here is created by this
// script under a disposable user and deleted in the finally block. The signed-out
// probe uses one of those packets so a 401 is unambiguous — a random uuid would
// return 401 whether or not the route can see the row.
//
// The pre-seg-v4 case is CONSTRUCTED rather than borrowed: a disposable packet
// carrying a run recorded as seg-v3. That reproduces the version mismatch every
// real pre-deploy packet now has, without touching one.
import { svc, check, summary, errText } from "./lib.mts";
import { segmentHash } from "../../src/lib/segmentation.ts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE || BASE.includes("localhost")) {
  console.error("FLOWGUIDE_BASE_URL must be the production origin for a post-deploy smoke test");
  process.exit(2);
}
const TAG = "flowguide-smoke-" + process.pid;
console.log(`\npost-deploy smoke — ${BASE}\n`);

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

const created: string[] = [];

async function api(path: string, init: RequestInit = {}, withAuth = true) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Cookie: COOKIE } : {}),
      ...(init.headers || {}),
    },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/** A minimal publishable packet. `segmenterVersion` decides whether ownership
 *  can prove anything about it. */
async function makePacket(label: string, segmenterVersion: string) {
  const SOURCE = `Alpha House\t101 First St\thttps://cdn.example.invalid/a-${label}.jpg\n`;
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: `${TAG}-${label}`, title: `Smoke ${label}`,
    raw_input: SOURCE, status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const packetId = (p as { id: string }).id;
  created.push(packetId);

  const { data: s } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Communities", sort_order: 0 })
    .select("id").single();
  const sectionId = (s as { id: string }).id;

  const runId = crypto.randomUUID();
  await svc.from("ingestion_runs").insert({
    id: runId, user_id: UID, packet_id: packetId, entry_point: "organize",
    source_hash: segmentHash(SOURCE), source_len: SOURCE.length,
    segmenter_version: segmenterVersion, source_offset_base: 0,
    status: "finalized", total_chunks: 1, completed_chunks: 1,
  });
  await svc.from("ingestion_chunks").insert({
    run_id: runId, ordinal: 0, source_start: 0, source_end: SOURCE.length,
    segment_hash: segmentHash(SOURCE), status: "completed",
  });

  const { data: it } = await svc.from("items").insert({
    section_id: sectionId, title: "Alpha House", sort_order: 0,
    origin_run_id: runId, origin_chunk_ordinal: 0, origin_emit_index: 0,
  }).select("id").single();
  await svc.from("item_photos").insert({
    item_id: (it as { id: string }).id,
    url: `https://cdn.example.invalid/a-${label}.jpg`, sort_order: 0,
  });
  return packetId;
}

try {
  // =======================================================================
  // 2. The ownership route is live and rejects signed-out access.
  // =======================================================================
  const owned = await makePacket("authcheck", "seg-v4");

  const signedOut = await api(`/api/packets/${owned}/ownership`, {}, false);
  check("ownership route exists in production (not 404)",
    signedOut.status !== 404, `status ${signedOut.status}`);
  check("and rejects signed-out access on a REAL packet we own",
    signedOut.status === 401, `status ${signedOut.status} ${JSON.stringify(signedOut.data).slice(0, 120)}`);

  const signedIn = await api(`/api/packets/${owned}/ownership`);
  check("the owner can read it", signedIn.status === 200,
    `status ${signedIn.status} ${JSON.stringify(signedIn.data).slice(0, 160)}`);

  // =======================================================================
  // 3. No phantom ownership panel.
  //
  // OwnershipDecisions renders null unless `kept` is non-empty, so an empty
  // `kept` on a packet with no decisions IS the editor showing nothing.
  // =======================================================================
  check("a packet with no decisions reports none — the editor panel stays hidden",
    Array.isArray(signedIn.data?.kept) && signedIn.data.kept.length === 0,
    JSON.stringify(signedIn.data?.kept));
  check("and the check is not silently unavailable",
    signedIn.data?.error !== "ownership_unavailable", JSON.stringify(signedIn.data).slice(0, 160));

  // =======================================================================
  // 4. A pre-seg-v4 packet still publishes — nonblocking version mismatch.
  // =======================================================================
  const legacy = await makePacket("segv3", "seg-v3");
  const legacyOwn = await api(`/api/packets/${legacy}/ownership`);
  check("a seg-v3 packet's ownership route answers rather than erroring",
    legacyOwn.status === 200, `status ${legacyOwn.status}`);
  check("a seg-v3 packet DECLINES rather than being checked",
    legacyOwn.data?.checked === false,
    `checked=${legacyOwn.data?.checked} — expected false on a segmenter version mismatch`);
  check("a decline produces no findings and nothing blocking",
    (legacyOwn.data?.findings ?? []).length === 0 && legacyOwn.data?.blockingCount === 0,
    JSON.stringify(legacyOwn.data).slice(0, 160));

  const legacyPub = await api(`/api/packets/${legacy}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("a pre-seg-v4 packet PUBLISHES normally", legacyPub.status === 200,
    `status ${legacyPub.status} ${JSON.stringify(legacyPub.data).slice(0, 200)}`);
  check("and was not blocked by an unavailable check",
    legacyPub.data?.error !== "ownership_unavailable", JSON.stringify(legacyPub.data).slice(0, 160));

  summary("post-deploy smoke");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of created) await svc.from("packets").delete().eq("id", id);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);

  const { data: leftPackets } = created.length
    ? await svc.from("packets").select("id").in("id", created)
    : { data: [] };
  const { data: leftUsers } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const stray = (leftPackets ?? []).length + (leftUsers ?? []).length;
  console.log(`\ncleanup: ${(leftPackets ?? []).length} packets, ${(leftUsers ?? []).length} users remaining` +
    ` — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
