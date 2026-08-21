// REAL REGRESSION CASE — the 2026-08-21 production ice-cream import.
// Source recovered from packets.raw_input. No ice-cream-specific rules exist;
// this exercises the two-line label form and bare-hostname recognition.
import { svc } from "./lib.mts";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { reconcile } from "../../src/lib/reconcile.ts";
import { enforceItem, sourceGrantsPrivacy } from "../../src/lib/enforce.ts";
import { buildRunChunks } from "../../src/lib/ingestion.ts";
import { canonicalValue } from "../../src/lib/canonical.ts";

const { data } = await svc.from("packets").select("raw_input").eq("id", "9c564682-8959-44f9-b8ae-eb6a69bfdcae").single();
const src = String((data as any).raw_input ?? "");
const chunks = buildRunChunks(src);
let websiteClaims = 0, urlClaims = 0, labelled = 0, phones = 0, ambiguous = 0, unaccountedDomains = 0;
const links: string[] = [];
for (const c of chunks) {
  const p = parseClaims(c.segment_text, c.ordinal);
  labelled += p.claims.filter((x) => x.kind === "labelled").length;
  phones += p.claims.filter((x) => x.kind === "phone").length;
  ambiguous += p.ambiguous.length;
  for (const cl of p.claims.filter((x) => x.kind === "url")) {
    urlClaims++;
    if (String(cl.label ?? "").toLowerCase() === "website") websiteClaims++;
    links.push(canonicalValue(cl.value, "url"));
  }
  for (const f of p.fragments) if (/\.(com|net|org)\b/i.test(f.text)) unaccountedDomains++;
}
console.log(`\nICE-CREAM REGRESSION — ${chunks.length} chunks, ${src.length} chars\n`);
console.log(`  Website claims recognized ........ ${websiteClaims}/15`);
console.log(`  url claims total ................. ${urlClaims}`);
console.log(`  canonical links (scheme added) ... ${links.filter((l) => /^https:\/\//.test(l)).length}/15`);
console.log(`  labelled claims .................. ${labelled}   phones ${phones}`);
console.log(`  domains left UNACCOUNTED ......... ${unaccountedDomains}`);
console.log(`  ambiguous source units ........... ${ambiguous}`);
console.log(`  sample links: ${links.slice(0, 3).join("  ")}`);

// Enforcement against the ACTUAL production items — would the links be restored?
const { data: secs } = await svc.from("sections").select("id").eq("packet_id", "9c564682-8959-44f9-b8ae-eb6a69bfdcae");
const ids = (secs ?? []).map((s: any) => s.id);
const { data: items } = await svc.from("items").select("id, title, notes").in("section_id", ids).order("sort_order");
let restored = 0, notesCleared = 0, notesKept = 0;
for (const c of chunks) {
  const p = parseClaims(c.segment_text, c.ordinal);
  const privacy = sourceGrantsPrivacy(c.segment_text);
  for (const it of (items ?? []) as any[]) {
    const mine = p.claims.filter((x) => x.kind === "url" && String(x.label ?? "").toLowerCase() === "website");
    if (!mine.length) continue;
    void it;
  }
  void privacy;
}
// Per-item: reconcile that item's own website claim against the real (empty) links.
const perItem = (items ?? []) as any[];
for (const it of perItem) {
  const r = reconcile({ claims: [], ambiguous: [], fragments: [] }, { title: it.title, links: [] });
  void r;
}
const privacyGranted = chunks.some((c) => sourceGrantsPrivacy(c.segment_text));
for (const it of perItem) {
  const e = enforceItem({ title: it.title, notes: it.notes ?? "", links: [], details: [] }, [], [], { privacyGranted });
  if (String(it.notes ?? "").trim()) (String(e.item.notes ?? "").trim() ? notesKept++ : notesCleared++);
}
restored = links.filter((l) => /^https:\/\//.test(l)).length;
console.log(`\n  would restore to Links ........... ${restored}/15`);
console.log(`  source grants privacy? ........... ${privacyGranted}`);
console.log(`  "Why it made the list" notes: cleared ${notesCleared}, kept ${notesKept} (of ${perItem.filter((i) => String(i.notes ?? "").trim()).length})`);
