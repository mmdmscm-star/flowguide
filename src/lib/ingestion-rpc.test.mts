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
const TRIG = ["ingest_bump_by_packet", "ingest_bump_by_section", "ingest_bump_by_item", "ingest_bump_packet_self", "block_publish_during_ingest"];
const RPC = ["create_ingestion_run", "create_organize_run", "claim_chunk", "stage_chunk_result", "mark_chunk_failed", "split_chunk", "finalize_ingestion_run", "discard_ingestion_run"];

function fnBody(sql: string, name: string): string {
  const s = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(s, -1, `${name} not found`);
  const e = sql.indexOf("\n$$;", s);
  return sql.slice(s, e);
}

test("migration is one explicit transaction", () => {
  const stmts = mig.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
  assert.equal(stmts[0], "begin;");
  assert.equal(stmts[stmts.length - 1], "commit;");
});

test("packet columns + run/chunk columns for revision, offset unit, continuation, lifecycle", () => {
  assert.match(mig, /alter table public\.packets add column if not exists content_rev bigint not null default 0/);
  assert.match(mig, /alter table public\.packets add column if not exists origin_ingestion_run_id uuid/);
  assert.match(mig, /source_len int not null default 0/, "JS-unit source length");
  assert.match(mig, /baseline_content_rev bigint not null default 0/);
  assert.match(mig, /is_continuation boolean not null default false/);
  assert.match(mig, /unique index[\s\S]*idx_ingestion_runs_one_active[\s\S]*where status in \('active','finalizing'\)/);
  assert.match(mig, /unique \(run_id, ordinal\)/);
});

test("content_rev is bumped by DB triggers on every canonical table (not UI-only)", () => {
  for (const t of ["sections", "packet_blocks", "items", "item_details", "item_links", "item_photos", "item_contacts"]) {
    assert.match(mig, new RegExp(`create trigger trg_ingest_rev_\\w+ after insert or update or delete on public\\.${t}`), `${t} bump trigger`);
  }
  assert.match(mig, /create trigger trg_ingest_rev_packet_self before update on public\.packets/, "packet self-edit bump");
  // the bump does an update packets that needs the packet row lock (mutual exclusion w/ finalize)
  assert.match(fnBody(mig, "ingest_bump_by_item"), /update public\.packets set content_rev = content_rev \+ 1 where id = pid/);
  // packet self-edit bumps on content/composition columns
  assert.match(fnBody(mig, "ingest_bump_packet_self"), /new\.title, new\.client_name[\s\S]*is distinct from[\s\S]*new\.content_rev := old\.content_rev \+ 1/);
});

test("publish blocked at DB while a run is active", () => {
  const b = fnBody(mig, "block_publish_during_ingest");
  assert.match(b, /new\.status = 'published' and old\.status is distinct from 'published'/);
  assert.match(b, /status in \('active','finalizing'\)[\s\S]*?raise exception/);
  assert.match(mig, /create trigger trg_block_publish_during_ingest before update on public\.packets/);
});

test("ALL functions SECURITY DEFINER + hardened search_path", () => {
  for (const fn of [...TRIG, ...RPC]) {
    const b = fnBody(mig, fn);
    assert.match(b, /security definer/, `${fn} definer`);
    assert.match(b, /set search_path = ''/, `${fn} search_path`);
  }
});

test("trigger functions revoked from PUBLIC + named roles, and never granted", () => {
  for (const fn of TRIG) {
    const rev = mig.split("\n").filter((l) => l.startsWith(`revoke all on function public.${fn}(`));
    const gr = mig.split("\n").filter((l) => new RegExp(`grant execute on function public\\.${fn}\\(`).test(l));
    assert.equal(rev.length, 1, `${fn} revoked once`);
    assert.match(rev[0], /from public, anon, authenticated, service_role/, `${fn} revoked from PUBLIC + roles`);
    assert.equal(gr.length, 0, `${fn} never granted`);
  }
});

test("callable RPCs are service-role-only with exact signatures", () => {
  const sig: Record<string, string> = {
    create_ingestion_run: "(uuid, uuid, text, uuid, text, text, int, text, jsonb)",
    create_organize_run: "(uuid, text, text, text, text, int, text, jsonb)",
    claim_chunk: "(uuid, uuid, int, int)",
    stage_chunk_result: "(uuid, uuid, int, text, jsonb)",
    mark_chunk_failed: "(uuid, uuid, int, text)",
    split_chunk: "(uuid, uuid, int, jsonb)",
    finalize_ingestion_run: "(uuid, uuid)",
    discard_ingestion_run: "(uuid, uuid)",
  };
  for (const fn of RPC) {
    const rev = mig.split("\n").filter((l) => l.startsWith(`revoke all on function public.${fn}(`));
    const gr = mig.split("\n").filter((l) => l.startsWith(`grant execute on function public.${fn}(`));
    assert.ok(rev.length === 1 && rev[0].includes(sig[fn]) && rev[0].includes("from public, anon, authenticated, service_role"), `${fn} revoke`);
    assert.ok(gr.length === 1 && gr[0].includes(sig[fn]) && gr[0].includes("to service_role"), `${fn} grant`);
  }
});

test("create_organize_run creates packet + run + chunks + origin marker atomically", () => {
  const b = fnBody(mig, "create_organize_run");
  assert.match(b, /insert into public\.packets[\s\S]*returning id into v_packet/, "creates the packet");
  assert.match(b, /insert into public\.ingestion_runs[\s\S]*returning id into v_run/, "creates the run");
  assert.match(b, /insert into public\.ingestion_chunks/, "creates the chunk plan");
  assert.match(b, /update public\.packets set origin_ingestion_run_id = v_run/, "sets the origin marker");
});

test("create_ingestion_run (append/section_append) captures baseline_content_rev + source_len", () => {
  const b = fnBody(mig, "create_ingestion_run");
  assert.match(b, /create_ingestion_run is for append\/section_append/, "organize excluded");
  assert.match(b, /content_rev into v_user, v_status, v_mode, v_rev/, "reads current rev");
  assert.match(b, /baseline_content_rev[\s\S]*v_rev/, "stores baseline rev");
  assert.match(b, /source_len/, "stores source_len");
});

test("claim_chunk is atomic: locks run+chunk, single attempt++, lease recovery, rejects live claims", () => {
  const b = fnBody(mig, "claim_chunk");
  assert.match(b, /from public\.ingestion_runs where id = p_run_id for update/, "locks run");
  assert.match(b, /from public\.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal for update/, "locks chunk row");
  assert.match(b, /status = 'completed' then return jsonb_build_object\('claimed', false/, "completed not claimable");
  assert.match(b, /status = 'split' then return jsonb_build_object\('claimed', false/, "split not claimable");
  assert.match(b, /status = 'processing'[\s\S]*make_interval\(secs => p_lease_seconds\) > now\(\)[\s\S]*'claimed', false/, "live processing not stolen (lease)");
  assert.match(b, /set status = 'processing', attempt_count = attempt_count \+ 1/, "claims + counts the attempt exactly once");
});

test("stage/mark do NOT double-count the attempt (claim owns it)", () => {
  assert.ok(!/attempt_count = attempt_count \+ 1/.test(fnBody(mig, "stage_chunk_result")), "stage does not increment attempt");
  assert.ok(!/attempt_count = attempt_count \+ 1/.test(fnBody(mig, "mark_chunk_failed")), "mark_failed does not increment attempt");
  assert.match(fnBody(mig, "stage_chunk_result"), /status = 'completed'[\s\S]*'reused',true/, "stage idempotent");
});

test("split_chunk is idempotent (already-split returns) and depth-limited", () => {
  const b = fnBody(mig, "split_chunk");
  assert.match(b, /status = 'split' then return jsonb_build_object\('added', 0, 'alreadySplit', true\)/, "idempotent");
  assert.match(b, /split_depth >= 4[\s\S]*raise exception/, "depth limit");
  assert.match(b, /is_continuation/, "children carry continuation flag");
});

test("finalize: atomic, content_rev match, JS-unit coverage (no char_length), continuation merge, full privacy cleanup", () => {
  const b = fnBody(mig, "finalize_ingestion_run");
  assert.ok(!/\bexception\s+when\b/i.test(b), "no exception handler");
  assert.match(b, /from public\.packets where id = v_run\.packet_id for update/, "locks packet");
  assert.match(b, /v_cur_rev <> v_run\.baseline_content_rev[\s\S]*raise exception/, "exact content_rev match required");
  assert.ok(!/char_length/.test(b), "coverage uses stored source_len, never char_length");
  assert.match(b, /v_prev <> v_run\.source_len[\s\S]*raise exception/, "coverage in JS units");
  assert.match(b, /v_first_sec and leaf\.is_continuation and v_last_section is not null/, "continuation merge, not title");
  assert.ok(!/v_last_title/.test(b), "no title-based merge");
  // privacy: clear ALL source-derived fields on finalize
  assert.match(b, /source_text = null, derived_title = '', derived_client_name = '', error = ''/, "run source-derived cleared");
  assert.match(b, /result = null, segment_text = null, section_hint = '', error = ''/, "chunk source-derived cleared");
});

test("discard: clears ALL source-derived fields; deletes packet only under strict conditions", () => {
  const b = fnBody(mig, "discard_ingestion_run");
  assert.match(b, /source_text=null, derived_title='', derived_client_name='', error=''/, "run cleared");
  assert.match(b, /result=null, segment_text=null, section_hint='', error=''/, "chunks cleared");
  assert.match(b, /entry_point = 'organize' and v_origin = p_run_id and v_pstatus = 'draft'[\s\S]*v_secs = 0 and v_items = 0 and v_blocks = 0/, "strict delete");
});

test("migration/schema parity: every function body byte-identical", () => {
  for (const fn of [...TRIG, ...RPC]) assert.equal(fnBody(schema, fn), fnBody(mig, fn), `${fn} identical`);
});
