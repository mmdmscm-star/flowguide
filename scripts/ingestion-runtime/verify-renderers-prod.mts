// PRODUCTION VERIFICATION for the supporting renderers: the email version and
// the paper/PDF version.
//
//   FLOWGUIDE_RT_CONFIRM=1 FLOWGUIDE_BASE_URL=https://flowguide-ruddy.vercel.app \
//     npx tsx scripts/ingestion-runtime/verify-renderers-prod.mts
//
// Disposable data only: one throwaway user, its profile and packet, all removed
// in the finally block. No live client packet is read or written.
//
// The fixture is built to EXERCISE the new paths rather than merely survive
// them: an item with six photos (so the gallery has to appear), a Cloudinary
// host (so the square crop has to be applied), a full professional identity
// (logo, headshot, website, custom link) and a private note that must not
// escape. A fixture without those would pass whatever the renderer did.
import { svc, check, summary, errText } from "./lib.mts";

const BASE = process.env.FLOWGUIDE_BASE_URL;
if (!BASE || BASE.includes("localhost")) {
  console.error("FLOWGUIDE_BASE_URL must be the production origin");
  process.exit(2);
}
const TAG = "flowguide-emailverify-" + process.pid;
const CLD = "https://res.cloudinary.com/demo/image/upload";
const SECRET = "PRIVATE-NOTE-MUST-NOT-ESCAPE-" + process.pid;
console.log(`\nemail renderer production verification — ${BASE}\n`);

const { data: user, error: uerr } = await svc
  .from("users").insert({ email: `${TAG}@disposable.invalid` }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }
const UID = (user as { id: string }).id;

const token = crypto.randomUUID();
await svc.from("sessions").insert({
  user_id: UID, token, expires_at: new Date(Date.now() + 864e5).toISOString(),
});
const COOKIE = `flowguide_session=${token}`;

try {
  await svc.from("professional_profiles").insert({
    user_id: UID, name: "Dana Whitfield", email: "dana@disposable.invalid",
    phone: "(206) 555-0100", business_name: "Whitfield Senior Advisors",
    footer_label: "Your Advisor",
    logo_url: "https://brand.disposable.invalid/logo.png",
    headshot_url: "https://people.disposable.invalid/dana.jpg",
    website_url: "whitfield.disposable.invalid",
    links: [{ url: "https://reviews.disposable.invalid/dana", label: "Reviews" }],
  });

  const { data: p } = await svc.from("packets").insert({
    user_id: UID, slug: TAG, title: "Email Verification Packet",
    client_name: "the Alvarez family", status: "draft", composition_mode: "legacy",
    personal_note: "Hi there,\n\nHave a look.\n\nThank you,\n\nDana",
  }).select("id").single();
  const PID = (p as { id: string }).id;

  const { data: s } = await svc.from("sections")
    .insert({ packet_id: PID, title: "Recommended", sort_order: 0 }).select("id").single();
  const SID = (s as { id: string }).id;

  const { data: i1 } = await svc.from("items").insert({
    section_id: SID, title: "Gallery House", sort_order: 0,
    address: "1247 Sonoma Ave, Santa Rosa, CA",
    description: "A warm boutique community.", notes: SECRET,
  }).select("id").single();
  const I1 = (i1 as { id: string }).id;
  await svc.from("item_photos").insert(
    ["one", "two", "three", "four", "five", "six"].map((n, k) => ({
      item_id: I1, url: `${CLD}/v1/${n}.jpg`, sort_order: k })));
  await svc.from("item_details").insert([
    { item_id: I1, label: "Monthly cost", value: "$4,800", sort_order: 0 }]);
  await svc.from("item_contacts").insert([
    { item_id: I1, name: "Maria Santos", phone: "(707) 555-1041", sort_order: 0 }]);

  const { data: i2 } = await svc.from("items").insert({
    section_id: SID, title: "Single Photo Place", sort_order: 1 }).select("id").single();
  await svc.from("item_photos").insert({
    item_id: (i2 as { id: string }).id, url: `${CLD}/v1/only.jpg`, sort_order: 0 });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, { ...init,
      headers: { "Content-Type": "application/json", Cookie: COOKIE, ...(init.headers || {}) } });

  // Publish through the REAL route so production builds the snapshot.
  const pub = await api(`/api/packets/${PID}/publish`, {
    method: "POST", // NOT skipProfileCheck: that flag publishes with an EMPTY snapshot by
    // design, which would leave nothing for the identity assertions to find and
    // make them pass or fail for the wrong reason.
    body: JSON.stringify({ action: "publish" }) });
  check("the packet publishes in production", pub.status === 200, `status ${pub.status}`);

  // -- the action is reachable ------------------------------------------------
  const prev = await fetch(`${BASE}/preview/${PID}`, { headers: { Cookie: COOKIE } });
  const prevHtml = await prev.text();
  check("the preview page loads for its owner", prev.status === 200, `status ${prev.status}`);
  check("the email-version action APPEARS on the published preview",
    prevHtml.includes("Create email version"), "control not found in the preview page");
  check("and the short client-message option is still there beside it",
    prevHtml.includes("Message for your client") && prevHtml.includes("Copy message"),
    "the client-message delivery option went missing");
  check("with the link-only option still beside THAT",
    prevHtml.includes("Copy link only"), "the link-only option went missing");

  // -- it generates correctly -------------------------------------------------
  const res = await api(`/api/packets/${PID}/email`);
  const body = await res.json().catch(() => ({}));
  check("the email route answers 200 in production", res.status === 200, `status ${res.status}`);
  const html: string = body?.html ?? "";
  check("and returns HTML", typeof html === "string" && html.length > 500, `${html.length} bytes`);

  check("PRIVATE NOTES DO NOT ESCAPE", !html.includes(SECRET), "the private note reached the email");

  for (const n of ["one", "two", "three", "four", "five", "six", "only"]) {
    check(`photo "${n}" survives`, html.includes(`${n}.jpg`), "photo dropped");
  }
  check("photo order is packet order",
    ["one", "two", "three", "four", "five", "six"].map((n) => html.indexOf(`${n}.jpg`))
      .every((v, k, a) => v > -1 && (k === 0 || v > a[k - 1])), "order not preserved");
  check("the thumbnails are squared by the source",
    html.includes("c_fill,g_auto,ar_1:1,w_264"), "square crop missing");
  check("the hero is a bounded rendition", html.includes("c_limit,w_1104"), "hero rendition missing");
  check("one stated way into the gallery",
    (html.match(/View all \d+ photos/g) ?? []).join() === "View all 6 photos",
    (html.match(/View all \d+ photos/g) ?? []).join());

  for (const [what, needle] of [
    ["logo", "brand.disposable.invalid/logo.png"], ["headshot", "people.disposable.invalid/dana.jpg"],
    ["name", "Dana Whitfield"], ["business", "Whitfield Senior Advisors"],
    ["label", "YOUR ADVISOR"], ["call", "Call Dana"], ["text", "sms:"],
    ["email", "mailto:dana@disposable.invalid"],
    ["website", "https://whitfield.disposable.invalid"],
    ["custom link", "https://reviews.disposable.invalid/dana"],
  ] as const) {
    check(`the professional's ${what} is carried`, html.includes(needle), `missing: ${needle}`);
  }

  check("the personal note keeps its sign-off", html.includes("Thank you,"), "note altered");
  check("email-safe: no <style>, no classes, no modern CSS",
    !/<style/i.test(html) && !/class=/i.test(html) && !/display:\s*(flex|grid)/i.test(html)
      && !/object-fit/.test(html), "unsafe CSS present");

  // -- the PAPER renderer -----------------------------------------------------
  // Same packet, same source, a third presentation. What cannot be checked from
  // here is pagination: that needs a real Letter PDF, printed and read page by
  // page. This asserts the things that would make such a proof pointless -
  // missing photos, a leaked note, a cached or indexable page.
  const printRes = await fetch(`${BASE}/p/${TAG}/print`, { headers: { Cookie: COOKIE } });
  const printHtml = await printRes.text();
  check("the print route answers 200 in production", printRes.status === 200, `status ${printRes.status}`);
  check("PRIVATE NOTES DO NOT REACH THE PAPER", !printHtml.includes(SECRET), "the private note reached print");
  for (const n of ["one", "two", "three", "four", "five", "six", "only"]) {
    check(`print keeps photo "${n}"`, printHtml.includes(`${n}.jpg`), "photo dropped from print");
  }
  check("print squares its tiles at the source",
    printHtml.includes("c_fill,g_auto,ar_1:1"), "square crop missing from print");
  check("print carries the professional identity",
    printHtml.includes("Dana Whitfield") && printHtml.includes("Your Advisor"),
    "identity missing from print");
  check("print keeps the personal note's sign-off", printHtml.includes("Thank you,"), "note altered");
  check("the print page is not indexable", /noindex/.test(printHtml), "print page is indexable");
  check("the print toolbar is marked no-print", printHtml.includes("pg-noprint"), "toolbar would print");

  const printOnly = await fetch(`${BASE}/p/${TAG}/print`);
  check("and the print page is reachable by the RECIPIENT too, like the packet itself",
    printOnly.status === 200, `status ${printOnly.status}`);

  console.log(`\n  html: ${Buffer.byteLength(html, "utf8")} bytes, ${(html.match(/<img /g) ?? []).length} images\n`);
} finally {
  await svc.from("packets").delete().eq("user_id", UID);
  await svc.from("professional_profiles").delete().eq("user_id", UID);
  await svc.from("sessions").delete().eq("user_id", UID);
  await svc.from("users").delete().eq("id", UID);
  const { count } = await svc.from("packets").select("id", { count: "exact", head: true }).eq("user_id", UID);
  console.log(`cleanup: ${count ?? 0} packets remaining — ${count ? "NOT CLEAN" : "clean"}`);
}
summary("renderer production verification");
