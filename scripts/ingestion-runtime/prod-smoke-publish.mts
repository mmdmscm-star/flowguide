// Corrective production checks for the publish/recipient path.
//
// Two harness mistakes this replaces:
//   1. The first smoke run posted {} to /api/packets/:id/publish, which the route
//      rejects with 400 "Invalid action" — so its "publishing is blocked during
//      an import" assertion passed for the WRONG reason.
//   2. Importing e2e.mts mints a NEW disposable user, whose session does not own
//      the packet under test, so every owner-scoped route returned 404.
// This authenticates as the packet's ACTUAL owner and uses the real contract.
//
// Spends ZERO model calls: a run can be made active without driving any chunk.
import { svc, root, check, summary, errText } from "./lib.mts";
const { buildRunChunks, SEGMENTER_VERSION } = await import(`${root}/src/lib/ingestion.ts`);
const { segmentHash } = await import(`${root}/src/lib/segmentation.ts`);

const BASE = process.env.FLOWGUIDE_BASE_URL!;
const PACKET = process.env.SMOKE_PACKET_ID!;
const OWNER = process.env.SMOKE_OWNER_ID!;
const BLOCK_PACKET = process.env.SMOKE_BLOCK_PACKET_ID;
if (!BASE || !PACKET || !OWNER) { console.error("need FLOWGUIDE_BASE_URL, SMOKE_PACKET_ID, SMOKE_OWNER_ID"); process.exit(1); }

// Session for the packet's real owner.
const token = crypto.randomUUID();
const { error: serr } = await svc.from("sessions").insert({
  user_id: OWNER, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
if (serr) { console.error("session:", errText(serr)); process.exit(1); }
const COOKIE = `flowguide_session=${token}`;

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function content(packetId: string) {
  const { data: secs } = await svc.from("sections").select("id, title").eq("packet_id", packetId).order("sort_order");
  const ids = (secs ?? []).map((s: { id: string }) => s.id);
  if (!ids.length) return { secs: [], items: [] as Array<{ title: string; address: string }> };
  const { data: items } = await svc.from("items").select("title, address, sort_order").in("section_id", ids);
  return { secs: secs ?? [], items: (items ?? []) as Array<{ title: string; address: string }> };
}

const c0 = await content(PACKET);
console.log(`owner ${OWNER}\npacket ${PACKET}: ${c0.secs.length} sections / ${c0.items.length} items\n`);
check("authenticated as the owner (owner-scoped route reachable)",
  (await api(`/api/ingest/nonexistent-run-id`)).status !== 401, "still unauthorised");

// ------------------------------------------------- 6. publish blocked mid-import
console.log("\n[6] publishing is BLOCKED while an import is active (correct contract)");
{
  const src = "Extra Community\n123 Main St, Napa, CA 94559\nA quiet place.\n";
  const { data: runId, error } = await svc.rpc("create_ingestion_run", {
    p_owner: OWNER, p_packet_id: PACKET, p_entry_point: "append", p_target_section_id: null,
    p_source_text: src, p_source_hash: segmentHash(src), p_source_len: src.length,
    p_segmenter_version: SEGMENTER_VERSION, p_chunks: buildRunChunks(src),
  });
  check("an active run exists (no model calls spent)", !error && !!runId, errText(error));

  const blocked = await api(`/api/packets/${PACKET}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  const msg = JSON.stringify(blocked.data);
  check("publish REFUSED while the run is active", blocked.status >= 400, `${blocked.status}`);
  check("refusal cites the IMPORT, not a malformed or unauthorised request",
    /import/i.test(msg) && !/invalid action|not found/i.test(msg), `${blocked.status} ${msg.slice(0, 160)}`);
  console.log(`    -> ${blocked.status} ${msg.slice(0, 130)}`);
  check("packet remained a draft", (await svc.from("packets").select("status").eq("id", PACKET).single()).data?.status === "draft", "not draft");

  const { data: d, error: derr } = await svc.rpc("discard_ingestion_run", { p_run_id: runId, p_owner: OWNER });
  check("test run discarded", !derr, errText(derr));
  check("discard preserved the packet (it has content)", d?.deletedPacket === false, JSON.stringify(d));
}

// ------------------------------------------------- 7. publish + recipient view
console.log("\n[7] the finished packet publishes and renders for the recipient");
{
  const pub = await api(`/api/packets/${PACKET}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("publish succeeds once no import is active", pub.status === 200, `${pub.status} ${JSON.stringify(pub.data).slice(0, 140)}`);
  const row = (await svc.from("packets").select("slug, status").eq("id", PACKET).single()).data;
  check("packet is published", row?.status === "published", String(row?.status));

  const r = await fetch(`${BASE}/p/${row?.slug}`);
  const html = await r.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  check("recipient view returns 200", r.status === 200, `${r.status}`);
  check("recipient view renders substantial content", text.length > 500, `${text.length} chars`);

  const c = await content(PACKET);
  const sample = c.items.slice(0, 5).map((i) => i.title);
  const found = sample.filter((t) => text.includes(t));
  check("imported item titles appear in the recipient view", found.length === sample.length, `${found.length}/${sample.length}`);
  const addr = c.items.find((i) => (i.address ?? "").length > 5)?.address;
  check("imported addresses appear in the recipient view", !addr || text.includes(addr), `looking for "${addr}"`);
  console.log(`    -> /p/${row?.slug} : ${r.status}, ${text.length} chars, ${c.items.length} items`);
}

// ------------------------------------------------- 5 recheck
console.log("\n[5-recheck] rejected block-mode attempts create no run");
if (BLOCK_PACKET) {
  const runs = (await svc.from("ingestion_runs").select("id, status").eq("packet_id", BLOCK_PACKET)).data ?? [];
  console.log(`    runs on the block packet: ${runs.length} total, statuses=${JSON.stringify(runs.map((r: { status: string }) => r.status))}`);
  // The first smoke run counted ALL runs, including the two legitimate finalized
  // ones created BEFORE the packet was converted to blocks.
  check("no ACTIVE run created by the rejected block attempts",
    runs.filter((r: { status: string }) => r.status === "active").length === 0, "active run present");
  check("every run on that packet predates conversion and is finalized",
    runs.every((r: { status: string }) => r.status === "finalized"), JSON.stringify(runs.map((r: { status: string }) => r.status)));
}

await svc.from("sessions").delete().eq("token", token);
console.log("\nreal model calls billed: 0");
process.exit(summary("PRODUCTION PUBLISH/RECIPIENT") > 0 ? 1 : 0);
