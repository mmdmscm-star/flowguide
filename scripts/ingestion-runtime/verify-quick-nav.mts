// VERIFICATION for the quick-navigation presentation preference (0030).
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=… \
//     npx tsx scripts/ingestion-runtime/verify-quick-nav.mts
//
// Disposable data only, removed in the finally block. The fixture deliberately
// carries BOTH a multi-item section (which should index) and a single-item one
// (which never should), so the two rules can be told apart at every step.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE) { console.error("FLOWGUIDE_BASE_URL required"); process.exit(2); }
const TAG = "flowguide-quicknav-" + process.pid;
console.log(`\nquick navigation verification — ${BASE}\n`);

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;

const MULTI = ["Alpha House", "Beta House", "Gamma House"];
const SOLO = "Only One Here";

try {
  await svc.from("professional_profiles").insert({
    user_id: UID, name: "Dana Whitfield", phone: "(206) 555-0100", footer_label: "Your Advisor",
  });
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: TAG, title: "Quick Nav Check", status: "draft", composition_mode: "legacy",
  }).select("id, show_quick_nav, content_rev").single();
  const PID = (p as { id: string }).id;

  check("a NEW packet defaults to showing quick navigation",
    (p as { show_quick_nav: boolean }).show_quick_nav === true,
    `show_quick_nav=${(p as { show_quick_nav: boolean }).show_quick_nav}`);
  // NOT a baseline for the toggle: content_rev is also bumped by triggers on
  // sections, items, details, links, photos, contacts and blocks, so anything
  // measured across the fixture build would attribute those to the toggle. The
  // baseline is taken immediately before the toggle instead.

  const { data: s1 } = await svc.from("sections")
    .insert({ packet_id: PID, title: "Many", sort_order: 0 }).select("id").single();
  await svc.from("items").insert(MULTI.map((t, i) => ({
    section_id: (s1 as { id: string }).id, title: t, sort_order: i })));
  const { data: s2 } = await svc.from("sections")
    .insert({ packet_id: PID, title: "One", sort_order: 1 }).select("id").single();
  await svc.from("items").insert({ section_id: (s2 as { id: string }).id, title: SOLO, sort_order: 0 });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, { ...init,
      headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) } });

  const pub = await api(`/api/packets/${PID}/publish`, {
    method: "POST", body: JSON.stringify({ action: "publish" }) });
  check("the fixture publishes", pub.status === 200, `status ${pub.status}`);

  /** How many index entries the page renders, and whether the solo item is one. */
  async function indexState(path: string) {
    const html = await (await fetch(`${BASE}${path}`, { headers: { Cookie: COOKIE } })).text();
    // The index is a <nav aria-label="Contents of …"> containing anchors.
    const nav = /<nav[^>]+aria-label="Contents of [^"]*"[\s\S]*?<\/nav>/g;
    const navs = html.match(nav) ?? [];
    const joined = navs.join("");
    return {
      navCount: navs.length,
      // Distinctive: an index entry is an anchor to #item-…, not the card itself.
      anchors: (joined.match(/href="#item-/g) ?? []).length,
      indexesSolo: joined.includes(SOLO),
      // The CONTENT must be present either way — this is presentation only.
      hasAllItems: [...MULTI, SOLO].every((t) => html.includes(t)),
      order: MULTI.map((t) => html.indexOf(t)),
    };
  }

  // ---- ON (the default) -----------------------------------------------------
  for (const [label, path] of [["live recipient view", `/p/${TAG}`],
                               ["creator preview", `/preview/${PID}`]] as const) {
    const on = await indexState(path);
    check(`ON — the ${label} shows the index`, on.navCount === 1 && on.anchors === 3,
      `${on.navCount} nav(s), ${on.anchors} anchors`);
    check(`ON — the ${label} does NOT index the single-item section`, !on.indexesSolo,
      "the solo item appeared in an index");
    check(`ON — the ${label} still shows every item`, on.hasAllItems, "content missing");
  }

  // ---- toggle OFF through the real route ------------------------------------
  const { data: pre } = await svc.from("packets").select("content_rev").eq("id", PID).single();
  const revBeforeToggle = (pre as { content_rev: number }).content_rev;

  const off = await api(`/api/packets/${PID}`, {
    method: "PATCH", body: JSON.stringify({ showQuickNav: false }) });
  check("the toggle saves through PATCH", off.status === 200, `status ${off.status}`);

  for (const [label, path] of [["live recipient view", `/p/${TAG}`],
                               ["creator preview", `/preview/${PID}`]] as const) {
    const o = await indexState(path);
    check(`OFF — the ${label} hides the index`, o.navCount === 0 && o.anchors === 0,
      `${o.navCount} nav(s), ${o.anchors} anchors`);
    check(`OFF — the ${label} still shows every item, in order`,
      o.hasAllItems && o.order.every((v, i) => v > -1 && (i === 0 || v > o.order[i - 1])),
      "content or ordering changed with a presentation toggle");
  }

  // ---- an ALREADY-PUBLISHED packet reflects it immediately -------------------
  const { data: after } = await svc.from("packets")
    .select("status, show_quick_nav, content_rev").eq("id", PID).single();
  const a = after as { status: string; show_quick_nav: boolean; content_rev: number };
  check("the packet is still published — no unpublish, no republish needed",
    a.status === "published", a.status);
  check("AND THE CHANGE IS LIVE, not frozen at publish time", a.show_quick_nav === false,
    "the stored flag did not change");
  check("TOGGLING DID NOT BUMP content_rev — measured across the toggle alone",
    a.content_rev === revBeforeToggle,
    `content_rev ${revBeforeToggle} -> ${a.content_rev} across one PATCH`);

  // THE PAIRED ASSERTION. Without it, "did not bump" would also pass if
  // content_rev were broken and never bumped at all.
  await api(`/api/packets/${PID}`, {
    method: "PATCH", body: JSON.stringify({ title: "Quick Nav Check (renamed)" }) });
  const { data: afterTitle } = await svc.from("packets").select("content_rev").eq("id", PID).single();
  check("but changing a CONTENT field through the same route still does",
    (afterTitle as { content_rev: number }).content_rev === a.content_rev + 1,
    `content_rev ${a.content_rev} -> ${(afterTitle as { content_rev: number }).content_rev}`);

  // ---- and back ON ----------------------------------------------------------
  await api(`/api/packets/${PID}`, { method: "PATCH", body: JSON.stringify({ showQuickNav: true }) });
  const back = await indexState(`/p/${TAG}`);
  check("turning it back ON restores the index", back.navCount === 1 && back.anchors === 3,
    `${back.navCount} nav(s), ${back.anchors} anchors`);

  // ---- the write path refuses nonsense --------------------------------------
  const bad = await api(`/api/packets/${PID}`, {
    method: "PATCH", body: JSON.stringify({ showQuickNav: "yes" }) });
  check("a non-boolean is rejected with a clear 400", bad.status === 400, `status ${bad.status}`);

  // ---- the other renderers are untouched ------------------------------------
  const email = await api(`/api/packets/${PID}/email`);
  const emailBody = await email.json().catch(() => ({}));
  check("the email version still builds", email.status === 200, `status ${email.status}`);
  check("and carries every item regardless of the toggle",
    [...MULTI, SOLO].every((t) => (emailBody?.html ?? "").includes(t)), "email lost content");
  const print = await fetch(`${BASE}/p/${TAG}/print`, { headers: { Cookie: COOKIE } });
  const printHtml = await print.text();
  check("the printed version still builds", print.status === 200, `status ${print.status}`);
  check("and carries every item regardless of the toggle",
    [...MULTI, SOLO].every((t) => printHtml.includes(t)), "print lost content");
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("professional_profiles").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
summary("quick navigation verification");
