// VERIFICATION for the /settings identity surface.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=http://localhost:3000 \
//     npx tsx scripts/ingestion-runtime/verify-identity.mts
//
// Disposable data only; removed in the finally block. Walks a professional from
// "brand new, no profile row at all" through to "fully configured", checking at
// each step that the dashboard prompt and the publish route agree — which is the
// whole point of the shared rule.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE) { console.error("FLOWGUIDE_BASE_URL required"); process.exit(2); }
const TAG = "flowguide-identity-" + process.pid;
console.log(`\nidentity surface verification — ${BASE}\n`);

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;
const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;
const get = (p: string) => fetch(`${BASE}${p}`, { headers: { Cookie: COOKIE } });
const patchProfile = (body: unknown) => fetch(`${BASE}/api/profile`, {
  method: "PATCH", headers: { "Content-Type": "application/json", Cookie: COOKIE },
  body: JSON.stringify(body),
});

async function makePacket(slug: string) {
  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug, title: `Identity ${slug}`, status: "draft", composition_mode: "legacy",
  }).select("id").single();
  const pid = (p as { id: string }).id;
  const { data: s } = await svc.from("sections")
    .insert({ packet_id: pid, title: "S", sort_order: 0 }).select("id").single();
  await svc.from("items").insert({ section_id: (s as { id: string }).id, title: "Item", sort_order: 0 });
  return pid;
}
const publish = (pid: string, skip = false) => fetch(`${BASE}/api/packets/${pid}/publish`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: COOKIE },
  body: JSON.stringify(skip ? { action: "publish", skipProfileCheck: true } : { action: "publish" }),
});
const snapshotOf = async (pid: string) => {
  const { data } = await svc.from("packets").select("professional_snapshot").eq("id", pid).single();
  return (data as { professional_snapshot: Record<string, unknown> | null })?.professional_snapshot ?? null;
};

try {
  // === 1. BRAND-NEW PROFESSIONAL: no professional_profiles row at all ========
  const { count: rows } = await svc.from("professional_profiles")
    .select("user_id", { count: "exact", head: true }).eq("user_id", UID);
  check("a brand-new professional has NO profile row", rows === 0, `${rows} rows`);

  const s0 = await get("/settings");
  const s0html = await s0.text();
  check("/settings renders for a professional with no profile", s0.status === 200, `status ${s0.status}`);
  check("and shows the empty form rather than an error",
    s0html.includes("Your name") && s0html.includes("Footer label"), "form fields missing");
  check("and names the FIRST gap (a name)", s0html.includes("Add your name"), "no gap shown");

  const d0 = await (await get("/dashboard")).text();
  check("the dashboard prompts a brand-new professional", d0.includes("Add your name"), "no prompt");
  check("and the prompt links to /settings", d0.includes('href="/settings"'), "prompt has no way through");

  // A packet cannot be published yet — and the REASON must match the prompt.
  const pidA = await makePacket(`${TAG}-a`);
  const r1 = await publish(pidA);
  const b1 = await r1.json().catch(() => ({}));
  check("publish refuses, with the same gap the prompt named",
    r1.status === 422 && b1?.error === "no_profile", `${r1.status} ${JSON.stringify(b1).slice(0, 90)}`);

  // === 2. HALF-CONFIGURED: a name, but no way to reply =======================
  await patchProfile({ name: "Dana Whitfield" });
  const d1 = await (await get("/dashboard")).text();
  check("with a name but no contact, the prompt MOVES ON to the second gap",
    d1.includes("Add a phone number or email"), "prompt did not advance");
  const r2 = await publish(pidA);
  const b2 = await r2.json().catch(() => ({}));
  check("and publish refuses for that same second reason",
    r2.status === 422 && b2?.error === "no_contact", `${r2.status} ${JSON.stringify(b2).slice(0, 90)}`);

  // === 3. FULLY CONFIGURED ===================================================
  await patchProfile({
    phone: "(206) 555-0100", email: "dana@disposable.invalid",
    businessName: "Whitfield Senior Advisors", footerLabel: "Your Advisor",
    websiteUrl: "whitfield.disposable.invalid",
    links: [{ label: "Reviews", url: "https://reviews.disposable.invalid" }],
  });
  const d2 = await (await get("/dashboard")).text();
  check("a configured professional is NOT prompted",
    !d2.includes("Add your name") && !d2.includes("Add a phone number or email"), "still nagging");
  // The dashboard's own "Your details" button and the block editor's nav are
  // drawn by client components, so a fetch sees only their loading state. Both
  // are checked in a real browser and pinned by source gates; asserting them
  // here would fail for the wrong reason.
  check("and no stale prompt is left behind in the server-rendered shell",
    !d2.includes("Add your details"), "the prompt survived a completed profile");

  const s2 = await (await get("/settings")).text();
  check("/settings shows the saved values", s2.includes("Whitfield Senior Advisors"), "values not loaded");
  check("and no gap banner", !s2.includes("Add your name"), "gap shown for a complete profile");

  // === 4. PUBLISH SNAPSHOTS THE PROFILE ======================================
  const r3 = await publish(pidA);
  check("publish now succeeds", r3.status === 200, `status ${r3.status}`);
  const snapA = await snapshotOf(pidA);
  check("and freezes the CURRENT profile into the packet",
    snapA?.name === "Dana Whitfield" && snapA?.businessName === "Whitfield Senior Advisors",
    JSON.stringify(snapA).slice(0, 120));

  // === 5. A LATER PROFILE EDIT MUST NOT REWRITE HISTORY ======================
  await patchProfile({ name: "Dana W. Renamed", phone: "(206) 555-9999" });
  const snapAfter = await snapshotOf(pidA);
  check("AN ALREADY-PUBLISHED PACKET KEEPS ITS SNAPSHOT",
    snapAfter?.name === "Dana Whitfield" && snapAfter?.phone === "(206) 555-0100",
    JSON.stringify(snapAfter).slice(0, 120));
  const live = await (await fetch(`${BASE}/p/${TAG}-a`)).text();
  check("and the recipient still sees the identity it was published with",
    live.includes("Dana Whitfield") && !live.includes("Dana W. Renamed"), "the live page drifted");

  // === 6. A NEW PUBLISH PICKS UP THE UPDATE ==================================
  const pidB = await makePacket(`${TAG}-b`);
  const r4 = await publish(pidB);
  check("a newly published packet publishes", r4.status === 200, `status ${r4.status}`);
  const snapB = await snapshotOf(pidB);
  check("and carries the UPDATED profile",
    snapB?.name === "Dana W. Renamed" && snapB?.phone === "(206) 555-9999",
    JSON.stringify(snapB).slice(0, 120));

  // === 7. SKIP-PROFILE PUBLISHING IS UNCHANGED ===============================
  const pidC = await makePacket(`${TAG}-c`);
  const r5 = await publish(pidC, true);
  check("skip-profile publishing still succeeds", r5.status === 200, `status ${r5.status}`);
  const snapC = await snapshotOf(pidC);
  check("and still stores an EMPTY snapshot, exactly as before",
    snapC !== null && Object.keys(snapC).length === 0, JSON.stringify(snapC));

  // === 8. THE EDITORS ========================================================
  const legacy = await get(`/edit/${pidB}`);
  check("the legacy editor still loads", legacy.status === 200, `status ${legacy.status}`);

  await svc.from("packets").update({ composition_mode: "blocks" }).eq("id", pidC);
  const blockPage = await get(`/edit/${pidC}`);
  const blockHtml = await blockPage.text();
  check("the block editor loads", blockPage.status === 200, `status ${blockPage.status}`);
  check("and serves no second profile form of its own",
    !blockHtml.includes("Footer label (e.g. Your Advisor)"), "the block editor grew its own form");

  // === 9. IMAGE UPLOAD STILL WORKS ===========================================
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "logo.png");
  const up = await fetch(`${BASE}/api/profile/images`, { method: "POST", headers: { Cookie: COOKIE }, body: form });
  const upBody = await up.json().catch(() => ({}));
  check("profile image upload still works", up.status === 200 && Boolean(upBody?.url),
    `${up.status} ${JSON.stringify(upBody).slice(0, 100)}`);
  if (upBody?.url) {
    await patchProfile({ logoUrl: upBody.url });
    const s3 = await (await get("/settings")).text();
    check("and the uploaded logo comes back on the settings page",
      s3.includes(String(upBody.url)), "uploaded logo not shown");
  }
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("professional_profiles").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`\ncleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
summary("identity surface verification");
