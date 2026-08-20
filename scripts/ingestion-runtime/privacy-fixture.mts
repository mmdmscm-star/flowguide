// Creates (or removes) ONE disposable published FlowGuide carrying a sentinel
// private note, using the service role only — no HTTP. Exists so the production
// check can be made in a real browser when scripted traffic is being challenged
// by Vercel's bot mitigation.
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/privacy-fixture.mts create
//   FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/privacy-fixture.mts drop
import { svc, errText } from "./lib.mts";
const MODE = process.argv[2];
const TAG = "flowguide-privfixture";
const SECRET = "PRIVATENOTESENTINEL7731 the family cannot afford this community";

if (MODE === "drop") {
  const { data: us } = await svc.from("users").select("id").like("email", `${TAG}%`);
  for (const u of (us ?? []) as { id: string }[]) {
    const { data: ps } = await svc.from("packets").select("id").eq("user_id", u.id);
    for (const p of (ps ?? []) as { id: string }[]) await svc.from("packets").delete().eq("id", p.id);
    await svc.from("sessions").delete().eq("user_id", u.id);
    await svc.from("users").delete().eq("id", u.id);
  }
  const { data: left } = await svc.from("users").select("id").like("email", `${TAG}%`);
  console.log(`cleanup: ${(left ?? []).length} row(s) remaining — ${(left ?? []).length === 0 ? "clean" : "MANUAL CLEANUP NEEDED"}`);
  process.exit(0);
}

const { data: u, error: uErr } = await svc.from("users")
  .insert({ email: `${TAG}-${Date.now()}@disposable.invalid` }).select("id").single();
if (uErr) throw new Error(errText(uErr));
const UID = (u as { id: string }).id;
const slug = `${TAG}-${crypto.randomUUID().slice(0, 8)}`;
const { data: p, error: pErr } = await svc.from("packets")
  .insert({ user_id: UID, slug, title: "Privacy check", status: "published" }).select("id").single();
if (pErr) throw new Error(errText(pErr));
const { data: s } = await svc.from("sections")
  .insert({ packet_id: (p as { id: string }).id, title: "Communities", sort_order: 0 }).select("id").single();
const { data: it } = await svc.from("items").insert({
  section_id: (s as { id: string }).id, title: "Fairview Gardens", address: "1200 Example Rd",
  description: "Assisted living and memory care.", notes: SECRET, sort_order: 0,
}).select("id").single();
await svc.from("item_details").insert({ item_id: (it as { id: string }).id, label: "AL Studio", value: "$4,500/mo", sort_order: 0 });

console.log(`slug: ${slug}`);
console.log(`url:  https://flowguide-ruddy.vercel.app/p/${slug}`);
console.log(`sentinel: ${SECRET}`);
