// 0023 INTEGRITY — offline, no database.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (p) => readFileSync(p, "utf8");
const M = read("supabase/migrations/0023_create_packet_from_library.sql");
// Comments explain invariants and quote the things they forbid; scanning the
// whole file has matched that prose three times in this workstream already.
const CODE = M.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
// And the migration's own verify block NAMES the things it forbids, so scans
// that assert an absence must run against the function bodies only. Fourth time
// this pattern has bitten in this workstream: an assertion that forbids a string
// will match the code written to forbid it. Scope the scan; never loosen it.
const BODIES = CODE.slice(0, CODE.indexOf("do $verify$"));
const VERIFY = M.slice(M.indexOf("do $verify$"));

let failed = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail && !c ? ` — ${detail}` : ""}`);
  if (!c) failed++;
};
console.log(`\n0023 integrity  sha256=${createHash("sha256").update(M).digest("hex")}\n`);

const defined = [...M.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
const EXPECTED = ["library_canonical_photos", "library_copy_into_section", "create_packet_from_library"];
ok(JSON.stringify(defined) === JSON.stringify(EXPECTED), "defines exactly the three intended functions", defined.join(", "));

const prior = new Set();
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql") && !f.startsWith("0023"))) {
  for (const m of read(`supabase/migrations/${f}`).matchAll(/create or replace function public\.(\w+)\(/g)) prior.add(m[1]);
}
ok(defined.every((n) => !prior.has(n)), "none collides with an existing function",
   defined.filter((n) => prior.has(n)).join(", "));
ok(!/\balter table\b/i.test(CODE) && !/\bdrop (table|index|constraint|function|trigger)\b/i.test(CODE),
   "no table, index, constraint or function is altered or dropped");

// ---- the atomicity claim ---------------------------------------------------
const copy = M.slice(M.indexOf("create or replace function public.library_copy_into_section("), M.indexOf("$lcs$;") + 6);
const create = M.slice(M.indexOf("create or replace function public.create_packet_from_library("), M.indexOf("$cpf$;") + 6);

ok(!/\bdelete from public\.packets\b/.test(BODIES),
   "nothing compensates by deleting a packet — the transaction is the guarantee");
ok(/perform public\.library_copy_into_section\(/.test(create) || /:= public\.library_copy_into_section\(/.test(create),
   "the create path delegates copying rather than restating it");
ok(/raise exception/.test(create), "a create that copies nothing raises rather than returning an empty FlowGuide");

// ---- reuse, not reinterpretation -------------------------------------------
ok(/perform public\.update_item_content\(/.test(copy),
   "content is written by the canonical writer both editors already use");
ok(!/insert into public\.item_(details|links|photos|contacts)/.test(BODIES),
   "no second content-write path is introduced");
ok((CODE.match(/case\s+when jsonb_typeof\(e\.value\) = 'string'/g) ?? []).length === 1,
   "photo shape is interpreted in exactly ONE place");
ok(/public\.library_canonical_photos\(src\.photos\)/.test(copy),
   "and the copy path uses it");

// ---- the requirements ------------------------------------------------------
ok(/user_id = p_owner/.test(copy) && /v_found <> array_length/.test(copy),
   "every chosen entry must exist and belong to the owner, or the call fails");
ok(/library_item_id, library_item_revision/.test(copy) && /src\.id, src\.revision/.test(copy),
   "lineage is written as both columns together");
ok(!/origin_run_id|origin_chunk_ordinal|emit_index/.test(BODIES),
   "no ingestion provenance is fabricated");
ok(/search_path=', 'search_path=""/.test(VERIFY),
   "the migration asserts an EMPTY search_path at apply time, not merely a present one");
ok(/origin_run_id/.test(VERIFY) && /update_item_content/.test(VERIFY),
   "and the migration's own verify block still guards both at apply time");
ok(/unnest\(p_library_item_ids\) with ordinality/.test(copy),
   "the professional's selection ORDER is preserved");
// EQUIVALENCE WITH THE ORDINARY BLANK CREATE. Both set exactly user_id, slug,
// title and client_name; everything else comes from column defaults. Restating a
// default would be a second declaration of what a new FlowGuide is.
const insert = create.slice(create.indexOf("insert into public.packets"), create.indexOf("returning id into v_packet"));
ok(/\(user_id, slug, title, client_name\)/.test(insert),
   "the packet insert sets the same columns as the blank-create path");
for (const col of ["status", "composition_mode", "packet_type", "identity_mode", "content_rev", "raw_input"]) {
  ok(!new RegExp(`\\b${col}\\b`).test(insert), `${col} is left to its column default, not restated`);
}
ok(/v_status <> 'draft'/.test(create) && /v_mode <> 'legacy'/.test(create),
   "but the resulting defaults are ASSERTED, so a changed default fails loudly");
ok(/unique_violation/.test(create),
   "a taken slug surfaces as a collision the caller can retry, as the blank path does");
ok(!/publish/i.test(BODIES), "nothing publishes");

for (const n of EXPECTED) {
  const sig = n === "library_canonical_photos" ? "jsonb"
    : n === "library_copy_into_section" ? "uuid, uuid, uuid, uuid\\[\\]" : "uuid, text, text, text, uuid\\[\\]";
  ok(new RegExp(`revoke all on function public\\.${n}\\(${sig}\\) from public, anon, authenticated, service_role;`).test(M)
     && new RegExp(`grant execute on function public\\.${n}\\(${sig}\\) to service_role;`).test(M),
     `${n}: revoked from all, granted only to service_role`);
  const head = M.slice(M.indexOf(`create or replace function public.${n}(`));
  const decl = head.slice(0, head.indexOf("as $"));
  ok(/set search_path = ''/.test(decl), `${n}: search_path pinned EMPTY`);
  ok(n === "library_canonical_photos" ? /immutable/.test(decl) : /security definer/.test(decl),
     `${n}: ${n === "library_canonical_photos" ? "immutable pure coercion" : "security definer"}`);
}
console.log(`\n${failed === 0 ? "INTEGRITY OK" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
