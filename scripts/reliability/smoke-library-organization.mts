// EXECUTING REGRESSION for Library organization — Phase 2.
//
// Runs entirely on a DISPOSABLE user. The real Library is read once, to confirm
// this test did not touch it, and never written.
//
// What is actually at risk here is not whether a star toggles. It is that
// organizing looks like editing to the rest of the system: `revision` is the
// save-back comparator, so a bulk categorise that bumped it would report every
// descendant FlowGuide as diverged, and `updated_at` is the list's ordering, so
// tidying a shelf would reshuffle it. Both are asserted after every write.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const TAG = "flowguide-org-" + process.pid;
const { data: u, error: ue } = await svc.from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (ue) { console.error(errText(ue)); process.exit(1); }
const UID = (u as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({ user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
const api = (p: string, i: RequestInit = {}) => fetch(`${BASE}${p}`, { ...i,
  headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${token}`, ...(i.headers || {}) } });

const rowsOf = async () => ((await svc.from("library_items")
  .select("id,title,description,labels,is_favorite,revision,updated_at").eq("user_id", UID).order("title")).data ?? []) as
  Array<{ id: string; title: string; description: string; labels: string[]; is_favorite: boolean; revision: number; updated_at: string }>;
const byTitle = (rs: Awaited<ReturnType<typeof rowsOf>>) => Object.fromEntries(rs.map((r) => [r.title, r]));

try {
  const seed = ["Alpha", "Bravo", "Charlie", "Delta"].map((t, i) => ({
    user_id: UID, title: t, description: `${t} description`, labels: [] as string[],
    is_favorite: false, updated_at: new Date(Date.now() - i * 1000).toISOString(),
  }));
  const { error: ie } = await svc.from("library_items").insert(seed);
  if (ie) throw new Error(errText(ie));
  const before = byTitle(await rowsOf());
  const ids = Object.values(before).map((r) => r.id);

  const unchangedStamps = async (label: string) => {
    const now = byTitle(await rowsOf());
    const movedRev = Object.keys(before).filter((t) => now[t].revision !== before[t].revision);
    const movedAt = Object.keys(before).filter((t) => now[t].updated_at !== before[t].updated_at);
    check(`${label}: revision unmoved — no false save-back conflict`, movedRev.length === 0, JSON.stringify(movedRev));
    check(`${label}: updated_at unmoved — the list does not reshuffle`, movedAt.length === 0, JSON.stringify(movedAt));
    return now;
  };

  // ---- 1. FAVORITE STRAIGHT FROM THE ROW --------------------------------
  const star = await api(`/api/library/${before.Alpha.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { isFavorite: true } }) });
  check("[1] the row star saves", star.ok, `${star.status} ${(await star.text()).slice(0, 140)}`);
  let now = await unchangedStamps("[1] favorite");
  check("[1] Alpha is starred", now.Alpha.is_favorite === true, "");
  check("[1] and nothing else was touched",
    !now.Bravo.is_favorite && !now.Charlie.is_favorite, "");
  await api(`/api/library/${before.Alpha.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { isFavorite: false } }) });
  check("[1] unfavoriting works too", (await rowsOf()).find((r) => r.title === "Alpha")!.is_favorite === false, "");

  // ---- 1b. FAVORITES STANDS ALONE ---------------------------------------
  // A Library that has been starred but never filed still has something to
  // offer. The filter surface used to appear only once a label
  // existed, which made the star a dead end for anyone who had not filed.
  await api(`/api/library/${before.Alpha.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { isFavorite: true } }) });
  const starOnly = await (await api("/api/library?limit=50")).json();
  check("[1b] vocabulary is otherwise EMPTY — no categories, no labels",
    starOnly.vocabulary.categories.length === 0 && starOnly.vocabulary.labels.length === 0,
    JSON.stringify(starOnly.vocabulary));
  check("[1b] ...and it still reports hasFavorites", starOnly.vocabulary.hasFavorites === true,
    JSON.stringify(starOnly.vocabulary));
  const favOnly = await (await api("/api/library?favorite=1&limit=50")).json();
  check("[1b] the Favorites filter works with zero label vocabulary",
    (favOnly.items ?? []).length === 1 && favOnly.items[0].title === "Alpha",
    JSON.stringify((favOnly.items ?? []).map((i: { title: string }) => i.title)));
  await api(`/api/library/${before.Alpha.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { isFavorite: false } }) });
  const noneLeft = await (await api("/api/library?limit=50")).json();
  check("[1b] unstarring the last one reports hasFavorites false again",
    noneLeft.vocabulary.hasFavorites === false, JSON.stringify(noneLeft.vocabulary));
  await unchangedStamps("[1b] favorites-only");

  // ---- 2. PER-ITEM LABELS, NORMALISED -----------------------------------
  //
  // Where an item lives moved to Section -> Group with migration 0042, and is
  // exercised by smoke-library-structure.mts. What is still this smoke's
  // subject is the vocabulary that genuinely cuts across the structure.
  await fetch(`${BASE}/api/library/${ids.Alpha}`, { method: "PATCH", headers: H, body: JSON.stringify({
    organization: { labels: ["  Santa Rosa  ", "Memory   Care", "", "santa rosa"] } }) });
  let now = await unchangedStamps("[2] per-item labels");
  check("[2] labels are trimmed, folded inside, de-duplicated and blanks dropped",
    JSON.stringify(now.Alpha.labels) === JSON.stringify(["Santa Rosa", "Memory Care"]),
    JSON.stringify(now.Alpha.labels));

  await fetch(`${BASE}/api/library/${ids.Bravo}`, { method: "PATCH", headers: H,
    body: JSON.stringify({ organization: { labels: ["SANTA ROSA"] } }) });
  now = await unchangedStamps("[2] spelling reuse");
  check("[2] a differently-cased label adopts the existing spelling",
    JSON.stringify(now.Bravo.labels) === JSON.stringify(["Santa Rosa"]), JSON.stringify(now.Bravo.labels));

  // ---- 3. BULK: labels and the star -------------------------------------
  const bulk = (patch: Record<string, unknown>) =>
    api("/api/library/bulk", { method: "PATCH", body: JSON.stringify({ ids, ...patch }) });

  let res = await bulk({ setCategory: "services" });
  check("[3] bulk add label", res.ok, `${res.status} ${(await res.clone().text()).slice(0, 140)}`);
  now = await unchangedStamps("[3] bulk labels");
  check("[3] every selected item took it, with existing spelling reused where known",
    Object.values(now).every((r) => r.labels.includes("Moving")),
    JSON.stringify(Object.values(now).map((r) => r.labels)));

  res = await bulk({ clearCategory: true });
  check("[3] bulk remove label", res.ok, String(res.status));
  now = await unchangedStamps("[3] bulk clear");
  check("[3] the label is off every one of them", Object.values(now).every((r) => !r.labels.includes("Moving")), "");

  res = await bulk({ addLabels: ["Moving"] });
  check("[3] bulk add label", res.ok, String(res.status));
  now = await unchangedStamps("[3] bulk add label");
  check("[3] all four carry it", Object.values(now).every((r) => r.labels.includes("Moving")),
    JSON.stringify(Object.values(now).map((r) => r.labels)));
  check("[3] and it did not disturb labels already there",
    now.Alpha.labels.includes("Santa Rosa") && now.Alpha.labels.includes("Memory Care"), JSON.stringify(now.Alpha.labels));

  res = await bulk({ removeLabels: ["moving"] });      // wrong case on purpose
  check("[3] bulk remove label, case-insensitively", res.ok, String(res.status));
  now = await unchangedStamps("[3] bulk remove label");
  check("[3] it came off every item", Object.values(now).every((r) => !r.labels.includes("Moving")), "");
  check("[3] and the others survived", now.Alpha.labels.includes("Santa Rosa"), JSON.stringify(now.Alpha.labels));

  res = await bulk({ favorite: true });
  check("[3] bulk favorite", res.ok && Object.values(byTitle(await rowsOf())).every((r) => r.is_favorite), String(res.status));
  await unchangedStamps("[3] bulk favorite");
  res = await bulk({ favorite: false });
  check("[3] bulk unfavorite", res.ok && Object.values(byTitle(await rowsOf())).every((r) => !r.is_favorite), String(res.status));
  await unchangedStamps("[3] bulk unfavorite");

  // The bulk route may touch ONLY organization.
  const contentProbe = await bulk({ title: "HIJACKED", description: "HIJACKED" });
  const stillNamed = byTitle(await rowsOf());
  check("[3] the bulk route cannot write content",
    contentProbe.ok && stillNamed.Alpha.title === "Alpha" && stillNamed.Alpha.description === "Alpha description",
    JSON.stringify({ title: stillNamed.Alpha.title, description: stillNamed.Alpha.description }));

  // ...and it is owner-scoped.
  const { data: other } = await svc.from("users")
    .insert({ email: `${TAG}-other@disposable.invalid` }).select("id").single();
  const OTHER = (other as { id: string }).id;
  const { data: theirs } = await svc.from("library_items").insert({
    user_id: OTHER, title: "Not Mine", labels: [], is_favorite: false,
  }).select("id").single();
  const foreign = await api("/api/library/bulk", { method: "PATCH",
    body: JSON.stringify({ ids: [(theirs as { id: string }).id], setCategory: "Stolen" }) });
  const { data: check2 } = await svc.from("library_items").select("labels").eq("id", (theirs as { id: string }).id).single();
  check("[3] another professional's item is untouched",
    JSON.stringify((check2 as { labels: string[] }).labels) === "[]", `${foreign.status} ${JSON.stringify(check2)}`);
  await svc.from("users").delete().eq("id", OTHER);

  // ---- 4. FILTERS COMPOSE, AND PAGE ------------------------------------
  await bulk({ setCategory: "Communities" });
  await api(`/api/library/${before.Charlie.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { labels: ["Moving"], isFavorite: true } }) });
  await api(`/api/library/${before.Delta.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { labels: ["Moving"], isFavorite: true } }) });

  const titlesFor = async (query: string) => {
    const r = await api(`/api/library?${query}&limit=50`);
    const b = await r.json();
    return ((b.items ?? []) as Array<{ title: string }>).map((i) => i.title).sort();
  };
  check("[4] a label filters", JSON.stringify(await titlesFor("labels=Moving")) === JSON.stringify(["Charlie"]),
    JSON.stringify(await titlesFor("labels=Moving")));
  const withAll = await (await api("/api/library?limit=50")).json();
  check("[4] favorites composes once categories and labels exist too",
    withAll.vocabulary.hasFavorites === true && withAll.vocabulary.categories.length > 0,
    JSON.stringify(withAll.vocabulary));
  check("[4] favorites filter",
    JSON.stringify(await titlesFor("favorite=1")) === JSON.stringify(["Charlie", "Delta"]),
    JSON.stringify(await titlesFor("favorite=1")));
  check("[4] a single label",
    JSON.stringify(await titlesFor("labels=Moving")) === JSON.stringify(["Charlie", "Delta"]),
    JSON.stringify(await titlesFor("labels=Moving")));
  check("[4] TWO labels are AND, not OR",
    JSON.stringify(await titlesFor("labels=Santa%20Rosa,Memory%20Care")) === JSON.stringify(["Alpha"]),
    JSON.stringify(await titlesFor("labels=Santa%20Rosa,Memory%20Care")));
  check("[4] label + favorite compose",
    JSON.stringify(await titlesFor("labels=Moving&favorite=1")) === JSON.stringify(["Charlie"]),
    JSON.stringify(await titlesFor("labels=Moving&favorite=1")));
  check("[4] search composes with organization",
    JSON.stringify(await titlesFor("q=Charlie&labels=Moving")) === JSON.stringify(["Charlie"]),
    JSON.stringify(await titlesFor("q=Charlie&labels=Moving")));
  check("[4] a filter that matches nothing is empty, not an error",
    JSON.stringify(await titlesFor("labels=Nothing")) === JSON.stringify([]), "");

  // Filtered results still page, with the cursor contract intact.
  const page1 = await (await api("/api/library?labels=Moving&limit=1")).json();
  check("[4] a filtered list pages", page1.hasMore === true && !!page1.nextCursor, JSON.stringify(page1.hasMore));
  const page2 = await (await api(`/api/library?labels=Moving&limit=1` +
    `&cursorUpdatedAt=${encodeURIComponent(page1.nextCursor.updatedAt)}&cursorId=${page1.nextCursor.id}`)).json();
  const paged = [...page1.items, ...page2.items].map((i: { title: string }) => i.title).sort();
  check("[4] and paging a filtered list reaches everything exactly once",
    JSON.stringify(paged) === JSON.stringify(["Charlie", "Delta"]), JSON.stringify(paged));

  // ---- 5. ORGANIZATION NEVER TRAVELS ------------------------------------
  const created = await api("/api/packets/from-library", { method: "POST",
    body: JSON.stringify({ libraryItemIds: [before.Charlie.id], title: "Org Boundary", clientName: "Smoke" }) });
  const cbody = await created.json();
  check("[5] a FlowGuide is created from an organized item", created.status === 201, String(created.status));
  const { data: secs } = await svc.from("sections").select("id").eq("packet_id", cbody.packetId);
  const { data: its } = await svc.from("items").select("*")
    .in("section_id", ((secs ?? []) as { id: string }[]).map((x) => x.id));
  const copy = ((its ?? []) as Record<string, unknown>[])[0] ?? {};
  check("[5] the copied item has no organization columns",
    !("labels" in copy) && !("is_favorite" in copy) && !("section_id" in copy)
    && !("group_id" in copy) && !("sort_order" in copy), JSON.stringify(Object.keys(copy)));
  const { data: det } = await svc.from("item_details").select("label,value").eq("item_id", String(copy.id));
  const detailText = JSON.stringify(det ?? []);
  check("[5] and nothing became an item detail",
    !detailText.includes("Services") && !detailText.includes("Moving") && !detailText.includes("Favorite"), detailText);

  // Publish it and read the RECIPIENT page anonymously — the only view that
  // settles whether organization reached a client.
  const slug = `org-boundary-${process.pid}`;
  await svc.from("packets").update({ status: "published", slug }).eq("id", cbody.packetId);
  const page = await fetch(`${BASE}/p/${slug}`);
  const html = await page.text();
  check("[5] the recipient page loads", page.ok, String(page.status));
  for (const secret of ["Services", "Moving", "Santa Rosa", "Memory Care"]) {
    check(`[5] "${secret}" never reaches the recipient`, !html.includes(secret), "");
  }

  // ...and changing the Library afterwards does not touch that FlowGuide.
  await api(`/api/library/${before.Charlie.id}`, { method: "PATCH",
    body: JSON.stringify({ organization: { labels: ["Later"], isFavorite: false } }) });
  const html2 = await (await fetch(`${BASE}/p/${slug}`)).text();
  check("[5] reorganizing the Library changes nothing in an existing FlowGuide",
    !html2.includes("Reorganized") && !html2.includes("Later") && html2.includes("Charlie"), "");
} finally {
  const { data: pk } = await svc.from("packets").select("id").eq("user_id", UID);
  for (const p of ((pk ?? []) as { id: string }[])) await svc.from("packets").delete().eq("id", p.id);
  await svc.from("library_items").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  await svc.from("users").delete().like("email", `${TAG}%@disposable.invalid`);
  const { data: dis } = await svc.from("users").select("id").like("email", "%@disposable.invalid");
  // The real Library must be exactly as it was: untouched and unorganized.
  const { data: mine } = await svc.from("users").select("id").eq("email", "mmdmscm@gmail.com").single();
  const { data: real } = await svc.from("library_items")
    .select("labels,is_favorite").eq("user_id", (mine as { id: string }).id);
  const rows = (real ?? []) as Array<{ labels: string[]; is_favorite: boolean }>;
  console.log(`\ncleanup: disposable users=${(dis ?? []).length}` +
    ` | real library=${rows.length} rows,` +
    ` organized=${rows.filter((r) => r.labels.length || r.is_favorite).length}`);
}
process.exit(summary("LIBRARY ORGANIZATION — favorite, per-item, bulk, filters, boundary") > 0 ? 1 : 0);
