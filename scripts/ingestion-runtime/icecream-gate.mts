// THE ICE-CREAM GATE. Real recovered production source, offline enforcement.
import { svc } from "./lib.mts";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll } from "../../src/lib/attribution.ts";
import { reconcile } from "../../src/lib/reconcile.ts";
import { enforceItem, sourceGrantsPrivacy } from "../../src/lib/enforce.ts";
import { buildRunChunks } from "../../src/lib/ingestion.ts";

const { data } = await svc.from("packets").select("raw_input").eq("id", "9c564682-8959-44f9-b8ae-eb6a69bfdcae").single();
const src = String((data as any).raw_input ?? "");
const ENV = recordEnvelopes(src);
console.log(`\nICE-CREAM GATE — ${src.length} chars\n`);
console.log(`  record envelopes ................. ${ENV ? ENV.length : "NULL"}   (gate: 15)`);
if (!ENV) process.exit(1);

// Tiling: no overlap, no gap, ordered.
let tiled = true;
for (let i = 1; i < ENV.length; i++) if (ENV[i - 1].end !== ENV[i].start) tiled = false;
console.log(`  envelopes tile without overlap ... ${tiled}`);
console.log(`  first / last shop ................ ${ENV[0].name.slice(0, 34)}  …  ${ENV[ENV.length - 1].name.slice(0, 34)}`);

// The real production items, keyed by the shop each envelope names.
const { data: secs } = await svc.from("sections").select("id").eq("packet_id", "9c564682-8959-44f9-b8ae-eb6a69bfdcae");
const sids = (secs ?? []).map((s: any) => s.id);
const { data: itemRows } = await svc.from("items").select("id, title, notes, description").in("section_id", sids).order("sort_order");
const items = (itemRows ?? []) as any[];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let websitesAttributed = 0, restored = 0, misbound = 0, unaccountedWebsites = 0, notesSurfaced = 0, notesWrongShop = 0;
for (const c of buildRunChunks(src)) {
  const parsed = parseClaims(c.segment_text, c.ordinal);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, ENV, c.source_start ?? 0);
  for (const f of parsed.fragments) if (/\.(com|net|org)\b/i.test(f.text)) unaccountedWebsites++;
  for (const [rec, g] of a.byRecord) {
    const envName = ENV[rec].name;
    const item = items.find((it) => norm(envName).includes(norm(it.title).slice(0, 12))) ?? null;
    const web = g.claims.filter((x) => x.kind === "url" && String(x.label ?? "").toLowerCase() === "website");
    for (const w of web) {
      websitesAttributed++;
      // Misbinding check: the domain must belong to THIS shop's source region.
      if (!src.slice(ENV[rec].start, ENV[rec].end).includes(w.value)) misbound++;
    }
    if (!item) continue;
    const r = reconcile({ claims: g.claims, ambiguous: g.ambiguous, fragments: g.fragments },
      { title: item.title, notes: item.notes ?? "", links: [], details: [], contacts: [] });
    const e = enforceItem({ title: item.title, notes: item.notes ?? "", links: [], details: [], contacts: [] },
      r.resolutions, g.claims, { privacyGranted: sourceGrantsPrivacy(c.segment_text) });
    restored += ((e.item.links as any[]) ?? []).filter((l) => /^https:\/\//.test(String(l?.url ?? ""))).length;
    for (const un of e.unresolvedNotes) {
      notesSurfaced++;
      // CORRECT SHOP means the note's own words appear inside THIS envelope's
      // source region. An earlier version tested for the phrase "Why it made
      // the list", which measures the wording rather than the attribution.
      const region = src.slice(ENV[rec].start, ENV[rec].end).toLowerCase().replace(/\s+/g, " ");
      const probe = String(un.text).toLowerCase().replace(/\s+/g, " ").slice(0, 60);
      if (probe.length >= 20 && !region.includes(probe)) notesWrongShop++;
    }
  }
}
console.log(`\n  Website claims ATTRIBUTED to a shop ... ${websitesAttributed}/15`);
console.log(`  misbound websites .................... ${misbound}`);
console.log(`  restored to canonical Links .......... ${restored}/15`);
console.log(`  unaccounted Website units ............ ${unaccountedWebsites}`);
console.log(`  "Why it made the list" surfaced ...... ${notesSurfaced}/13 as recipient-visible unresolved`);
console.log(`  ...attributed to the wrong shop ...... ${notesWrongShop}`);
console.log("");
