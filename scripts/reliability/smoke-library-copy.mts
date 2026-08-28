// EXECUTING REGRESSION for the two Library copy paths.
//
// The tests that already covered this workflow assert on the TEXT of the route
// and the migration. That is why a call to a signature 0033 had dropped sat
// undetected: postgres resolves a call inside a plpgsql body when the body RUNS,
// so nothing short of running it could have found this.
//
// So this runs it. Disposable user, real Library rows, real production routes.
// Requires 0036 to be applied — before that it reproduces the reported failure,
// which is the point.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-libcopy-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

// Distinctive values throughout: a default or an empty set must not be able to
// pass these assertions by accident.
const mk = (n: string) => ({
  user_id: UID,
  title: `${n} Manor`,
  description: `${n} has a walled kitchen garden and eleven private rooms.`,
  notes: `${n}: the director is retiring in March.`,
  address: `${n} 41 Orchard Lane, Petaluma, CA 94952`,
  details: [{ label: `${n} Studio`, value: "$4,321/month" }],
  links: [{ url: `https://${n.toLowerCase()}.example.com/`, label: "Website" }],
  photos: [{ url: `https://cdn.example.com/${n.toLowerCase()}-1.jpg` }],
  contacts: [{ name: `${n} Director`, role: "Executive Director", phone: "(707) 555-0161" }],
});

try {
  const { data: libRows, error: le } = await svc.from("library_items").insert([mk("Alpha"), mk("Beta")]).select("*");
  if (le) throw new Error(errText(le));
  const lib = (libRows ?? []) as Record<string, unknown>[];
  const alpha = lib.find((r) => String(r.title).startsWith("Alpha"))!;
  const beta = lib.find((r) => String(r.title).startsWith("Beta"))!;
  const ids = [String(alpha.id), String(beta.id)];

  // ---- 1. CREATE A FLOWGUIDE FROM LIBRARY — the reported failure ----------
  const created = await api("/api/packets/from-library", { method: "POST",
    body: JSON.stringify({ libraryItemIds: ids, title: "Copy Smoke", clientName: "Smoke Client" }) });
  const cbody = await created.json();
  check("[1] creation SUCCEEDS", created.status === 201, `${created.status} ${JSON.stringify(cbody).slice(0, 240)}`);
  check("[1] no database text reached the client",
    !/update_item_content|jsonb|uuid,|does not exist/.test(JSON.stringify(cbody)), JSON.stringify(cbody).slice(0, 200));
  if (created.status !== 201) throw new Error("creation failed — the remaining checks would be meaningless");
  const packetId = String(cbody.packetId);
  check("[1] both entries were copied", cbody.count === 2, String(cbody.count));

  // details / links / photos / contacts are CHILD TABLES, written by
  // update_item_content — which is exactly the call that was broken, so reading
  // them off `items` would have asserted nothing about the thing under repair.
  const childrenOf = async (itemId: string) => {
    const one = async (t: string) => ((await svc.from(t).select("*").eq("item_id", itemId).order("sort_order")).data ?? []) as Record<string, unknown>[];
    return {
      details: await one("item_details"), links: await one("item_links"),
      photos: await one("item_photos"), contacts: await one("item_contacts"),
    };
  };
  const itemsOf = async (pid: string) => {
    const { data: secs } = await svc.from("sections").select("id").eq("packet_id", pid);
    const sids = ((secs ?? []) as { id: string }[]).map((s) => s.id);
    const { data } = await svc.from("items").select("*").in("section_id", sids).order("sort_order");
    return (data ?? []) as Record<string, unknown>[];
  };
  let items = await itemsOf(packetId);
  check("[2] two items landed", items.length === 2, String(items.length));
  check("[2] in the order chosen", String(items[0]?.title).startsWith("Alpha") && String(items[1]?.title).startsWith("Beta"),
    JSON.stringify(items.map((i) => i.title)));

  const a = items[0];
  const kids = await childrenOf(String(a.id));
  check("[2] description copied", String(a.description).includes("walled kitchen garden"), String(a.description).slice(0, 60));
  check("[2] private note copied", String(a.notes).includes("retiring in March"), String(a.notes));
  check("[2] address copied", String(a.address).includes("41 Orchard Lane"), String(a.address));
  check("[2] details copied into item_details", JSON.stringify(kids.details).includes("$4,321/month"), JSON.stringify(kids.details));
  check("[2] links copied into item_links", JSON.stringify(kids.links).includes("alpha.example.com"), JSON.stringify(kids.links));
  check("[2] photos copied into item_photos", JSON.stringify(kids.photos).includes("alpha-1.jpg"), JSON.stringify(kids.photos));
  check("[2] contacts copied into item_contacts", JSON.stringify(kids.contacts).includes("(707) 555-0161"), JSON.stringify(kids.contacts));
  check("[2] exactly one of each, not duplicated",
    kids.details.length === 1 && kids.links.length === 1 && kids.photos.length === 1 && kids.contacts.length === 1,
    `${kids.details.length}/${kids.links.length}/${kids.photos.length}/${kids.contacts.length}`);
  check("[2] lineage recorded", String(a.library_item_id) === String(alpha.id), String(a.library_item_id));
  check("[2] revision recorded", a.library_item_revision === alpha.revision, `${a.library_item_revision}`);
  // The whole reason p_highlight is '' — Library material is reused across clients.
  check("[2] the copy carries NO highlight", !String(a.highlight ?? "").trim(), JSON.stringify(a.highlight));

  // ---- 3. ADD LIBRARY ITEMS TO AN EXISTING FLOWGUIDE ----------------------
  const added = await api(`/api/packets/${packetId}/items/from-library`, { method: "POST",
    body: JSON.stringify({ libraryItemIds: ids }) });
  const abody = await added.json();
  check("[3] adding to an existing FlowGuide SUCCEEDS", added.status === 200 && abody?.ok === true,
    `${added.status} ${JSON.stringify(abody).slice(0, 240)}`);
  check("[3] no database text reached the client",
    !/update_item_content|jsonb|does not exist/.test(JSON.stringify(abody)), JSON.stringify(abody).slice(0, 200));
  items = await itemsOf(packetId);
  check("[3] the FlowGuide now holds four items", items.length === 4, String(items.length));
  const addedKids = await childrenOf(String(items[2].id));
  check("[3] the added copy has its child rows too",
    addedKids.details.length === 1 && addedKids.contacts.length === 1 && addedKids.photos.length === 1,
    `${addedKids.details.length}/${addedKids.contacts.length}/${addedKids.photos.length}`);
  check("[3] and the added copies carry no highlight either",
    items.every((i) => !String(i.highlight ?? "").trim()), JSON.stringify(items.map((i) => i.highlight)));

  // ---- 4. THE COPIES ARE INDEPENDENT OF THE LIBRARY -----------------------
  await svc.from("library_items").update({
    title: "Alpha Manor RENAMED IN LIBRARY",
    description: "Rewritten in the Library after the copy was taken.",
  }).eq("id", alpha.id);
  const afterLibEdit = (await itemsOf(packetId))[0];
  check("[4] editing the Library does NOT change the copy",
    String(afterLibEdit.title).startsWith("Alpha Manor") && !String(afterLibEdit.title).includes("RENAMED"),
    String(afterLibEdit.title));
  check("[4] nor its description",
    String(afterLibEdit.description).includes("walled kitchen garden"), String(afterLibEdit.description).slice(0, 60));

  await svc.from("items").update({ title: "Alpha Manor EDITED IN FLOWGUIDE" }).eq("id", afterLibEdit.id);
  const { data: libAfter } = await svc.from("library_items").select("title").eq("id", alpha.id).single();
  check("[4] editing the copy does NOT change the Library",
    !String((libAfter as { title: string }).title).includes("EDITED IN FLOWGUIDE"),
    String((libAfter as { title: string }).title));
  check("[4] the Library row still holds its own later edit",
    String((libAfter as { title: string }).title).includes("RENAMED IN LIBRARY"), "");

  // ---- 5. AN UNAVAILABLE ENTRY STAYS ACTIONABLE, NOT RAW ------------------
  const foreign = await api("/api/packets/from-library", { method: "POST",
    body: JSON.stringify({ libraryItemIds: [crypto.randomUUID()] }) });
  const fbody = await foreign.json();
  check("[5] a missing entry answers 409", foreign.status === 409, `${foreign.status} ${JSON.stringify(fbody).slice(0, 160)}`);
  check("[5] with wording the professional can act on",
    /no longer available/i.test(String(fbody?.message ?? "")), String(fbody?.message));
  check("[5] and nothing was created for it",
    !fbody?.packetId, JSON.stringify(fbody).slice(0, 120));
  check("[5] all-or-nothing held", (await itemsOf(packetId)).length === 4, "");
} finally {
  const { data: packets } = await svc.from("packets").select("id").eq("user_id", UID);
  for (const p of ((packets ?? []) as { id: string }[])) await svc.from("packets").delete().eq("id", p.id);
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count: items } = await svc.from("library_items").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: pk } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  const { count: users } = await svc.from("users").select("id", { count: "exact", head: true }).eq("id", UID);
  console.log(`\ncleanup: library=${items ?? 0} packets=${pk ?? 0} users=${users ?? 0} — ${!items && !pk && !users ? "clean" : "NOT CLEAN"}`);
}
process.exit(summary("LIBRARY COPY — create from Library, add to existing, independence") > 0 ? 1 : 0);
