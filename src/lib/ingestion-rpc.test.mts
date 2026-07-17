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
const FNS = ["create_ingestion_run", "stage_chunk_result", "mark_chunk_failed", "split_chunk", "finalize_ingestion_run", "discard_ingestion_run"];

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

test("both tables exist with RLS enabled; identity + coverage constraints present", () => {
  assert.match(mig, /create table if not exists public\.ingestion_runs/);
  assert.match(mig, /create table if not exists public\.ingestion_chunks/);
  assert.match(mig, /alter table public\.ingestion_runs enable row level security/);
  assert.match(mig, /alter table public\.ingestion_chunks enable row level security/);
  // at most one active/finalizing run per packet
  assert.match(mig, /unique index[\s\S]*idx_ingestion_runs_one_active[\s\S]*where status in \('active','finalizing'\)/);
  // stable chunk identity per (run, ordinal)
  assert.match(mig, /unique \(run_id, ordinal\)/);
  // staged columns that must be cleared later
  assert.match(mig, /source_text text/);
  assert.match(mig, /result jsonb/);
});

test("all RPCs are SECURITY DEFINER, hardened search_path, and granted only to service_role", () => {
  for (const fn of FNS) {
    const b = fnBody(mig, fn);
    assert.match(b, /security definer/, `${fn} SECURITY DEFINER`);
    assert.match(b, /set search_path = ''/, `${fn} search_path`);
    const grants = mig.split("\n").filter((l) => new RegExp(`on function public\\.${fn}\\(`).test(l));
    assert.equal(grants.length, 2, `${fn}: one revoke + one grant`);
    assert.ok(grants.some((l) => /^revoke all/.test(l)) && grants.some((l) => /^grant execute/.test(l) && /service_role/.test(l)), `${fn}: service-role-only`);
  }
});

test("create_ingestion_run verifies owner + draft + section-belongs-to-packet", () => {
  const b = fnBody(mig, "create_ingestion_run");
  assert.match(b, /from public\.packets where id = p_packet_id for update/, "locks packet");
  assert.match(b, /v_user <> p_owner[\s\S]*?raise exception/, "owner check");
  assert.match(b, /v_status <> 'draft'[\s\S]*?raise exception/, "draft check");
  assert.match(b, /section_append[\s\S]*?does not belong to packet/, "target section validated");
});

test("stage_chunk_result is idempotent, hash-checked, and serialized", () => {
  const b = fnBody(mig, "stage_chunk_result");
  assert.match(b, /from public\.ingestion_runs where id = p_run_id for update/, "run-row lock serializes concurrent posts");
  assert.match(b, /segment_hash <> p_segment_hash[\s\S]*?raise exception/, "segment hash integrity");
  assert.match(b, /status = 'completed'[\s\S]*?return jsonb_build_object\('status','completed'[\s\S]*?'reused',true\)/, "already-completed -> reused no-op");
  assert.match(b, /completed_chunks = completed_chunks \+ 1/, "counts a fresh completion once");
  assert.match(b, /status = 'split'[\s\S]*?raise exception/, "reject a superseded chunk");
});

test("split_chunk enforces a depth limit and grows the leaf total", () => {
  const b = fnBody(mig, "split_chunk");
  assert.match(b, /split_depth >= 4[\s\S]*?raise exception/, "recoverable depth limit");
  assert.match(b, /status = 'split'/, "parent marked split");
  assert.match(b, /total_chunks = total_chunks \+ \(v_added - 1\)/, "progress total reflects new leaves");
});

test("finalize is atomic, verifies coverage, applies once, and CLEARS staged material", () => {
  const b = fnBody(mig, "finalize_ingestion_run");
  // atomic: no exception handler that could commit partial work
  assert.ok(!/\bexception\s+when\b/i.test(b), "no exception handler (any failure rolls back)");
  assert.match(b, /from public\.ingestion_runs where id = p_run_id for update/, "locks run");
  assert.match(b, /from public\.packets where id = v_run\.packet_id for update/, "locks packet");
  assert.match(b, /v_pstatus <> 'draft'[\s\S]*?raise exception/, "draft only");
  assert.match(b, /status <> 'finalized'[\s\S]*?reused',true|status = 'finalized'[\s\S]*?reused',true/, "idempotent re-finalize");
  // completeness/coverage over leaf chunks
  assert.match(b, /status <> 'split' order by source_start/, "iterate leaves in order");
  assert.match(b, /coverage gap\/overlap/, "reject gaps/overlaps");
  assert.match(b, /do not cover the whole source/, "reject incomplete coverage");
  assert.match(b, /not completed/, "reject unfinished chunk");
  // canonical writes for all entry points + no published packet touched (draft-only)
  assert.match(b, /insert into public\.sections/, "creates sections (organize/append)");
  assert.match(b, /insert into public\.items/, "creates items");
  assert.match(b, /insert into public\.item_contacts \(item_id,name,role,phone,email,website,sort_order\)/, "contacts preserved");
  // privacy cleanup in the same transaction
  assert.match(b, /status = 'finalized', finalized_at = now\(\), source_text = null/, "clears run source on finalize");
  assert.match(b, /update public\.ingestion_chunks set result = null, segment_text = null/, "clears staged results on finalize");
});

test("discard clears staged material and removes an empty organize draft", () => {
  const b = fnBody(mig, "discard_ingestion_run");
  assert.match(b, /status='discarded', source_text=null/, "clears run source");
  assert.match(b, /update public\.ingestion_chunks set result=null, segment_text=null/, "clears staged results");
  assert.match(b, /entry_point = 'organize'[\s\S]*?delete from public\.packets where id = v_run\.packet_id and status = 'draft'/, "removes orphan empty organize draft");
});

test("migration/schema parity: every RPC body is byte-identical", () => {
  for (const fn of FNS) assert.equal(fnBody(schema, fn), fnBody(mig, fn), `${fn} identical in schema.sql`);
});
