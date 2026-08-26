// THE ACTUAL USER PATH, end to end.
//   editor save (real PATCH /api/items -> update_item_content RPC)
//     -> Preview HTML  -> live recipient HTML -> print HTML -> email HTML
//
// Unit tests prove the pieces. This proves the chain, on the surfaces the
// professional and the client actually open.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";

const PRIVATE  = "PRIVATE-only-the-advisor-sees-this";
const HIGHLIGHT = "They heat their pool to 82 degrees, because you asked.\n\nAnd they hold the room until Friday.";
const DESC = "Paragraph one, with several sentences. It continues here.\n\nParagraph two starts fresh.\n\nParagraph three as well.";
const SECDESC = "Section para one.\n\nSection para two.\n\nSection para three.";

const TAG = "flowguide-rt-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now()+864e5).toISOString() });
await svc.from("professional_profiles").insert({ user_id: UID, name: "Ramona Maurer", phone: "(707) 391-0111" });
const COOKIE = `flowguide_session=${token}`;
const api = async (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers||{}) } });
// A CLIENT HAS NO SESSION. Fetching a recipient surface with the owner's cookie
// renders the owner bar over it — which is amber, and made an "is there an
// empty callout box?" check pass on the wrong element. It also weakens the
// privacy assertions, since the owner-authenticated page is not the page the
// client gets. Recipient surfaces are fetched anonymously, as a client does.
const anonGet = (p: string) => fetch(`${BASE}${p}`);

try {
  const { data: pk } = await svc.from("packets").insert({
    user_id: UID, slug: TAG, title: "Pool Options", client_name: "the Chen family",
    status: "draft", composition_mode: "legacy" }).select("id").single();
  const PID = (pk as { id: string }).id;
  const { data: sec } = await svc.from("sections").insert({
    packet_id: PID, title: "Shortlist", description: SECDESC, sort_order: 0 }).select("id").single();
  const SID = (sec as { id: string }).id;
  const { data: it } = await svc.from("items").insert({
    section_id: SID, title: "Cedar Ridge", sort_order: 0 }).select("id").single();
  const IID = (it as { id: string }).id;

  // ---- 1. THE EDITOR SAVE, through the real route and the new RPC ----------
  const save = await api("/api/items", { method: "PATCH", body: JSON.stringify({
    id: IID, description: DESC, notes: PRIVATE, highlight: HIGHLIGHT }) });
  check("the editor save succeeds (PATCH /api/items)", save.ok, `${save.status} ${await save.text().catch(()=> "")}`.slice(0,120));

  // ---- 2. IT LANDED IN THE DATABASE ---------------------------------------
  const { data: row } = await svc.from("items").select("description, notes, highlight").eq("id", IID).single();
  const r = row as { description: string; notes: string; highlight: string };
  check("highlight persisted", r.highlight === HIGHLIGHT, JSON.stringify(r.highlight)?.slice(0,80));
  check("private note persisted", r.notes === PRIVATE, "");
  check("the description kept its newlines in the DB",
    (r.description.match(/\n/g) ?? []).length === 4, `${(r.description.match(/\n/g) ?? []).length} newlines`);

  await api(`/api/packets/${PID}/publish`, { method: "POST", body: JSON.stringify({ action: "publish" }) });
  const { data: pub } = await svc.from("packets").select("slug").eq("id", PID).single();
  const SLUG = (pub as { slug: string }).slug;

  // ---- 3. EVERY SURFACE ----------------------------------------------------
  const surfaces: [string, string, boolean][] = [
    ["Preview  (professional)", `/preview/${PID}`, true],
    ["Live     (recipient)",    `/p/${SLUG}`,      false],
    ["Print    (recipient)",    `/p/${SLUG}/print`, false],
  ];
  for (const [label, path, expectPrivate] of surfaces) {
    const res = expectPrivate ? await api(path) : await anonGet(path);
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ");
    check(`${label} responds 200`, res.status === 200, String(res.status));
    check(`${label} shows the client highlight`, html.includes("heat their pool to 82"), "");
    check(`${label} keeps the highlight's own paragraph break`, html.includes("hold the room until Friday"), "");
    check(`${label} keeps all THREE description paragraphs`,
      text.includes("Paragraph two starts fresh.") && text.includes("Paragraph three as well."), "");
    check(`${label} keeps all three SECTION paragraphs`,
      text.includes("Section para two.") && text.includes("Section para three."), "");
    if (expectPrivate) {
      check(`${label} SHOWS the private note to its owner`, html.includes(PRIVATE), "");
      check(`${label} labels it as private`, /only you see this/i.test(text), "");
    } else {
      // The whole point. Not in the markup, and not in the RSC payload either.
      check(`${label} NEVER shows the private note`, !html.includes(PRIVATE), "PRIVATE NOTE LEAKED");
    }
  }

  // ---- 4. EMAIL ------------------------------------------------------------
  const em = await api(`/api/packets/${PID}/email`);
  const eb = await em.text();
  check("Email responds 200", em.ok, String(em.status));
  check("Email shows the client highlight", eb.includes("heat their pool to 82"), "");
  check("Email NEVER shows the private note", !eb.includes(PRIVATE), "PRIVATE NOTE LEAKED INTO EMAIL");
  check("Email keeps description paragraphs", eb.includes("Paragraph two starts fresh."), "");
  check("Email keeps SECTION description paragraphs", eb.includes("Section para two."), "");
  check("Email breaks paragraphs with <br />", (eb.match(/<br \/>/g) ?? []).length >= 6,
    `${(eb.match(/<br \/>/g) ?? []).length} breaks`);

  // ---- 5. EMPTY HIGHLIGHT, NO EMPTY BOX ------------------------------------
  // An earlier version of this tried to CLEAR the highlight with a PATCH after
  // publishing. update_item_content refuses to edit a published packet, so the
  // clear failed, the box was still there, and the check reported a bug that
  // did not exist. The real case is simpler and is the one a professional hits:
  // a second item that never had a highlight at all.
  const { data: it2 } = await svc.from("items").insert({
    section_id: SID, title: "Harbor Light", description: "No highlight on this one.", sort_order: 1 })
    .select("id").single();
  check("the second item was created", !!it2, "");
  const two = await (await anonGet(`/p/${SLUG}`)).text();
  check("the item WITHOUT a highlight renders no callout box",
    (two.match(/border-amber-200 bg-amber-50 px-3\.5 py-3/g) ?? []).length === 1,
    `${(two.match(/border-amber-200 bg-amber-50 px-3\.5 py-3/g) ?? []).length} callout boxes for 2 items, 1 highlight`);
  check("...and the item that HAS one still shows it", two.includes("heat their pool to 82"), "");
  check("the second item itself rendered", two.includes("Harbor Light"), "");

  // ---- 6. THE LIBRARY MUST NOT CARRY IT ------------------------------------
  await api("/api/items", { method: "PATCH", body: JSON.stringify({ id: IID, highlight: HIGHLIGHT }) });
  const lib = await api("/api/library", { method: "POST", body: JSON.stringify({ itemId: IID }) });
  if (lib.ok) {
    const { data: rows } = await svc.from("library_items").select("*").eq("user_id", UID);
    const blob = JSON.stringify(rows ?? []);
    check("saving to the Library does NOT carry the highlight", !blob.includes("heat their pool to 82"),
      "THE CLIENT-SPECIFIC HIGHLIGHT FOLLOWED THE ITEM INTO THE LIBRARY");
    check("the Library still carries the private note (unchanged behaviour)", blob.includes(PRIVATE), "");
  } else {
    console.log(`    (library save returned ${lib.status}; skipped)`);
  }
} finally {
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("professional_profiles").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id",{count:"exact",head:true}).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
process.exit(summary("HIGHLIGHT + PARAGRAPHS — the real user path") > 0 ? 1 : 0);
