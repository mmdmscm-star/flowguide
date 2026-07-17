// Static contract proof for the resilient-ingestion RPCs (migration 0012). The
// migration isn't applied in this slice, so — like block-item-rpc.test.mts — this
// asserts the guarantees from the SQL text. LIVE runtime proof runs against
// disposable data once the migration is applied.
// Run: node --test src/lib/ingestion-rpc.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mig = readFileSync(join(root, "supabase/migrations/0012_ingestion_runs.sql"), "utf8");
const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");
const FNS = ["block_publish_during_ingest", "create_ingestion_run", "stage_chunk_result", "mark_chunk_failed", "split_chunk", "finalize_ingestion_run", "discard_ingestion_run"];
const GRANTED = FNS.filter((f) => f !== "block_publish_during_ingest"); // trigger fn is not granted

function fnBody(sql: string, name: string): string {
  const s = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(s, -1, `${name} not found`);
  const e = sql.indexOf("\n$$;", s);
  return sql.slice(s, e);
}

test("migration is one explicit transaction (all-or-nothing DDL)", () => {
  const stmts = mig.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
  assert.equal(stmts[0], "begin;");
  assert.equal(stmts[stmts.length - 1], "commit;");
});

test("tables + identity/continuation/baseline columns + packet lifecycle marker", () => {
  assert.match(mig, /create table if not exists public\.ingestion_runs/);
  assert.match(mig, /create table if not exists public\.ingestion_chunks/);
  assert.match(mig, /alter table public\.ingestion_runs enable row level security/);
  assert.match(mig, /alter table public\.ingestion_chunks enable row level security/);
  assert.match(mig, /unique index[\s\S]*idx_ingestion_runs_one_active[\s\S]*where status in \('active','finalizing'\)/, "one active run per packet");
  assert.match(mig, /unique \(run_id, ordinal\)/, "stable chunk identity");
  assert.match(mig, /is_continuation boolean not null default false/, "deterministic continuation flag");
  assert.match(mig, /baseline_section_count int not null default 0/, "content baseline");
  assert.match(mig, /baseline_item_count int not null default 0/);
  assert.match(mig, /alter table public\.packets add column if not exists origin_ingestion_run_id uuid/, "explicit lifecycle marker");
});

test("publish is blocked at the DB while a run is active (trigger, not client-only)", () => {
  const b = fnBody(mig, "block_publish_during_ingest");
  assert.match(b, /new\.status = 'published' and old\.status is distinct from 'published'/, "only on publish transition");
  assert.match(b, /status in \('active','finalizing'\)[\s\S]*?raise exception/, "raises when a run is active");
  assert.match(mig, /create trigger trg_block_publish_during_ingest\s+before update on public\.packets/, "trigger installed");
});

test("all RPCs SECURITY DEFINER + hardened search_path; content RPCs granted only to service_role", () => {
  for (const fn of FNS) {
    const b = fnBody(mig, fn);
    assert.match(b, /security definer/, `${fn} SECURITY DEFINER`);
    assert.match(b, /set search_path = ''/, `${fn} search_path`);
  }
  for (const fn of GRANTED) {
    const grants = mig.split("\n").filter((l) => new RegExp(`on function public\\.${fn}\\(`).test(l));
    assert.equal(grants.length, 2, `${fn}: one revoke + one grant`);
    assert.ok(grants.some((l) => /^revoke all/.test(l)) && grants.some((l) => /^grant execute/.test(l) && /service_role/.test(l)), `${fn}: service-role-only`);
  }
  // the trigger function is NOT granted execute to any role (invoked by the trigger)
  assert.equal(mig.split("\n").filter((l) => /grant execute on function public\.block_publish_during_ingest/.test(l)).length, 0);
});

test("create_ingestion_run verifies owner/draft/legacy-mode/section, captures baseline, marks origin", () => {
  const b = fnBody(mig, "create_ingestion_run");
  assert.match(b, /from public\.packets where id = p_packet_id for update/);
  assert.match(b, /v_user <> p_owner[\s\S]*?raise exception/, "owner");
  assert.match(b, /v_status <> 'draft'[\s\S]*?raise exception/, "draft");
  assert.match(b, /v_mode <> 'legacy'[\s\S]*?raise exception/, "organize/append require legacy mode");
  assert.match(b, /does not belong to packet/, "target section validated");
  assert.match(b, /baseline_section_count, baseline_item_count/, "baseline persisted");
  assert.match(b, /origin_ingestion_run_id = v_run_id[\s\S]*?origin_ingestion_run_id is null/, "origin marked only when unclaimed");
});

test("stage_chunk_result: idempotent, hash-checked, serialized, counts once", () => {
  const b = fnBody(mig, "stage_chunk_result");
  assert.match(b, /from public\.ingestion_runs where id = p_run_id for update/, "run-row lock");
  assert.match(b, /segment_hash <> p_segment_hash[\s\S]*?raise exception/, "hash integrity");
  assert.match(b, /status = 'completed'[\s\S]*?'reused',true/, "already-completed -> reused");
  assert.match(b, /completed_chunks = completed_chunks \+ 1/, "counts once");
});

test("split_chunk: depth limit, marks parent split, carries continuation flag, grows leaf total", () => {
  const b = fnBody(mig, "split_chunk");
  assert.match(b, /split_depth >= 4[\s\S]*?raise exception/);
  assert.match(b, /status = 'split'/);
  assert.match(b, /is_continuation/, "children carry continuation flag");
  assert.match(b, /total_chunks = total_chunks \+ \(v_added - 1\)/);
});

test("finalize: atomic, content-baseline check, coverage, CONTINUATION recombination (never by title), clears staged", () => {
  const b = fnBody(mig, "finalize_ingestion_run");
  assert.ok(!/\bexception\s+when\b/i.test(b), "no exception handler (rolls back)");
  assert.match(b, /from public\.ingestion_runs where id = p_run_id for update/, "locks run");
  assert.match(b, /from public\.packets where id = v_run\.packet_id for update/, "locks packet");
  assert.match(b, /v_pstatus <> 'draft'[\s\S]*?raise exception/, "draft only");
  // content-change detection (revision marker)
  assert.match(b, /v_cur_sections <> v_run\.baseline_section_count or v_cur_items <> v_run\.baseline_item_count[\s\S]*?raise exception/, "refuses if content changed since run began");
  // coverage/completeness
  assert.match(b, /status <> 'split' order by source_start/);
  assert.match(b, /coverage gap\/overlap/);
  assert.match(b, /do not cover the whole source/);
  // recombination by the DETERMINISTIC continuation flag, NOT by title equality
  assert.match(b, /v_first_sec and leaf\.is_continuation and v_last_section is not null/, "merge only on continuation flag");
  assert.ok(!/v_last_title/.test(b), "no title-tracking variable (no title-based merge)");
  assert.ok(!/=\s*coalesce\(v_last_title|sec->>'title'\s*=\s*coalesce/.test(b), "sections never merged by comparing titles");
  // canonical writes
  assert.match(b, /insert into public\.sections/);
  assert.match(b, /insert into public\.item_contacts \(item_id,name,role,phone,email,website,sort_order\)/);
  // privacy cleanup in the same transaction
  assert.match(b, /status = 'finalized', finalized_at = now\(\), source_text = null/);
  assert.match(b, /update public\.ingestion_chunks set result = null, segment_text = null/);
});

test("discard: clears staged; deletes packet ONLY under strict explicit conditions", () => {
  const b = fnBody(mig, "discard_ingestion_run");
  assert.match(b, /status='discarded', source_text=null/);
  assert.match(b, /update public\.ingestion_chunks set result=null, segment_text=null/);
  // ALL conditions required before deleting the draft
  assert.match(b, /entry_point = 'organize'/);
  assert.match(b, /v_origin = p_run_id/, "packet was created for THIS run");
  assert.match(b, /v_pstatus = 'draft'/, "still a draft");
  assert.match(b, /v_secs = 0 and v_items = 0 and v_blocks = 0/, "no canonical/user content");
  assert.match(b, /delete from public\.packets where id = v_run\.packet_id/);
});

test("migration/schema parity: every function body is byte-identical", () => {
  for (const fn of FNS) assert.equal(fnBody(schema, fn), fnBody(mig, fn), `${fn} identical in schema.sql`);
});
