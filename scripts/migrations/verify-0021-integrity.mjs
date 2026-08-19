// 0021 INTEGRITY — offline, no database.
//
// 0021 re-issues two live functions. The only real risk in doing that is a
// transcription error inside 167 lines of the most consequential SQL in the
// product. This proves there was none: it re-extracts each function from the
// migration that currently defines it, removes the guard block from 0021's
// copy, and requires the remainder to be BYTE-FOR-BYTE identical.
//
//   node scripts/migrations/verify-0021-integrity.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const read = (p) => readFileSync(p, "utf8");

function extract(text, header) {
  const i = text.indexOf(header);
  if (i < 0) throw new Error(`not found: ${header}`);
  const j = text.indexOf("\n$$;", i);
  if (j < 0) throw new Error(`unterminated: ${header}`);
  return text.slice(i, j + "\n$$;".length);
}

// 0021 wraps its bodies in $lsp$ for the new function but keeps $$ for the two
// replacements, so the same extractor works on both files.
const SOURCES = [
  { name: "finalize_ingestion_run",
    from: "supabase/migrations/0014_item_ingestion_provenance.sql",
    header: "create or replace function public.finalize_ingestion_run(" },
  { name: "discard_ingestion_run",
    from: "supabase/migrations/0012_ingestion_runs.sql",
    header: "create or replace function public.discard_ingestion_run(" },
];

const GUARD = `
  -- 0021 GUARD. A LIBRARY run must never enter the packet path.
  --
  -- It would already fail without this: \`from public.packets where id = null\`
  -- returns no row and the next check raises 'packet not found'. But that is an
  -- accident of a lookup, not a stated rule, and it is indistinguishable from a
  -- genuinely deleted packet. Library imports finish through their own path and
  -- never create packet, section or item composition structures.
  if v_run.destination <> 'packet' then
    raise exception 'ingestion: run % has destination % and cannot use the packet path',
      p_run_id, v_run.destination;
  end if;
`;

const M21 = read("supabase/migrations/0021_library_import_proposals.sql");
let failed = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};

console.log("\n0021 integrity — embedded function bodies\n");

// The files 0021 was built from must themselves be untouched.
for (const f of ["supabase/migrations/0012_ingestion_runs.sql",
                 "supabase/migrations/0014_item_ingestion_provenance.sql"]) {
  console.log(`  note  ${f.split("/").pop()} sha256=${sha(read(f))}`);
}

for (const s of SOURCES) {
  const original = extract(read(s.from), s.header);
  const embedded = extract(M21, s.header);

  ok(embedded.includes(GUARD), `${s.name}: the guard block is present verbatim`);

  const stripped = embedded.replace(GUARD, "");
  ok(stripped === original,
     `${s.name}: everything else is byte-for-byte the applied definition`,
     `${stripped.length} bytes vs ${original.length}`);

  // Belt and braces: exactly one guard, and it sits after the ownership check.
  const anchor = "if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;";
  ok(embedded.split("cannot use the packet path").length - 1 === 1,
     `${s.name}: exactly one guard, not a duplicated paste`);
  ok(embedded.indexOf(anchor) < embedded.indexOf("v_run.destination <> 'packet'"),
     `${s.name}: the guard runs AFTER the ownership check`);
  console.log(`        original sha256=${sha(original)}`);
}

// The new function must not have been quietly given a different shape.
ok(M21.includes("create or replace function public.library_save_proposal("),
   "library_save_proposal is defined");
ok(/delete from public\.library_import_proposals where id = p_proposal_id;/.test(M21),
   "the proposal delete is present");
const lsp = M21.slice(M21.indexOf("create or replace function public.library_save_proposal("));
const body = lsp.slice(0, lsp.indexOf("$lsp$;"));
ok(body.indexOf("insert into public.library_items") < body.indexOf("delete from public.library_import_proposals"),
   "the insert precedes the delete, inside one function body");
// Scoped to the CREATE TABLE block: the prose above it says "there is NO
// library_item_id column", and a naive whole-file match reads its own comment.
const ddl = M21.slice(M21.indexOf("create table if not exists public.library_import_proposals"),
                      M21.indexOf("create index if not exists library_import_proposals_run_idx"));
ok(!/library_item_id/.test(ddl),
   "no library_item_id bookkeeping column was smuggled into the table");
ok(/unique \(run_id, ordinal, idx\)/.test(ddl),
   "the proposal identity key is (run_id, ordinal, idx)");
ok(!/create or replace function public\.(claim_chunk|stage_chunk_result|mark_chunk_failed|split_chunk)\(/.test(M21),
   "0021 does not touch the chunk engine");

console.log(`\n${failed === 0 ? "INTEGRITY OK" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
