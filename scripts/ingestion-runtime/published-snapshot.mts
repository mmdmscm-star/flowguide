// Read-only recipient-output snapshot of every published packet.
//
// Run against two app versions (the deployed commit and the feature branch) and
// diff the results to prove the ingestion work did not change what a recipient
// sees. Renders through the real public route, not the database.
//
// Usage: FLOWGUIDE_BASE_URL=http://localhost:3001 npx tsx published-snapshot.mts out.json
import { svc, errText } from "./lib.mts";
import { writeFileSync } from "node:fs";

const BASE = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
const out = process.argv[2];
if (!out) { console.error("usage: published-snapshot.mts <output.json>"); process.exit(1); }

const { data: packets, error } = await svc
  .from("packets").select("id, slug, title, composition_mode")
  .eq("status", "published").order("slug");
if (error) { console.error(errText(error)); process.exit(1); }

// Strip only things that legitimately vary between two servers/renders:
// build ids, nonces, chunk hashes, timestamps. Everything else must match.
function normalise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/nonce="[^"]*"/g, "")
    .replace(/\/_next\/static\/[^"' ]+/g, "")
    .replace(/data-nscp[^=]*="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// Visible text is the stronger signal: what the recipient actually reads.
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

const snapshot: Record<string, unknown> = { base: BASE, packets: {} };
let ok = 0, bad = 0;
for (const p of packets ?? []) {
  const url = `${BASE}/p/${p.slug}`;
  try {
    const r = await fetch(url, { redirect: "follow" });
    const html = await r.text();
    const text = visibleText(html);
    (snapshot.packets as Record<string, unknown>)[p.slug] = {
      status: r.status,
      mode: p.composition_mode,
      textHash: fnv(text),
      htmlHash: fnv(normalise(html)),
      textLength: text.length,
      text,
    };
    if (r.status === 200) ok++; else bad++;
    console.log(`  ${r.status}  /p/${p.slug}  ${text.length} chars  ${fnv(text)}`);
  } catch (e: unknown) {
    bad++;
    (snapshot.packets as Record<string, unknown>)[p.slug] = { status: 0, error: String(e) };
    console.log(`  ERR  /p/${p.slug}  ${String(e).slice(0, 80)}`);
  }
}
console.log(`\n${ok} ok, ${bad} not ok, of ${(packets ?? []).length} published packets`);
writeFileSync(out, JSON.stringify(snapshot, null, 1));
console.log(`wrote ${out}`);
process.exit(bad > 0 ? 1 : 0);
