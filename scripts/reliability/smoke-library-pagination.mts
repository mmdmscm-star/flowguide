// EXECUTING REGRESSION for Library paging and the organization filters.
//
// The defect this replaces was invisible by construction: searchLibrary capped
// at 50 rows and said nothing, so with 65 saved items fifteen were unreachable
// unless the professional already knew to search for them. Nothing errored and
// nothing looked wrong. So the test that matters is not "does a page load" but
// "walking the list the ordinary way, do I reach the sixty-fifth item".
//
// Two parts: the REAL 65-item Library, read-only, walked page by page; and a
// disposable user for the cases real data cannot provide on demand — tied
// updated_at values, and every filter combination.
import { svc, check, summary, errText } from "../ingestion-runtime/lib.mts";
const BASE = process.env.FLOWGUIDE_BASE_URL || "https://flowguide-ruddy.vercel.app";

const sessionFor = async (userId: string) => {
  const token = crypto.randomUUID();
  await svc.from("sessions").insert({ user_id: userId, token, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return token;
};
const api = (token: string) => (p: string) =>
  fetch(`${BASE}${p}`, { headers: { Cookie: `flowguide_session=${token}` } });

/** Walk every page exactly as the list does, and report what browsing reaches. */
async function walk(get: (p: string) => Promise<Response>, query: string, pageSize: number) {
  const seen: string[] = [];
  const pages: number[] = [];
  let cursor: { updatedAt: string; id: string } | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const qs = `${query}${query ? "&" : ""}limit=${pageSize}` +
      (cursor ? `&cursorUpdatedAt=${encodeURIComponent(cursor.updatedAt)}&cursorId=${encodeURIComponent(cursor.id)}` : "");
    const res = await get(`/api/library?${qs}`);
    const body = await res.json();
    if (!res.ok) throw new Error(`page failed ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    seen.push(...(body.items ?? []).map((i: { id: string }) => i.id));
    pages.push((body.items ?? []).length);
    if (!body.hasMore) return { seen, pages, exhausted: true };
    cursor = body.nextCursor;
    if (!cursor) return { seen, pages, exhausted: false };   // hasMore with no cursor = a dead end
  }
  return { seen, pages, exhausted: false };
}

let realToken = "";
let disposable = "";
try {
  // ---- 1. THE REAL LIBRARY: is the 65th item reachable by browsing? -------
  const { data: owner } = await svc.from("users").select("id").eq("email", "mmdmscm@gmail.com").single();
  const OWNER = (owner as { id: string }).id;
  realToken = await sessionFor(OWNER);
  const { data: all } = await svc.from("library_items").select("id,title").eq("user_id", OWNER);
  const realIds = ((all ?? []) as { id: string }[]).map((r) => r.id);
  check("[1] the real Library still holds 65 items", realIds.length === 65, String(realIds.length));

  const walked = await walk(api(realToken), "", 20);
  check("[1] browsing reaches the end", walked.exhausted, JSON.stringify(walked.pages));
  check("[1] EVERY item is reachable WITHOUT SEARCHING", new Set(walked.seen).size === realIds.length,
    `reached ${new Set(walked.seen).size} of ${realIds.length}`);
  check("[1] and item 65 specifically — the one the old cap hid",
    realIds.every((id) => walked.seen.includes(id)), "");
  check("[1] no item was returned twice across pages", walked.seen.length === new Set(walked.seen).size,
    `${walked.seen.length} rows, ${new Set(walked.seen).size} distinct`);
  check("[1] the old 50-row ceiling is gone", walked.seen.length > 50, String(walked.seen.length));

  // A page smaller than the Library must still say there is more.
  const first = await (await api(realToken)("/api/library?limit=10")).json();
  check("[1] the first page reports hasMore EXPLICITLY", first.hasMore === true, JSON.stringify(first.hasMore));
  check("[1] ...and hands back a cursor to continue from",
    !!first.nextCursor?.updatedAt && !!first.nextCursor?.id, JSON.stringify(first.nextCursor));
  check("[1] the cursor timestamp is the raw postgres string, not a Date round-trip",
    /\d{2}:\d{2}:\d{2}(\.\d+)?/.test(String(first.nextCursor?.updatedAt ?? "")) &&
    !String(first.nextCursor?.updatedAt ?? "").endsWith("Z0"), String(first.nextCursor?.updatedAt));
  check("[1] the first page carries the vocabulary", !!first.vocabulary, JSON.stringify(first.vocabulary));

  // ---- 2. A DISPOSABLE LIBRARY: ties, and the filters --------------------
  const { data: du, error: de } = await svc.from("users")
    .insert({ email: `flowguide-page-${process.pid}@disposable.invalid` }).select("id").single();
  if (de) throw new Error(errText(de));
  const DUID = (du as { id: string }).id;
  disposable = DUID;
  const dToken = await sessionFor(DUID);

  // THREE ITEMS SHARING ONE updated_at, which is what breaks a cursor that
  // compares the timestamp alone: the tied rows are skipped or repeated
  // depending on which side of the comparison they fall.
  const TIED = new Date().toISOString();
  // EVERY column on EVERY row. A multi-row insert through PostgREST normalises
  // the column set across the batch: a row that omits a key another row sets is
  // sent an explicit NULL rather than falling back to the column default, and
  // the NOT NULL then rejects the whole batch. It caught is_favorite first and
  // updated_at second, so the factory now supplies all of them.
  const later = (ms: number) => new Date(Date.parse(TIED) + ms).toISOString();
  const row = (title: string, extra: Record<string, unknown>) => ({
    user_id: DUID, title, labels: [] as string[], is_favorite: false,
    updated_at: TIED, ...extra,
  });
  const rows = [
    row("Tied Alpha",   { updated_at: TIED, labels: ["Santa Rosa", "Memory Care"], is_favorite: true }),
    row("Tied Bravo",   { updated_at: TIED, labels: ["Santa Rosa"] }),
    row("Tied Charlie", { updated_at: TIED, labels: ["Moving"] }),
    row("Later Delta",  { updated_at: later(2000), labels: ["Moving", "Real Estate"], is_favorite: true }),
    row("Later Echo",   { updated_at: later(1000) }),
  ];
  const { error: ie } = await svc.from("library_items").insert(rows);
  if (ie) throw new Error(errText(ie));

  const tied = await walk(api(dToken), "", 2);   // page size 2 across a 3-way tie
  check("[2] a page boundary INSIDE a tie loses nothing", new Set(tied.seen).size === 5,
    `reached ${new Set(tied.seen).size} of 5 — pages ${JSON.stringify(tied.pages)}`);
  check("[2] ...and repeats nothing", tied.seen.length === 5, `${tied.seen.length} rows`);
  check("[2] the walk terminates", tied.exhausted, "");

  // The id tiebreak must also make the ORDER stable across identical requests.
  const a = await walk(api(dToken), "", 2);
  const b = await walk(api(dToken), "", 3);
  check("[2] the order is identical at different page sizes",
    JSON.stringify(a.seen) === JSON.stringify(b.seen), `${JSON.stringify(a.seen)} vs ${JSON.stringify(b.seen)}`);

  // ---- 3. FILTERS, composing with each other and with paging -------------
  const titlesOf = async (query: string) => {
    const w = await walk(api(dToken), query, 2);
    const { data } = await svc.from("library_items").select("id,title").in("id", w.seen.length ? w.seen : ["x"]);
    const byId = new Map(((data ?? []) as { id: string; title: string }[]).map((r) => [r.id, r.title]));
    return w.seen.map((id) => byId.get(id) ?? "?");
  };
  const communities = await titlesOf("labels=Santa%20Rosa");
  check("[3] a label filters", communities.length === 2 && communities.every((t) => t.startsWith("Tied")),
    JSON.stringify(communities));

  const santaRosa = await titlesOf("labels=Santa%20Rosa");
  check("[3] one label filters", santaRosa.length === 2, JSON.stringify(santaRosa));

  const both = await titlesOf("labels=Santa%20Rosa,Memory%20Care");
  check("[3] TWO labels are AND, not OR", both.length === 1 && both[0] === "Tied Alpha", JSON.stringify(both));

  const favs = await titlesOf("favorite=1");
  check("[3] favorites filter", favs.length === 2 && favs.every((t) => /Alpha|Delta/.test(t)), JSON.stringify(favs));

  const combined = await titlesOf("labels=Santa%20Rosa&favorite=1");
  check("[3] label + favorite compose", combined.length === 1 && combined[0] === "Tied Alpha",
    JSON.stringify(combined));

  const searched = await titlesOf("q=Charlie");
  check("[3] search still works, and pages", searched.length === 1 && searched[0] === "Tied Charlie",
    JSON.stringify(searched));

  const searchPlusFilter = await titlesOf("q=Tied&labels=Moving");
  check("[3] search composes with a filter", searchPlusFilter.length === 1 && searchPlusFilter[0] === "Tied Charlie",
    JSON.stringify(searchPlusFilter));

  const none = await titlesOf("labels=Nothing%20Named%20This");
  check("[3] a filter matching nothing returns an empty page, not an error", none.length === 0, JSON.stringify(none));

  // ---- 4. ORGANIZING MUST NOT LOOK LIKE EDITING --------------------------
  const target = ((await svc.from("library_items").select("id,revision,updated_at,title")
    .eq("user_id", DUID).eq("title", "Later Echo").single()).data) as
    { id: string; revision: number; updated_at: string };
  const patch = await fetch(`${BASE}/api/library/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${dToken}` },
    body: JSON.stringify({ organization: { labels: ["  Moving ", "moving", "", "Real Estate"], isFavorite: true } }),
  });
  const patched = await patch.json();
  check("[4] an organization patch needs no expectedRevision", patch.ok, `${patch.status} ${JSON.stringify(patched).slice(0, 160)}`);
  const after = ((await svc.from("library_items").select("revision,updated_at,labels,is_favorite")
    .eq("id", target.id).single()).data) as Record<string, unknown>;
  check("[4] revision did NOT move — no false save-back conflict", after.revision === target.revision,
    `${target.revision} -> ${after.revision}`);
  check("[4] updated_at did NOT move — the list does not reshuffle", after.updated_at === target.updated_at,
    `${target.updated_at} -> ${after.updated_at}`);
  check("[4] the labels were trimmed, de-duplicated and folded to one idea",
    JSON.stringify(after.labels) === JSON.stringify(["Moving", "Real Estate"]), JSON.stringify(after.labels));
  check("[4] labels were trimmed, de-duplicated, blanks dropped, spelling reused",
    JSON.stringify(after.labels) === JSON.stringify(["Moving", "Real Estate"]), JSON.stringify(after.labels));
  check("[4] the star was set", after.is_favorite === true, JSON.stringify(after.is_favorite));

  // ---- 5. ORGANIZATION NEVER TRAVELS INTO A FLOWGUIDE --------------------
  const created = await fetch(`${BASE}/api/packets/from-library`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `flowguide_session=${dToken}` },
    body: JSON.stringify({ libraryItemIds: [target.id], title: "Org Leak Check", clientName: "Smoke" }),
  });
  const cbody = await created.json();
  check("[5] a FlowGuide is created from an organized item", created.status === 201,
    `${created.status} ${JSON.stringify(cbody).slice(0, 160)}`);
  if (created.status === 201) {
    const { data: secs } = await svc.from("sections").select("id").eq("packet_id", cbody.packetId);
    const { data: its } = await svc.from("items").select("*")
      .in("section_id", ((secs ?? []) as { id: string }[]).map((x) => x.id));
    const copied = ((its ?? []) as Record<string, unknown>[])[0] ?? {};
    check("[5] the copy carries NO labels, favorite, or place in the structure",
      !("labels" in copied) && !("is_favorite" in copied)
      && !("section_id" in copied) && !("group_id" in copied) && !("sort_order" in copied),
      JSON.stringify(Object.keys(copied)));
    const { data: det } = await svc.from("item_details").select("label,value").eq("item_id", String(copied.id));
    check("[5] and nothing leaked into the item's details",
      !JSON.stringify(det ?? []).includes("Moving") && !JSON.stringify(det ?? []).includes("Services"),
      JSON.stringify(det));
  }
} finally {
  if (realToken) await svc.from("sessions").delete().eq("token", realToken);
  if (disposable) {
    const { data: pk } = await svc.from("packets").select("id").eq("user_id", disposable);
    for (const p of ((pk ?? []) as { id: string }[])) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("library_items").delete().eq("user_id", disposable);
    await svc.from("sessions").delete().eq("user_id", disposable);
    await svc.from("users").delete().eq("id", disposable);
  }
  const { data: leftover } = await svc.from("users").select("id").like("email", "%@disposable.invalid");
  const { count: real } = await svc.from("library_items").select("id", { count: "exact", head: true });
  console.log(`\ncleanup: disposable users=${(leftover ?? []).length} | library rows total=${real}`);
}
process.exit(summary("LIBRARY PAGING + ORGANIZATION FILTERS") > 0 ? 1 : 0);
