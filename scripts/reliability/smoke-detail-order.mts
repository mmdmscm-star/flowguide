// EXECUTING REGRESSION for Detail ordering.
//
// The unit tests prove the array semantics. What they cannot prove is that a
// reordered list survives the save, comes back in that order on reload, and
// reaches the person the FlowGuide is for. That last one is the whole point of
// the feature, and it is checked here against the PUBLISHED RECIPIENT PAGE
// fetched anonymously — not against the editor's own read of its own state.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-detailorder-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

// The screenshot's problem, in miniature: Type sits last and belongs first.
const IMPORTED = [
  { label: "Memory Care Shared Suite", value: "$8,990/month" },
  { label: "Community Fee", value: "$4,000" },
  { label: "Contact Name", value: "Sean Baron" },
  { label: "Type", value: "MC" },
];
const labelsOf = (rows: Array<{ label: string }>) => rows.map((r) => r.label);
const slug = `detail-order-${process.pid}`;

try {
  const { data: pk, error: pe } = await svc.from("packets").insert({
    user_id: UID, slug, title: "Detail Order Smoke", client_name: "Smoke Client",
    status: "draft", composition_mode: "legacy",
  }).select("id").single();
  if (pe) throw new Error(errText(pe));
  const packetId = (pk as { id: string }).id;
  const { data: sec } = await svc.from("sections").insert({ packet_id: packetId, title: "Communities", sort_order: 0 })
    .select("id").single();
  const { data: it } = await svc.from("items").insert({
    section_id: (sec as { id: string }).id, title: "The Reserve at Fountaingrove", sort_order: 0,
  }).select("id").single();
  const itemId = (it as { id: string }).id;

  const detailsNow = async () => ((await svc.from("item_details")
    .select("label, value, sort_order").eq("item_id", itemId).order("sort_order")).data ?? []) as
    Array<{ label: string; value: string; sort_order: number }>;

  // ---- 1. the imported order is where it starts --------------------------
  const seed = await api("/api/items", { method: "PATCH",
    body: JSON.stringify({ id: itemId, details: IMPORTED }) });
  check("[1] the details save", seed.ok, `${seed.status} ${(await seed.text()).slice(0, 160)}`);
  let rows = await detailsNow();
  check("[1] four rows, in the order sent", JSON.stringify(labelsOf(rows)) === JSON.stringify(labelsOf(IMPORTED)),
    JSON.stringify(labelsOf(rows)));
  check("[1] sort_order is the array position", JSON.stringify(rows.map((r) => r.sort_order)) === "[0,1,2,3]",
    JSON.stringify(rows.map((r) => r.sort_order)));

  // ---- 2. the professional moves Type to the top -------------------------
  const reordered = [IMPORTED[3], IMPORTED[0], IMPORTED[1], IMPORTED[2]];
  const moved = await api("/api/items", { method: "PATCH",
    body: JSON.stringify({ id: itemId, details: reordered }) });
  check("[2] the reorder saves", moved.ok, `${moved.status}`);
  rows = await detailsNow();
  check("[2] Type is now first", rows[0]?.label === "Type", JSON.stringify(labelsOf(rows)));
  check("[2] and the rest kept their sequence",
    JSON.stringify(labelsOf(rows)) === JSON.stringify(["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]),
    JSON.stringify(labelsOf(rows)));
  check("[2] no value changed while moving",
    rows.find((r) => r.label === "Type")?.value === "MC" &&
    rows.find((r) => r.label === "Community Fee")?.value === "$4,000", JSON.stringify(rows));
  check("[2] nothing was duplicated or lost", rows.length === 4, String(rows.length));

  // ---- 3. RELOAD — what the editor reads back ----------------------------
  const reload = await api(`/api/packets/${packetId}`);
  const loaded = await reload.json();
  // The editor read returns details FLAT for the whole FlowGuide, already
  // ordered by sort_order — the same ordering every renderer relies on.
  const asLoaded = ((loaded?.details ?? []) as Array<{ item_id: string; label: string }>)
    .filter((d) => String(d.item_id) === itemId);
  check("[3] the editor reloads it in the chosen order",
    JSON.stringify(labelsOf(asLoaded)) === JSON.stringify(["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]),
    JSON.stringify(labelsOf(asLoaded)));

  // ---- 4. editing a moved row does not send it back down ------------------
  const edited = [{ label: "Type", value: "MC, AL" }, ...reordered.slice(1)];
  await api("/api/items", { method: "PATCH", body: JSON.stringify({ id: itemId, details: edited }) });
  rows = await detailsNow();
  check("[4] the edited row stays first", rows[0]?.label === "Type" && rows[0]?.value === "MC, AL",
    JSON.stringify(rows.slice(0, 1)));
  check("[4] and the order behind it is untouched",
    JSON.stringify(labelsOf(rows).slice(1)) === JSON.stringify(["Memory Care Shared Suite", "Community Fee", "Contact Name"]),
    JSON.stringify(labelsOf(rows)));

  // ---- 5. adding and deleting respect the chosen order -------------------
  const added = [...edited, { label: "Pet Policy", value: "Cats welcome" }];
  await api("/api/items", { method: "PATCH", body: JSON.stringify({ id: itemId, details: added }) });
  rows = await detailsNow();
  check("[5] a new row appends without disturbing the order",
    rows[0]?.label === "Type" && rows[4]?.label === "Pet Policy" && rows.length === 5,
    JSON.stringify(labelsOf(rows)));
  const afterDelete = added.filter((d) => d.label !== "Community Fee");
  await api("/api/items", { method: "PATCH", body: JSON.stringify({ id: itemId, details: afterDelete }) });
  rows = await detailsNow();
  check("[5] deleting one leaves the rest in sequence",
    JSON.stringify(labelsOf(rows)) === JSON.stringify(["Type", "Memory Care Shared Suite", "Contact Name", "Pet Policy"]),
    JSON.stringify(labelsOf(rows)));
  check("[5] sort_order was re-tightened, with no gaps",
    JSON.stringify(rows.map((r) => r.sort_order)) === "[0,1,2,3]", JSON.stringify(rows.map((r) => r.sort_order)));

  // ---- 6. THE RECIPIENT SEES THE CHOSEN SEQUENCE -------------------------
  // Published only NOW: content editing is deliberately refused on a published
  // packet, so composing first and publishing after is the real sequence a
  // professional follows.
  const { error: pubErr } = await svc.from("packets").update({ status: "published" }).eq("id", packetId);
  check("[6] the FlowGuide publishes", !pubErr, JSON.stringify(pubErr));
  // Fetched ANONYMOUSLY — no session cookie — so this is the client's own view,
  // not the owner's.
  const page = await fetch(`${BASE}/p/${slug}`);
  const html = await page.text();
  check("[6] the recipient page loads", page.ok, String(page.status));
  const positions = ["Type", "Memory Care Shared Suite", "Contact Name", "Pet Policy"].map((l) => html.indexOf(l));
  check("[6] every detail reaches the recipient", positions.every((p) => p >= 0), JSON.stringify(positions));
  check("[6] IN THE ORDER THE PROFESSIONAL CHOSE",
    positions.every((p, i) => i === 0 || p > positions[i - 1]), JSON.stringify(positions));
  check("[6] the edited value is the one shown", html.includes("MC, AL"), "");
  check("[6] the deleted row is gone from the client's view", !html.includes("Community Fee"), "");
} finally {
  const { data: packets } = await svc.from("packets").select("id").eq("user_id", UID);
  for (const p of ((packets ?? []) as { id: string }[])) await svc.from("packets").delete().eq("id", p.id);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count: pk } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: users } = await svc.from("users").select("id", { count: "exact", head: true }).eq("id", UID);
  console.log(`\ncleanup: packets=${pk ?? 0} users=${users ?? 0} — ${!pk && !users ? "clean" : "NOT CLEAN"}`);
}
process.exit(summary("DETAIL ORDER — reorder, persist, reload, edit, add/delete, recipient view") > 0 ? 1 : 0);
