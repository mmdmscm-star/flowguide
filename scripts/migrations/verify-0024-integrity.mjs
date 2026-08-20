// 0024 INTEGRITY — offline, no database.
//
// 0024 re-issues two live functions, so the same discipline as 0021 and 0023
// applies: prove the bodies are the applied ones plus exactly the intended edit,
// mechanically, rather than by reading them.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (p) => readFileSync(p, "utf8");
const M = read("supabase/migrations/0024_ingestion_evidence_retention.sql");
// Comments and the verify block both NAME the things they forbid; absence scans
// must run against executable code only. Fifth time this pattern has mattered.
const CODE = M.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const BODIES = CODE.slice(0, CODE.indexOf("do $verify$"));
const VERIFY = M.slice(M.indexOf("do $verify$"));

let failed = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail && !c ? ` — ${detail}` : ""}`);
  if (!c) failed++;
};
console.log(`\n0024 integrity  sha256=${createHash("sha256").update(M).digest("hex")}\n`);

// ---------------------------------------------------------------------------
// The two re-issued functions are the applied bodies plus only the intended edit
// ---------------------------------------------------------------------------
function extract(text, name, tag) {
  const i = text.indexOf(`create or replace function public.${name}(`);
  if (i < 0) throw new Error(`not found: ${name}`);
  const j = text.indexOf(`\n${tag};`, i);
  return text.slice(i, j + `\n${tag};`.length);
}
const SOURCES = [
  { name: "library_save_proposal", tag: "$lsp$", from: "supabase/migrations/0021_library_import_proposals.sql",
    added: ["origin_run_id, origin_chunk_ordinal, origin_item_index", "p_run_id, v_p.ordinal, v_p.idx"] },
  { name: "library_close_import_run", tag: "$lci$", from: "supabase/migrations/0022_library_import_lifecycle.sql",
    added: ["evidence_purge_after = now() + interval '30 days'", "if p_status = 'finalized' then"] },
];
for (const s of SOURCES) {
  const original = extract(read(s.from), s.name, s.tag);
  const embedded = extract(M, s.name, s.tag);
  const stripComments = (t) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  for (const a of s.added) ok(embedded.includes(a), `${s.name}: adds ${a.slice(0, 46)}`);

  // Everything the edit did NOT touch must still be present verbatim: the
  // ownership, destination and idempotency guards are the point of these
  // functions and must not have drifted while the tail was rewritten.
  const guards = original.split("\n").filter((l) =>
    /raise exception|if v_run\.|if v_p\.id is null|return jsonb_build_object|get diagnostics/.test(l));
  const missing = guards.filter((g) => !embedded.includes(g.trim()));
  ok(missing.length === 0, `${s.name}: every guard from the applied body survives`,
     missing.slice(0, 2).join(" || "));

  // And no line was silently dropped beyond the block we meant to replace.
  const origLines = stripComments(original).split("\n").map((l) => l.trim()).filter(Boolean);
  const newLines = new Set(stripComments(embedded).split("\n").map((l) => l.trim()).filter(Boolean));
  const dropped = origLines.filter((l) => !newLines.has(l));
  const allowed = s.name === "library_save_proposal"
    ? 2   // the two lines the insert rewrote
    : 8;  // the clearing block, re-indented inside the if/else
  ok(dropped.length <= allowed, `${s.name}: at most ${allowed} original lines replaced`,
     `${dropped.length} dropped: ${dropped.slice(0, 3).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// Behaviour the migration must have
// ---------------------------------------------------------------------------
ok(/if p_status = 'finalized' then[\s\S]*?else[\s\S]*?source_text = null/.test(CODE),
   "finalize keeps the source; only the discard branch clears it");
ok(/create extension if not exists pg_cron/.test(CODE), "pg_cron install is idempotent");
ok(/cron\.unschedule\(/.test(CODE) && /cron\.schedule\(/.test(CODE),
   "the job is unscheduled before scheduling, so re-running is a no-op");
ok(/add column if not exists/.test(CODE), "columns are added idempotently");
ok(/drop constraint if exists library_items_origin_coherent/.test(CODE),
   "the coherence constraint is dropped before being added");
ok(/drop trigger if exists trg_library_clear_origin/.test(CODE),
   "the trigger is dropped before being created");
ok(/before delete on public\.ingestion_runs/.test(CODE),
   "the triplet is cleared BEFORE the FK's own action, or deleting a run would fail the CHECK");
ok(/\(origin_run_id is null\) = \(origin_chunk_ordinal is null\)/.test(CODE)
   && /\(origin_run_id is null\) = \(origin_item_index is null\)/.test(CODE),
   "the triplet is all-or-nothing");

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------
const purge = M.slice(M.indexOf("create or replace function public.purge_ingestion_evidence"), M.indexOf("$pie$;") + 6);
ok(!/library_items/.test(purge.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")),
   "the purge cannot touch saved Library entries");
ok(/evidence_purge_after = null/.test(purge), "and is idempotent: a purged run is never selected again");
ok(!/insert into public\.(packets|sections|items)\b/.test(BODIES), "no packet composition is created");
ok(!/itemsOnlyPrompt|prompt|classif/i.test(BODIES),
   "no prompt, routing or classification change rides along");
ok(!/i?like '%[^']*_[^']*%'/.test(VERIFY),
   "no LIKE pattern in the verify block contains an underscore — _ is a wildcard there");
ok(/regexp_replace\(p\.prosrc, '--\[\^\\n\]\*', '', 'g'\)/.test(VERIFY),
   "source assertions in the verify block strip comments first");
ok(/cron\.job where jobname = 'flowguide-purge-ingestion-evidence' and active/.test(VERIFY),
   "apply-time verification proves the schedule exists, so retention is a policy rather than a claim");
ok(/a policy appeared on an evidence table/.test(VERIFY),
   "and that no RLS policy appeared on any table holding evidence");

for (const n of ["purge_ingestion_evidence", "library_save_proposal", "library_close_import_run"]) {
  ok(new RegExp(`grant execute on function public\\.${n}\\(`).test(M) &&
     new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated, service_role;`).test(M),
     `${n}: service_role only`);
}
console.log(`\n${failed === 0 ? "INTEGRITY OK" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
