// RUNTIME PROOF — create a FlowGuide from saved Library material.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/ingestion-runtime/proof-create-from-library.mts
//
// Real routes, real database, disposable users only. No model calls.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
const TAG = "flowguide-cflproof-" + process.pid;
console.log(`\nCreate a FlowGuide from the Library — runtime proof — ${BASE}\n`);

const users: string[] = [];
const packets: string[] = [];

async function makeUser(label: string) {
  const { data, error } = await svc.from("users")
    .insert({ email: `${TAG}-${label}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(errText(error));
  const id = (data as { id: string }).id;
  users.push(id);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({
    user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { id, cookie: `flowguide_session=${token}` };
}
async function api(path: string, cookie: string | null, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
}

try {
  const pro = await makeUser("pro");

  // Four saved communities. The FIRST deliberately stores photos as bare
  // strings, the shape an AI import wrote before the normaliser existed.
  const names = ["Brookdale Chanate", "Oakmont of Villa Capri", "The Reserve at Fountaingrove", "Primrose"];
  const libIds: string[] = [];
  for (const [i, title] of names.entries()) {
    const { data } = await svc.from("library_items").insert({
      user_id: pro.id, title,
      address: `${i + 1}00 Example Rd, Santa Rosa CA`,
      description: "Assisted living and memory care.",
      notes: "Private note",
      details: [{ label: "AL Studio", value: `$${4 + i},500/mo` }],
      links: [{ url: `https://example.com/${i}`, label: "Website" }],
      photos: i === 0 ? ["https://example.com/legacy-shape.jpg"] : [{ url: `https://example.com/p${i}.jpg` }],
      contacts: [{ name: "Pat Rivera", role: "Director", phone: "707-555-0100", email: "pat@example.com", website: "" }],
    }).select("id").single();
    libIds.push((data as { id: string }).id);
  }
  check("four things are saved in the Library", libIds.length === 4);

  // ---- signed out -----------------------------------------------------------
  const anon = await api("/api/packets/from-library", null, {
    method: "POST", body: JSON.stringify({ libraryItemIds: libIds }) });
  check("the route is owner-scoped", anon.status === 401, `status ${anon.status}`);

  // ---- nothing chosen -------------------------------------------------------
  const before = (await svc.from("packets").select("id").eq("user_id", pro.id)).data?.length ?? 0;
  const none = await api("/api/packets/from-library", pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [] }) });
  check("choosing nothing is refused", none.status === 400, `status ${none.status}`);

  // ---- the real thing -------------------------------------------------------
  const made = await api("/api/packets/from-library", pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: libIds }) });
  check("four chosen entries create one FlowGuide",
    made.status === 201 && made.data.count === 4, JSON.stringify(made.data).slice(0, 200));
  const PID = made.data.packetId as string;
  if (PID) packets.push(PID);

  const { data: pk } = await svc.from("packets")
    .select("status, composition_mode, user_id").eq("id", PID).single();
  const p = pk as Record<string, unknown>;
  check("it is an unpublished legacy draft owned by the professional",
    p.status === "draft" && p.composition_mode === "legacy" && p.user_id === pro.id, JSON.stringify(p));

  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", PID);
  check("with exactly one section", (secs ?? []).length === 1, `${(secs ?? []).length} sections`);
  const secId = (secs ?? [])[0]?.id as string;

  const { data: items } = await svc.from("items")
    .select("id, title, address, description, notes, sort_order, library_item_id, library_item_revision, origin_run_id")
    .eq("section_id", secId).order("sort_order");
  const its = (items ?? []) as Record<string, unknown>[];
  check("all four communities are there, in the order chosen",
    JSON.stringify(its.map((i) => i.title)) === JSON.stringify(names),
    JSON.stringify(its.map((i) => i.title)));
  check("and their sort order is dense from 0",
    JSON.stringify(its.map((i) => Number(i.sort_order))) === JSON.stringify([0, 1, 2, 3]));

  check("each records the Library entry it came from, both columns",
    its.every((i) => i.library_item_id !== null && i.library_item_revision !== null),
    JSON.stringify(its.map((i) => [i.library_item_id, i.library_item_revision])));
  check("and none fabricates ingestion provenance",
    its.every((i) => i.origin_run_id === null));

  // ---- the content really travelled ----------------------------------------
  const first = its[0];
  const { data: det } = await svc.from("item_details").select("label, value").eq("item_id", first.id);
  const { data: lnk } = await svc.from("item_links").select("url").eq("item_id", first.id);
  const { data: pho } = await svc.from("item_photos").select("url").eq("item_id", first.id);
  const { data: con } = await svc.from("item_contacts").select("name").eq("item_id", first.id);
  check("details, links and contacts travelled with the copy",
    (det ?? []).length === 1 && (lnk ?? []).length === 1 && (con ?? []).length === 1,
    `details ${(det ?? []).length}, links ${(lnk ?? []).length}, contacts ${(con ?? []).length}`);
  check("a photo stored in the OLD bare-string shape still arrives as a real url",
    (pho ?? []).length === 1 && (pho ?? [])[0].url === "https://example.com/legacy-shape.jpg",
    JSON.stringify(pho));
  check("the description and private note came too",
    first.description === "Assisted living and memory care." && first.notes === "Private note");

  // ---- independence ---------------------------------------------------------
  await svc.from("items").update({ title: "Tailored for the Reyes family" }).eq("id", first.id);
  const { data: libAfter } = await svc.from("library_items").select("title, revision").eq("id", libIds[0]).single();
  check("tailoring the copy does not touch what is saved",
    (libAfter as Record<string, unknown>).title === "Brookdale Chanate" &&
    Number((libAfter as Record<string, unknown>).revision) === 1, JSON.stringify(libAfter));

  await svc.from("library_items").update({ title: "Renamed in the Library" }).eq("id", libIds[1]);
  const { data: itemAfter } = await svc.from("items").select("title").eq("id", its[1].id as string).single();
  check("and editing the Library does not reach into the FlowGuide",
    (itemAfter as { title: string }).title === "Oakmont of Villa Capri", JSON.stringify(itemAfter));

  // ---- no orphan on failure -------------------------------------------------
  const mine = async () => (await svc.from("packets").select("id").eq("user_id", pro.id)).data?.length ?? 0;
  // Scoped to THIS professional. The first version counted every section in the
  // database whose packet was not in the local array — which is every other
  // account's, and reported 132.
  const sectionsOfMine = async () => {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", pro.id);
    const ids = (ps ?? []).map((x: { id: string }) => x.id);
    if (ids.length === 0) return 0;
    const { data: ss } = await svc.from("sections").select("id").in("packet_id", ids);
    return (ss ?? []).length;
  };
  const beforeBogus = await mine();
  const bogus = await api("/api/packets/from-library", pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [crypto.randomUUID()] }) });
  check("a create naming an unknown entry is REFUSED, not partially fulfilled",
    bogus.status === 409 && bogus.data.error === "entries_unavailable",
    `status ${bogus.status} ${JSON.stringify(bogus.data).slice(0, 140)}`);
  check("and leaves NO orphan draft behind", (await mine()) === beforeBogus,
    `${beforeBogus} packets before`);

  // ---- STRUCTURAL EQUIVALENCE with the ordinary blank create -----------------
  const blank = await api("/api/packets", pro.cookie, {
    method: "POST", body: JSON.stringify({ title: "Reyes family" }) });
  const blankId = blank.data?.packet?.id as string;
  if (blankId) packets.push(blankId);
  const { data: blankRow } = await svc.from("packets").select("*").eq("id", blankId).single();
  const { data: madeRow } = await svc.from("packets").select("*").eq("id", PID).single();
  const br = blankRow as Record<string, unknown>, mr = madeRow as Record<string, unknown>;
  // Identity, the content passed in, and content_rev — which counts content
  // mutations, so two packets with different content necessarily differ. It is
  // asserted directly below instead.
  const EXCLUDE = new Set(["id", "slug", "created_at", "updated_at", "title", "client_name", "content_rev"]);
  const keys = [...new Set([...Object.keys(br), ...Object.keys(mr)])].filter((k) => !EXCLUDE.has(k));
  const differing = keys.filter((k) => JSON.stringify(br[k]) !== JSON.stringify(mr[k]));
  check("a FlowGuide made from the Library has the same structural defaults as a blank one",
    differing.length === 0 && keys.length >= 10,
    `${keys.length} columns compared; differing: ${JSON.stringify(differing.map((k) => [k, br[k], mr[k]]))}`);
  check("a blank FlowGuide starts at content_rev 0", Number(br.content_rev) === 0, `${br.content_rev}`);
  check("and one built from the Library has content_rev > 0 — the bump triggers fired",
    Number(mr.content_rev) > 0, `${mr.content_rev}`);

  // ---- DELIBERATE MID-OPERATION FAILURE --------------------------------------
  //
  // The third of four entries is given a contacts value that is an OBJECT rather
  // than an array. update_item_content iterates it, so the raise happens inside
  // the copy loop — after the packet, the section and two items already exist.
  // Compensating cleanup could not have guaranteed their removal; the
  // transaction does. No DDL and no fault-injection hook: this is a real data
  // condition reached through the real route.
  const { data: victim } = await svc.from("library_items")
    .insert({ user_id: pro.id, title: "Third of four", contacts: { not: "an array" } })
    .select("id").single();
  const victimId = (victim as { id: string }).id;

  const pBefore = await mine();
  const sBefore = await sectionsOfMine();
  const midFail = await api("/api/packets/from-library", pro.cookie, {
    method: "POST",
    body: JSON.stringify({ libraryItemIds: [libIds[0], libIds[1], victimId, libIds[2]] }) });
  const pAfter = await mine();

  check("a failure on the THIRD copy fails the whole request",
    !midFail.ok, `status ${midFail.status} ${JSON.stringify(midFail.data).slice(0, 140)}`);
  check("and leaves ZERO new packet behind", pAfter === pBefore, `${pBefore} -> ${pAfter}`);
  check("and no new section survives it either", (await sectionsOfMine()) === sBefore,
    `${sBefore} sections before`);
  await svc.from("library_items").delete().eq("id", victimId);

  // ---- someone else's Library entry is not reachable -------------------------
  const other = await makeUser("other");
  const { data: theirs } = await svc.from("library_items")
    .insert({ user_id: other.id, title: "Not yours" }).select("id").single();
  // Baseline taken immediately before the attempt. The earlier version reused a
  // count captured further up, which had legitimately grown by the blank
  // FlowGuide created for the equivalence comparison.
  const beforeCross = await mine();
  const cross = await api("/api/packets/from-library", pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [(theirs as { id: string }).id] }) });
  check("another professional's Library entry cannot be used",
    cross.status === 409 && cross.data.error === "entries_unavailable",
    `status ${cross.status} ${JSON.stringify(cross.data).slice(0, 120)}`);
  check("and that attempt leaves no draft either", (await mine()) === beforeCross,
    `${beforeCross} packets before`);

  check("the FlowGuide is still unpublished — nothing here publishes",
    ((await svc.from("packets").select("status").eq("id", PID).single()).data as { status: string }).status === "draft");

  summary("Create a FlowGuide from the Library");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of users) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("library_items").delete().eq("user_id", id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  let stray = 0;
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  stray += (lu ?? []).length;
  for (const id of users) {
    for (const t of ["packets", "library_items", "sessions"] as const) {
      const { data } = await svc.from(t).select("user_id").eq("user_id", id);
      stray += (data ?? []).length;
    }
  }
  console.log(`\ncleanup: ${stray} row(s) remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
