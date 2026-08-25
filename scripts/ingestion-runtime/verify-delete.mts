// VERIFICATION for editor-level delete.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=… \
//     npx tsx scripts/ingestion-runtime/verify-delete.mts
//
// Disposable data only. Covers the three cases that matter: a draft, a
// published FlowGuide (whose link must actually stop working), and a packet
// belonging to somebody else (which must not be deletable at all).
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE) { console.error("FLOWGUIDE_BASE_URL required"); process.exit(2); }
const TAG = "flowguide-delete-" + process.pid;
console.log(`\neditor delete verification — ${BASE}\n`);

async function makeUser(suffix: string) {
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}-${suffix}@disposable.invalid` }).select("id").single();
  if (error) { console.error(errText(error)); process.exit(1); }
  const id = (u as { id: string }).id;
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({
    user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { id, cookie: `flowguide_session=${token}` };
}

const owner = await makeUser("owner");
const stranger = await makeUser("stranger");

async function makePacket(slug: string, title: string, clientName: string) {
  const { data: p } = await svc.from("packets").insert({
    user_id: owner.id, slug, title, client_name: clientName,
    status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const pid = (p as { id: string }).id;
  const { data: s } = await svc.from("sections")
    .insert({ packet_id: pid, title: "S", sort_order: 0 }).select("id").single();
  await svc.from("items").insert({ section_id: (s as { id: string }).id, title: "Item", sort_order: 0 });
  return pid;
}
const exists = async (id: string) =>
  ((await svc.from("packets").select("id", { count: "exact", head: true }).eq("id", id)).count ?? 0) > 0;

try {
  await svc.from("professional_profiles").insert({
    user_id: owner.id, name: "Dana Whitfield", phone: "(206) 555-0100" });

  // === 1. A DRAFT, deleted by its owner ====================================
  const draft = await makePacket(`${TAG}-draft`, "Draft To Bin", "the Alvarez family");
  const editor = await fetch(`${BASE}/edit/${draft}`, { headers: { Cookie: owner.cookie } });
  check("the editor loads for its owner", editor.status === 200, `status ${editor.status}`);

  const d1 = await fetch(`${BASE}/api/packets/${draft}`, {
    method: "DELETE", headers: { Cookie: owner.cookie } });
  check("the owner can delete from the existing endpoint", d1.status === 200, `status ${d1.status}`);
  check("and the FlowGuide is really gone", !(await exists(draft)), "the row survived");

  // === 2. A PUBLISHED FlowGuide: the link must stop working =================
  const pub = await makePacket(`${TAG}-pub`, "Published To Bin", "the Alvarez family");
  const publish = await fetch(`${BASE}/api/packets/${pub}/publish`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ action: "publish" }) });
  check("the fixture publishes", publish.status === 200, `status ${publish.status}`);
  const before = await fetch(`${BASE}/p/${TAG}-pub`);
  check("its link works before deleting", before.status === 200, `status ${before.status}`);

  const d2 = await fetch(`${BASE}/api/packets/${pub}`, {
    method: "DELETE", headers: { Cookie: owner.cookie } });
  check("a published FlowGuide deletes", d2.status === 200, `status ${d2.status}`);
  const after = await fetch(`${BASE}/p/${TAG}-pub`);
  check("AND THE SHARED LINK NOW 404s — which is what the warning promises",
    after.status === 404, `status ${after.status}`);

  // === 3. Somebody else's FlowGuide, and one that never existed =============
  const mine = await makePacket(`${TAG}-mine`, "Not Yours", "");

  const asStranger = await fetch(`${BASE}/api/packets/${mine}`, {
    method: "DELETE", headers: { Cookie: stranger.cookie } });
  const strangerBody = await asStranger.text();
  check("a stranger's delete does not remove it", await exists(mine),
    "another user deleted a packet they do not own");
  check("AND IT NO LONGER CLAIMS SUCCESS — 404, not 200",
    asStranger.status === 404, `status ${asStranger.status}`);

  const ghost = "00000000-0000-4000-8000-000000000000";
  const asGhost = await fetch(`${BASE}/api/packets/${ghost}`, {
    method: "DELETE", headers: { Cookie: owner.cookie } });
  const ghostBody = await asGhost.text();
  check("a packet that never existed also 404s", asGhost.status === 404, `status ${asGhost.status}`);

  // The whole point of answering 404 for both: an id that is real-but-not-yours
  // must be indistinguishable from an id that is not real at all.
  check("NO LEAKAGE — the two 404s are byte-identical",
    strangerBody === ghostBody, `"${strangerBody}" vs "${ghostBody}"`);

  check("and the endpoint still requires a session",
    (await fetch(`${BASE}/api/packets/${mine}`, { method: "DELETE" })).status === 401,
    "signed-out delete was not rejected");

  // Deleting the same packet twice: the second attempt is a 404, not a silent OK.
  const twice = await makePacket(`${TAG}-twice`, "Delete Me Twice", "");
  const first = await fetch(`${BASE}/api/packets/${twice}`, {
    method: "DELETE", headers: { Cookie: owner.cookie } });
  const second = await fetch(`${BASE}/api/packets/${twice}`, {
    method: "DELETE", headers: { Cookie: owner.cookie } });
  check("deleting an owned packet succeeds once", first.status === 200, `status ${first.status}`);
  check("and the SECOND attempt reports 404 rather than success",
    second.status === 404, `status ${second.status}`);

  // What a professional would actually read.
  const shown = JSON.parse(ghostBody || "{}");
  check("the 404 carries a sentence a professional can read",
    typeof shown.message === "string" && /no longer exists/.test(shown.message),
    JSON.stringify(shown));

  // === 4. The editor still loads a packet that is gone ======================
  const goneEditor = await fetch(`${BASE}/edit/${draft}`, {
    headers: { Cookie: owner.cookie }, redirect: "manual" });
  check("opening a deleted FlowGuide's editor does not 500",
    goneEditor.status < 500, `status ${goneEditor.status}`);
} finally {
  for (const u of [owner.id, stranger.id]) {
    await svc.from("packets").delete().eq("user_id", u);
    await svc.from("professional_profiles").delete().eq("user_id", u);
    await svc.from("sessions").delete().eq("user_id", u);
    await svc.from("users").delete().eq("id", u);
  }
  const { count } = await svc.from("users").select("id", { count: "exact", head: true })
    .like("email", `${TAG}%`);
  console.log(`\ncleanup: ${count ?? 0} users remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
summary("editor delete verification");
