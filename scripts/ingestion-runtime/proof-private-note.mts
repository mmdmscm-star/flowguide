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

  // ---- 2. into a FlowGuide, via Add from Library ---------------------------
  const target = await makePacket(pro.id, "target");
  const ins = await api(`/api/packets/${target.id}/items/from-library`, pro.cookie, {
    method: "POST", body: JSON.stringify({ libraryItemIds: [LIB], sectionId: target.sectionId }),
  });
  check("Add from Library inserts it into a FlowGuide", ins.status === 200,
    `status ${ins.status} ${JSON.stringify(ins.data).slice(0, 140)}`);
  const NEW = ins.data?.itemIds?.[0] as string;
  if (!NEW) throw new Error(`no inserted item id: ${JSON.stringify(ins.data).slice(0, 200)}`);
  const { data: copied, error: cErr } = await svc.from("items").select("notes").eq("id", NEW).maybeSingle();
  if (cErr) throw new Error(`item read: ${errText(cErr)}`);
  check("the private note was COPIED into the FlowGuide item",
    String((copied as { notes: string | null } | null)?.notes ?? "").includes(SECRET),
    "the note did not travel — nothing further to test");

  // ---- 3. publish ---------------------------------------------------------
  const pub = await api(`/api/packets/${target.id}/publish`, pro.cookie, {
    method: "POST", body: JSON.stringify({ action: "publish", skipProfileCheck: true }),
  });
  check("the FlowGuide publishes", pub.status === 200, `status ${pub.status} ${JSON.stringify(pub.data).slice(0, 140)}`);

  // ---- 4. THE QUESTION ----------------------------------------------------
  const anon = await page(target.slug, null);
  const asOther = await page(target.slug, other.cookie);
  const asOwner = await page(target.slug, pro.cookie);

  check("the published page loads for a signed-out recipient", anon.status === 200, `status ${anon.status}`);
  // Guard: if the page did not render the item at all, the two checks below
  // would pass for the wrong reason.
  check("precondition: the recipient page really renders this item",
    anon.html.includes("Fairview Gardens"), "the item is absent — the privacy result below would be meaningless");

  const anonSees = anon.html.includes(SECRET);
  const otherSees = asOther.html.includes(SECRET);
  const ownerSees = asOwner.html.includes(SECRET);

  check("PRIVATE NOTE IS NOT VISIBLE TO A SIGNED-OUT RECIPIENT", !anonSees,
    anonSees ? "EXPOSED — the note is in the recipient's page" : "");
  check("PRIVATE NOTE IS NOT VISIBLE TO A DIFFERENT SIGNED-IN PROFESSIONAL", !otherSees,
    otherSees ? "EXPOSED" : "");
  console.log(`      owner sees it: ${ownerSees}   other professional: ${otherSees}   signed out: ${anonSees}`);

  if (anonSees) {
    const i = anon.html.indexOf(SECRET);
    console.log(`\n  VERBATIM, from the signed-out recipient's HTML:\n    …${anon.html.slice(Math.max(0, i - 120), i + SECRET.length + 60).replace(/\s+/g, " ")}…\n`);
  }

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
