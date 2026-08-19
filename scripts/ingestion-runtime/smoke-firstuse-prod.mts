// Post-deploy smoke for the Library first-use fix and the owner return path,
// against PRODUCTION, on disposable data only.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://flowguide-ruddy.vercel.app \
//     npx tsx scripts/ingestion-runtime/smoke-firstuse-prod.mts
//
// NO LIVE FLOWGUIDE IS READ OR WRITTEN. Every user, packet and Library entry
// here is created by this script and removed in a finally block that verifies
// the removal by id.
//
// Bounded to what this release ships. It does not re-prove Library v1 internals
// or 0016/0017 — those have their own proofs.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE || BASE.includes("localhost")) {
  console.error("FLOWGUIDE_BASE_URL must be the production origin");
  process.exit(2);
}
const TAG = "flowguide-firstuse-" + process.pid;
console.log(`\nFirst-use + owner-bar production smoke — ${BASE}\n`);

async function makeUser(n: string) {
  const { data: u, error } = await svc.from("users")
    .insert({ email: `${TAG}-${n}@disposable.invalid` }).select("id").single();
  if (error) throw new Error(`user ${n}: ${errText(error)}`);
  const id = (u as { id: string }).id;
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({
    user_id: id, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
  });
  return { id, cookie: `flowguide_session=${token}` };
}

const owner = await makeUser("owner");
const other = await makeUser("other");
const users = [owner.id, other.id];
const packets: string[] = [];
const libIds: string[] = [];

async function api(path: string, init: RequestInit = {}, cookie: string | null = owner.cookie) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

try {
  // ---- WAIT FOR THE DEPLOY -------------------------------------------------
  // The direct-write path is new in this release, so it doubles as the signal
  // that the running build is the one under test. Without this the smoke can
  // pass against the OLD build and report success for code that never shipped.
  let live = false;
  for (let i = 0; i < 40 && !live; i++) {
    const probe = await api("/api/library", { method: "POST", body: JSON.stringify({ item: { title: "" } }) });
    // New build rejects the EMPTY TITLE; old build rejects the missing itemId.
    live = probe.status === 400 && /title/i.test(String(probe.data?.message ?? ""));
    if (!live) await new Promise((r) => setTimeout(r, 15_000));
  }
  check("the build under test is live in production", live,
    "the direct-write path never appeared — deploy did not land");
  if (!live) throw new Error("aborting: smoking the previous build would be meaningless");

  // ---- SAVING FROM A DRAFT, WITHOUT PUBLISHING ----------------------------
  const { data: p } = await svc.from("packets").insert({
    user_id: owner.id, slug: `${TAG}-draft`, title: "Smoke — draft",
    status: "draft", composition_mode: "legacy", raw_input: "",
  }).select("id").single();
  const draftId = (p as { id: string }).id;
  packets.push(draftId);
  const { data: s } = await svc.from("sections")
    .insert({ packet_id: draftId, title: "Communities", sort_order: 0 }).select("id").single();
  const { data: it } = await svc.from("items").insert({
    section_id: (s as { id: string }).id, title: "Brookdale Chanate",
    address: "3800 Chanate Rd", description: "Assisted living and memory care.", sort_order: 0,
  }).select("id").single();
  const itemId = (it as { id: string }).id;

  const cands = await api(`/api/packets/${draftId}/library-candidates`);
  check("a DRAFT FlowGuide offers its items for saving",
    cands.status === 200 && (cands.data.items ?? []).length === 1,
    `status ${cands.status} items ${(cands.data.items ?? []).length}`);

  const saved = await api("/api/library", { method: "POST", body: JSON.stringify({ itemId }) });
  check("an item saves to the Library from a draft, with no publish involved",
    saved.status === 200, JSON.stringify(saved.data).slice(0, 160));
  if (saved.data?.item?.id) libIds.push(saved.data.item.id);

  const { data: stillDraft } = await svc.from("packets").select("status").eq("id", draftId).single();
  check("and the FlowGuide is still a draft afterwards",
    (stillDraft as { status: string }).status === "draft");

  // ---- WRITING AN ENTRY WITH NO FLOWGUIDE AT ALL --------------------------
  const direct = await api("/api/library", {
    method: "POST",
    body: JSON.stringify({ item: { title: "VA Aid & Attendance", description: "Benefit overview.",
      details: [{ label: "Max benefit", value: "$2,300/mo" }] } }),
  });
  check("an entry can be written straight into the Library",
    direct.status === 200, JSON.stringify(direct.data).slice(0, 160));
  const directId = direct.data?.item?.id as string;
  if (directId) libIds.push(directId);

  const { data: drow } = directId
    ? await svc.from("library_items").select("source_packet_item_id, details").eq("id", directId).single()
    : { data: null };
  check("a written entry records NO lineage",
    !!drow && (drow as Record<string, unknown>).source_packet_item_id === null,
    JSON.stringify(drow));
  check("and its details survived the same normaliser",
    !!drow && JSON.stringify((drow as Record<string, unknown>).details).includes("Max benefit"));

  const untitled = await api("/api/library", { method: "POST", body: JSON.stringify({ item: { description: "no title" } }) });
  check("an untitled entry is refused, not saved unfindable",
    untitled.status === 400, `status ${untitled.status}`);

  const neither = await api("/api/library", { method: "POST", body: JSON.stringify({}) });
  check("neither door still means a bad request", neither.status === 400, `status ${neither.status}`);

  const signedOut = await api("/api/library", { method: "POST", body: JSON.stringify({ item: { title: "x" } }) }, null);
  check("the direct-write path is owner-scoped, not open", signedOut.status === 401, `status ${signedOut.status}`);

  // ---- THE OWNER RETURN PATH ON A PUBLISHED FLOWGUIDE ---------------------
  const slug = `${TAG}-pub`;
  const { data: pub } = await svc.from("packets").insert({
    user_id: owner.id, slug, title: "Smoke — published", status: "published",
    composition_mode: "legacy", raw_input: "", viewed: false,
  }).select("id").single();
  const pubId = (pub as { id: string }).id;
  packets.push(pubId);
  const { data: s2 } = await svc.from("sections")
    .insert({ packet_id: pubId, title: "Communities", sort_order: 0 }).select("id").single();
  await svc.from("items").insert({
    section_id: (s2 as { id: string }).id, title: "Oakmont of Villa Capri", sort_order: 0,
  });

  const MARK = "This is your own FlowGuide";
  const page = async (cookie: string | null) =>
    await (await fetch(`${BASE}/p/${slug}`, { headers: cookie ? { Cookie: cookie } : {} })).text();

  const asOwner = await page(owner.cookie);
  const asOther = await page(other.cookie);
  const asRecipient = await page(null);

  check("the owner sees a way back to their workspace", asOwner.includes(MARK));
  check("a recipient sees NOTHING of it", !asRecipient.includes(MARK));
  check("a DIFFERENT signed-in professional is a recipient like any other", !asOther.includes(MARK));
  check("the owner bar offers no control that can act",
    !/\/api\//.test(asOwner.slice(asOwner.indexOf(MARK) - 400, asOwner.indexOf(MARK) + 600)));
  for (const [who, html] of [["recipient", asRecipient], ["owner", asOwner], ["other", asOther]] as const) {
    check(`the packet itself renders identically for the ${who}`,
      html.includes("Oakmont of Villa Capri"), "packet body missing");
  }

  // ---- `viewed` means the CLIENT opened it --------------------------------
  await svc.from("packets").update({ viewed: false }).eq("id", pubId);
  await page(owner.cookie);
  await new Promise((r) => setTimeout(r, 1500));
  const { data: v1 } = await svc.from("packets").select("viewed").eq("id", pubId).single();
  check("the owner opening their own link does NOT mark it seen by the client",
    (v1 as { viewed: boolean }).viewed === false);

  await page(null);
  await new Promise((r) => setTimeout(r, 1500));
  const { data: v2 } = await svc.from("packets").select("viewed").eq("id", pubId).single();
  check("a real recipient opening it still does", (v2 as { viewed: boolean }).viewed === true);

  // ---- nothing else regressed --------------------------------------------
  const list = await api("/api/library");
  check("the Library lists both entries for its owner",
    list.status === 200 && (list.data.items ?? []).length === 2,
    `status ${list.status} items ${(list.data.items ?? []).length}`);
  const otherList = await api("/api/library", {}, other.cookie);
  check("and shows another professional none of them",
    otherList.status === 200 && (otherList.data.items ?? []).length === 0,
    `items ${(otherList.data.items ?? []).length}`);

  summary("First-use + owner-bar production smoke");
} catch (e) {
  console.error("\nHALTED:", errText(e) || (e as Error)?.message || e);
  process.exitCode = 1;
} finally {
  for (const id of packets) await svc.from("packets").delete().eq("id", id);
  for (const id of libIds) await svc.from("library_items").delete().eq("id", id);
  for (const id of users) {
    await svc.from("sessions").delete().eq("user_id", id);
    await svc.from("users").delete().eq("id", id);
  }
  const { data: lp } = packets.length ? await svc.from("packets").select("id").in("id", packets) : { data: [] };
  const { data: ll } = libIds.length ? await svc.from("library_items").select("id").in("id", libIds) : { data: [] };
  const { data: lu } = await svc.from("users").select("id").like("email", `${TAG}%`);
  const stray = (lp ?? []).length + (ll ?? []).length + (lu ?? []).length;
  console.log(`\ncleanup: ${(lp ?? []).length} packets, ${(ll ?? []).length} library items, ` +
    `${(lu ?? []).length} users remaining — ${stray === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
}
