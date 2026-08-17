// Prove view-marking still works through the REAL /p/[slug] route after 0015,
// without touching a single client packet.
//
//   npx tsx scripts/security/view-marking-proof.mts setup    -> prints the slug
//   <open http://localhost:3000/p/{slug} in a browser>
//   npx tsx scripts/security/view-marking-proof.mts check    -> asserts + cleans up
//
// The real packet could not prove this: it was already `viewed`, because a
// professional previews before sending, so there was no transition to observe.
// This creates a packet that starts NOT viewed, is opened through the actual
// recipient route, and deletes itself.
//
// markPacketViewed is deliberately fire-and-forget in the page
// (`markPacketViewed(slug).catch(() => {})`, not awaited), so `check` polls
// rather than reading once.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const STATE = "/tmp/flowguide-viewproof.json";
const mode = process.argv[2];

if (mode === "setup") {
  const { data: user } = await svc.from("users").select("id").limit(1).maybeSingle();
  if (!user) { console.error("no users row"); process.exit(1); }
  const uid = (user as { id: string }).id;
  const slug = `zz-viewproof-${Date.now().toString(36)}`;

  const { data: pkt, error } = await svc.from("packets").insert({
    user_id: uid, slug, title: "VIEW-MARKING PROOF — delete me",
    client_name: "proof", raw_input: "PROOF", status: "published", viewed: false,
  }).select("id, viewed").single();
  if (error) { console.error("create failed:", error.message); process.exit(1); }
  const packetId = (pkt as { id: string }).id;

  const { data: sec } = await svc.from("sections")
    .insert({ packet_id: packetId, title: "Proof section", sort_order: 0 }).select("id").single();
  await svc.from("items").insert({
    section_id: (sec as { id: string }).id, title: "Proof item",
    description: "Renders so the route does real work.", sort_order: 0,
  });

  writeFileSync(STATE, JSON.stringify({ packetId, slug }));
  console.log(`created  packet ${packetId}`);
  console.log(`viewed   ${(pkt as { viewed: boolean }).viewed}  <- must be false`);
  console.log(`\nOPEN:    http://localhost:3000/p/${slug}\n`);
  process.exit(0);
}

if (mode === "check") {
  if (!existsSync(STATE)) { console.error("no setup state — run `setup` first"); process.exit(1); }
  const { packetId, slug } = JSON.parse(readFileSync(STATE, "utf8"));
  let viewed = false;
  for (let i = 0; i < 10; i++) {
    const { data } = await svc.from("packets").select("viewed").eq("id", packetId).maybeSingle();
    viewed = !!(data as { viewed?: boolean } | null)?.viewed;
    if (viewed) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`slug     ${slug}`);
  console.log(`viewed   ${viewed}  <- must be true`);

  await svc.from("packets").delete().eq("id", packetId);
  const { data: left } = await svc.from("packets").select("id").like("slug", "zz-viewproof-%");
  unlinkSync(STATE);
  console.log(`cleanup  ${left?.length ?? 0} proof packet(s) remaining (expect 0)`);
  console.log(viewed
    ? "\nPASS — view marking works through the real recipient route after 0015."
    : "\nFAIL — the packet was opened but never marked viewed.");
  process.exit(viewed ? 0 : 1);
}

console.error("usage: view-marking-proof.mts setup|check");
process.exit(1);
