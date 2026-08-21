import { readFileSync } from "node:fs";
import { parseClaims } from "../../src/lib/claim-parser.ts";
import { buildRunChunks } from "../../src/lib/ingestion.ts";
const src = readFileSync("/tmp/icecream-source.txt", "utf8");

// 1. SOURCE — how is a Website actually written?
const lines = src.split("\n");
const wi = lines.findIndex((l) => l.trim() === "Website");
console.log("SOURCE SHAPE around a Website field:");
for (let i = wi - 4; i <= wi + 2; i++) console.log(`   ${String(i).padStart(3)}: ${JSON.stringify(lines[i])}`);

const domains = src.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org)\b/gi) ?? [];
console.log(`\nbare domains in source: ${domains.length}  e.g. ${domains.slice(0, 3).join(", ")}`);
console.log(`scheme-qualified URLs in source: ${(src.match(/https?:\/\//gi) ?? []).length}`);

// 2. CLAIMS — what does the deterministic parser recognize?
const chunks = buildRunChunks(src);
let labelled = 0, urls = 0, phones = 0, emails = 0, ambiguous = 0;
const websiteFragments: string[] = [];
for (const c of chunks) {
  const p = parseClaims(c.segment_text, c.ordinal);
  labelled += p.claims.filter((x) => x.kind === "labelled").length;
  urls += p.claims.filter((x) => x.kind === "url").length;
  phones += p.claims.filter((x) => x.kind === "phone").length;
  emails += p.claims.filter((x) => x.kind === "email").length;
  ambiguous += p.ambiguous.length;
  for (const f of p.fragments)
    if (/\.(com|net|org)\b/i.test(f.text) || f.text.trim() === "Website") websiteFragments.push(`${f.reason}: ${f.text.slice(0, 44)}`);
}
console.log(`\nCLAIMS ACROSS ${chunks.length} CHUNKS`);
console.log(`   labelled ${labelled}   url ${urls}   phone ${phones}   email ${emails}   ambiguous ${ambiguous}`);
console.log(`\nWEBSITE-RELATED UNITS — what the parser does with them (${websiteFragments.length}):`);
for (const f of [...new Set(websiteFragments)].slice(0, 6)) console.log(`   ${f}`);
