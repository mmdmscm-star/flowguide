// PRIVACY CHECK — does a Library "Private note / Only you see this" reach the
// recipient's FlowGuide?
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://… \
//     npx tsx scripts/ingestion-runtime/proof-private-note.mts
//
// Driven through the LIVE PRODUCT PATH, not by reading code: a real item, saved
// to the Library through /api/library, inserted into a second FlowGuide through
// Add from Library, published through /api/packets/:id/publish, then the
// published page fetched exactly as a recipient fetches it — no cookie at all,
// and again as a DIFFERENT signed-in professional.
//
// EVERY row belongs to disposable users created here. It never reads, writes or
// deletes any existing Library entry.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL ?? "http://localhost:3000";
if (!process.env.FLOWGUIDE_RT_CONFIRM) { console.error("FLOWGUIDE_RT_CONFIRM=1 required"); process.exit(1); }
const TAG = "flowguide-privcheck-" + process.pid;

// Unmistakable, and shaped like something a professional would genuinely never
// want a client to read.
const SECRET = `PRIVATENOTE${process.pid}: the family cannot afford this community and the director knows it`;

console.log(`\nPrivate-note privacy check — ${BASE}\n`);
const users: string[] = [];
const packets: string[] = [];
let BLOCK_PACKET: { id: string; slug: string; sectionId: string; itemId: string } | null = null;

async function makeUser(label: string) {
  const { data, error } = await svc.from("users")
    .insert({ email: `${TAG}-${label}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(`user ${label}: ${errText(error)}`);
  const id = (data as { id: string }).id;
  users.push(id);
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { id, cookie: `flowguide_session=${token}` };
}
async function api(path: string, cookie: string | null, init: RequestInit = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
}
async function page(slug: string, cookie: string | null) {
  const r = await fetch(`${BASE}/p/${slug}`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(60_000) });
  return { status: r.status, html: await r.text() };
}
async function makePacket(owner: string, title: string) {
  const { data: p, error } = await svc.from("packets")
    .insert({ user_id: owner, title, slug: `${TAG}-${title}-${crypto.randomUUID().slice(0, 8)}` })
    .select("id, slug").single();
  if (error) throw new Error(`packet: ${errText(error)}`);
  const pk = p as { id: string; slug: string };
  packets.push(pk.id);
  const { data: s } = await svc.from("sections")
    .insert({ packet_id: pk.id, title: "Communities", sort_order: 0 }).select("id").single();
  return { ...pk, sectionId: (s as { id: string }).id };
}

try {
  const pro = await makeUser("pro");
  const other = await makeUser("other");

  // ---- 1. an item carrying the private note, saved to the Library ----------
  const src = await makePacket(pro.id, "source");
  const { data: it, error: itErr } = await svc.from("items").insert({
    section_id: src.sectionId, title: "Fairview Gardens", address: "1200 Example Rd",
    description: "Assisted living and memory care.", notes: SECRET, sort_order: 0,
  }).select("id").single();
  if (itErr) throw new Error(`item: ${errText(itErr)}`);
  const ITEM = (it as { id: string }).id;

  const saved = await api("/api/library", pro.cookie, { method: "POST", body: JSON.stringify({ itemId: ITEM }) });
  check("the item saves to the Library through the real route", saved.ok || saved.status === 201,
    `status ${saved.status} ${JSON.stringify(saved.data).slice(0, 140)}`);
  // The route returns { item: created } — read from the route, not assumed.
  const LIB = (saved.data as { item?: { id?: string } }).item?.id as string;
  if (!LIB) throw new Error(`no library id in save response: ${JSON.stringify(saved.data).slice(0, 200)}`);

  const { data: lib, error: libErr } = await svc.from("library_items").select("notes").eq("id", LIB).maybeSingle();
  if (libErr) throw new Error(`library read: ${errText(libErr)}`);
  if (!lib) throw new Error(`library entry ${LIB} not found`);
  check("the Library entry holds it in `notes` — the field the UI labels 'Private note / Only you see this'",
    String((lib as { notes: string | null }).notes ?? "").includes(SECRET), "the note did not travel into the Library entry");

  // ---- 2. BOTH recipient paths: legacy sections AND blocks ----------------
  //        The two render through different assemblers, so proving one proves
  //        nothing about the other.
  async function publishWithNote(label: string, mode: "legacy" | "blocks") {
    const target = await makePacket(pro.id, label);
    const ins = await api(`/api/packets/${target.id}/items/from-library`, pro.cookie, {
      method: "POST", body: JSON.stringify({ libraryItemIds: [LIB], sectionId: target.sectionId }),
    });
    check(`[${mode}] Add from Library inserts the entry`, ins.status === 200,
      `status ${ins.status} ${JSON.stringify(ins.data).slice(0, 140)}`);
    const itemId = ins.data?.itemIds?.[0] as string;
    if (!itemId) throw new Error(`[${mode}] no inserted item`);
    const { data: copied } = await svc.from("items").select("notes").eq("id", itemId).maybeSingle();
    check(`[${mode}] the private note really is stored on the FlowGuide item`,
      String((copied as { notes: string | null } | null)?.notes ?? "").includes(SECRET),
      "the note did not travel — the test below would pass for the wrong reason");
    await svc.from("item_details").insert([
      { item_id: itemId, label: "AL Studio", value: "$4,500/mo", sort_order: 0 },
    ]);
    if (mode === "blocks") {
      const { error } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: target.id });
      if (error) throw new Error(`[${mode}] convert: ${error.message}`);
    }
    const pub = await api(`/api/packets/${target.id}/publish`, pro.cookie, {
      method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
    });
    check(`[${mode}] the FlowGuide publishes`, pub.status === 200,
      `status ${pub.status} ${JSON.stringify(pub.data).slice(0, 140)}`);
    return { ...target, itemId };
  }

  for (const mode of ["legacy", "blocks"] as const) {
    const t = await publishWithNote(`t-${mode}`, mode);
    const anon = await page(t.slug, null);
    const asOther = await page(t.slug, other.cookie);

    check(`[${mode}] the published page loads signed out`, anon.status === 200, `status ${anon.status}`);
    // PRECONDITION. Without this, "the note is absent" would also be true of a
    // blank page, an error page, or a page that rendered no item at all.
    check(`[${mode}] the item still renders normally for the recipient`,
      anon.html.includes("Fairview Gardens") && anon.html.includes("1200 Example Rd") &&
      anon.html.includes("AL Studio") && anon.html.includes("$4,500/mo"),
      "title, address or details missing — the privacy result would be meaningless");

    // THE WHOLE HTML, not the rendered markup. ItemCard is a client component,
    // so anything handed to it is serialized into the RSC payload in this same
    // document. Substring-searching the entire response is what makes the
    // view-source case impossible to miss.
    check(`[${mode}] PRIVATE NOTE ABSENT from the signed-out page, RSC payload included`,
      !anon.html.includes(SECRET),
      "EXPOSED — the sentinel is somewhere in the recipient's HTML");
    check(`[${mode}] PRIVATE NOTE ABSENT for a different signed-in professional`,
      !asOther.html.includes(SECRET), "EXPOSED");

    // A fragment check too: a future change that truncates or reformats the note
    // must not sneak part of it through.
    check(`[${mode}] no fragment of the note leaks either`,
      !anon.html.includes("cannot afford this community"), "a fragment of the private note is present");

    if (mode === "blocks") BLOCK_PACKET = t;
  }

  // ---- 3. the professional still sees and can edit it ---------------------
  const edit = await fetch(`${BASE}/edit/${BLOCK_PACKET!.id}`, {
    headers: { Cookie: pro.cookie }, signal: AbortSignal.timeout(60_000),
  });
  const editHtml = await edit.text();
  check("the professional STILL SEES the private note in their editor",
    edit.status === 200 && editHtml.includes(SECRET),
    `status ${edit.status} — the note is not in the editor`);

  // A DRAFT packet in BLOCKS mode. Item-content editing requires both — a
  // published packet is frozen, and the content route is blocks-only. Neither
  // rule is something this fix changed; two earlier versions of this check
  // tripped on them and proved nothing about private notes.
  const ed = await makePacket(pro.id, "editable");
  const edIns = await api(`/api/packets/${ed.id}/items/from-library`, pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB], sectionId: ed.sectionId }),
  });
  const edItem = edIns.data?.itemIds?.[0] as string;
  const { error: convErr } = await svc.rpc("convert_packet_to_blocks", { p_packet_id: ed.id });
  if (convErr) throw new Error(`convert(editable): ${convErr.message}`);

  const NEWNOTE = SECRET + " [edited]";
  const patched = await api(`/api/packets/${ed.id}/items/${edItem}`, pro.cookie, {
    method: "PATCH", body: JSON.stringify({ notes: NEWNOTE }),
  });
  const { data: after } = await svc.from("items").select("notes").eq("id", edItem).maybeSingle();
  check("the professional can still EDIT the private note",
    patched.ok && String((after as { notes: string | null } | null)?.notes ?? "").includes("[edited]"),
    `status ${patched.status} ${JSON.stringify(patched.data).slice(0, 120)}`);

  // ...and the edit does not become visible to the recipient either.
  const anonAfter = await page(BLOCK_PACKET!.slug, null);
  check("an edited private note is still absent from the recipient page",
    !anonAfter.html.includes(SECRET), "EXPOSED after edit");

  summary("Private-note privacy check");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of users) {
    await svc.from("library_items").delete().eq("user_id", id);
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  let stray = 0;
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  stray += (lu ?? []).length;
  for (const id of users)
    for (const t of ["library_items", "packets", "sessions"] as const) {
      const { data } = await svc.from(t).select("user_id").eq("user_id", id);
      stray += (data ?? []).length;
    }
  console.log(`cleanup: ${stray} row(s) remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
