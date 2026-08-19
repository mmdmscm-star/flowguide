-- 0020 STEP 3 — POST-APPLY VERIFICATION.
--
-- WRITES NOTHING. The whole script runs inside one transaction that ends in
-- ROLLBACK. It does create disposable users, a packet and several runs, because
-- the constraints can only be proven by ATTEMPTING inserts — but none of it
-- commits, so there is nothing to clean up afterwards. If you stop the script
-- early, the open transaction rolls back on disconnect.
--
-- Read the last column. Every row must be ok = true.
--
-- BEFORE RUNNING: check row 0. The three pre-apply hashes captured by Step 1b
-- are declared in ONE place below, marked EXPECTED BASELINE HASHES. Row 0
-- validates those literals are 32-character md5s before anything is compared
-- against them, so a value clipped in transit fails as "bad literal" and can
-- never be mistaken for "the function changed".

begin;

create temp table verify_0020 (
  n int, check_name text, expected text, actual text, ok boolean
) on commit drop;

-- ===========================================================================
-- A. STRUCTURE
-- ===========================================================================
insert into verify_0020
select 1, 'destination column: not null, default packet',
       'NO / ''packet''::text',
       coalesce(is_nullable || ' / ' || coalesce(column_default,'(none)'), 'COLUMN MISSING'),
       is_nullable = 'NO' and column_default like '%packet%'
  from information_schema.columns
 where table_schema='public' and table_name='ingestion_runs' and column_name='destination';

insert into verify_0020
select 2, 'packet_id is now nullable', 'YES', is_nullable, is_nullable = 'YES'
  from information_schema.columns
 where table_schema='public' and table_name='ingestion_runs' and column_name='packet_id';

insert into verify_0020
select 3, 'every pre-existing run is a coherent packet run', '0 bad', count(*)::text || ' bad', count(*) = 0
  from public.ingestion_runs where destination <> 'packet' or packet_id is null;

insert into verify_0020
select 4, 'the 5 pre-existing runs are untouched', 'finalized=5',
       coalesce(string_agg(status || '=' || c, ', ' order by status), '(none)'),
       coalesce(string_agg(status || '=' || c, ', ' order by status), '') = 'finalized=5'
  from (select status, count(*) c from public.ingestion_runs group by status) t;

insert into verify_0020
select 5, 'coherence CHECK definition', 'ties destination to packet_id',
       pg_get_constraintdef(oid),
       pg_get_constraintdef(oid) ilike '%destination%' and pg_get_constraintdef(oid) ilike '%packet_id%'
  from pg_constraint
 where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_destination_coherent';

insert into verify_0020
select 6, 'entry_point CHECK now allows library_import', 'contains library_import',
       pg_get_constraintdef(oid), pg_get_constraintdef(oid) ilike '%library_import%'
  from pg_constraint
 where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_entry_point_check';

insert into verify_0020
select 7, 'library entry-point CHECK exists', 'present',
       pg_get_constraintdef(oid), true
  from pg_constraint
 where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_library_entry_point';

insert into verify_0020
select 8, 'the OLD one-active index is gone', 'absent',
       coalesce((select 'STILL PRESENT' from pg_indexes
                 where schemaname='public' and indexname='idx_ingestion_runs_one_active'), 'absent'),
       not exists (select 1 from pg_indexes
                   where schemaname='public' and indexname='idx_ingestion_runs_one_active');

-- The 0013 guarantee, asserted on the PREDICATE and not on the index name.
insert into verify_0020
select 9, 'packet one-active index still carries needs_review',
       'predicate contains needs_review AND destination',
       coalesce((select indexdef from pg_indexes where schemaname='public'
                  and indexname='idx_ingestion_runs_one_active_packet'), 'MISSING'),
       coalesce((select indexdef ilike '%needs_review%' and indexdef ilike '%destination%'
                 from pg_indexes where schemaname='public'
                  and indexname='idx_ingestion_runs_one_active_packet'), false);

insert into verify_0020
select 10, 'library one-active index is keyed on user_id',
       'btree (user_id), predicate contains needs_review',
       coalesce((select indexdef from pg_indexes where schemaname='public'
                  and indexname='idx_ingestion_runs_one_active_library'), 'MISSING'),
       coalesce((select indexdef ilike '%(user_id)%' and indexdef ilike '%needs_review%'
                 from pg_indexes where schemaname='public'
                  and indexname='idx_ingestion_runs_one_active_library'), false);

-- ===========================================================================
-- B. FUNCTIONS THAT MUST NOT HAVE CHANGED
--
-- 0020 contains no CREATE FUNCTION at all — provable from the hash-pinned file
-- (sha256 d3cd0bc292dda26466dc1ecead8994565afb2dcbc983e9b682e7a0313dc03cd9,
-- 0 matches for "create function"). So none of these should have moved, and
-- all three are compared against their FULL pre-apply hashes from Step 1b.
-- ===========================================================================

-- >>> EXPECTED BASELINE HASHES — captured by Step 1b, before 0020 was applied.
--     This is the only place they appear. If row 0 reports a bad length, correct
--     the value here and re-run; do not adjust the comparison.
create temp table expected_fn_hash (proname text primary key, md5 text) on commit drop;
insert into expected_fn_hash values
  ('block_publish_during_ingest', '81bd995264f693b970a0dae47e5ba2c'),
  ('ingest_invalidate_offsets',   'f7b2581ca96bb9c6d9fe22eef6cb6231'),
  ('move_item_photos',            '3ac9142b7a5868c60cb5b984b55f8010');
-- <<<

-- Row 0 runs FIRST conceptually: it validates the literals themselves. An md5
-- is 32 lowercase hex characters. A clipped paste fails here, loudly, instead of
-- surfacing later as a false "this function changed".
insert into verify_0020
select 0, 'the expected baseline hashes are well-formed md5s',
       'all 3 are 32 hex chars',
       coalesce(string_agg(proname || '=' || length(md5)::text, ', ' order by proname), '(none)'),
       count(*) = 3 and bool_and(md5 ~ '^[0-9a-f]{32}$')
  from expected_fn_hash;

insert into verify_0020
select 11, 'ingest_invalidate_offsets unchanged (full md5)',
       e.md5, md5(pg_get_functiondef(p.oid)),
       md5(pg_get_functiondef(p.oid)) = e.md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join expected_fn_hash e on e.proname = p.proname
 where n.nspname = 'public' and p.proname = 'ingest_invalidate_offsets';

insert into verify_0020
select 12, 'block_publish_during_ingest unchanged (full md5)',
       e.md5, md5(pg_get_functiondef(p.oid)),
       md5(pg_get_functiondef(p.oid)) = e.md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join expected_fn_hash e on e.proname = p.proname
 where n.nspname = 'public' and p.proname = 'block_publish_during_ingest';

insert into verify_0020
select 13, 'move_item_photos unchanged (full md5)',
       e.md5, md5(pg_get_functiondef(p.oid)),
       md5(pg_get_functiondef(p.oid)) = e.md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join expected_fn_hash e on e.proname = p.proname
 where n.nspname = 'public' and p.proname = 'move_item_photos';

insert into verify_0020
select 14, 'no ingestion RPC signature moved', '8 functions, unchanged arguments',
       count(*)::text || ' found', count(*) = 8
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in
   ('create_ingestion_run','create_organize_run','claim_chunk','stage_chunk_result',
    'mark_chunk_failed','split_chunk','finalize_ingestion_run','discard_ingestion_run');

-- ===========================================================================
-- C. BEHAVIOUR — proven by ATTEMPTED INSERTS, never inferred from a name.
-- ===========================================================================
do $probe$
declare
  v_user_a uuid; v_user_b uuid; v_packet uuid; v_run uuid;
begin
  insert into public.users(email) values ('0020-verify-a@disposable.invalid') returning id into v_user_a;
  insert into public.users(email) values ('0020-verify-b@disposable.invalid') returning id into v_user_b;
  insert into public.packets(user_id, slug, title, status, composition_mode, raw_input)
    values (v_user_a, '0020-verify-packet', '0020 verify', 'draft', 'legacy', '')
    returning id into v_packet;

  -- 15. a packet run WITHOUT a packet must be impossible (the old NOT NULL)
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, null, 'packet', 'organize', 'h', 'v4', 'active');
    insert into verify_0020 values (15,'packet run with NULL packet_id','REJECTED','ACCEPTED — the old NOT NULL was lost',false);
  exception when others then
    insert into verify_0020 values (15,'packet run with NULL packet_id','REJECTED','REJECTED',true);
  end;

  -- 16. a library run WITH a packet must be impossible
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, v_packet, 'library', 'library_import', 'h', 'v4', 'active');
    insert into verify_0020 values (16,'library run carrying a packet_id','REJECTED','ACCEPTED',false);
  exception when others then
    insert into verify_0020 values (16,'library run carrying a packet_id','REJECTED','REJECTED',true);
  end;

  -- 17. a library run must use the library entry point
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, null, 'library', 'organize', 'h', 'v4', 'active');
    insert into verify_0020 values (17,'library run with entry_point=organize','REJECTED','ACCEPTED',false);
  exception when others then
    insert into verify_0020 values (17,'library run with entry_point=organize','REJECTED','REJECTED',true);
  end;

  -- 18. and a packet run must not use it
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, v_packet, 'packet', 'library_import', 'h', 'v4', 'active');
    insert into verify_0020 values (18,'packet run with entry_point=library_import','REJECTED','ACCEPTED',false);
  exception when others then
    insert into verify_0020 values (18,'packet run with entry_point=library_import','REJECTED','REJECTED',true);
  end;

  -- 19. a well-formed library run is ACCEPTED (the constraints are not just strict)
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, null, 'library', 'library_import', 'h', 'v4', 'active') returning id into v_run;
    insert into verify_0020 values (19,'a well-formed library run','ACCEPTED','ACCEPTED',true);
  exception when others then
    insert into verify_0020 values (19,'a well-formed library run','ACCEPTED','REJECTED: ' || sqlerrm,false);
  end;

  -- 20. ONE IMPORT PER PROFESSIONAL — second active import, same user
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, null, 'library', 'library_import', 'h2', 'v4', 'active');
    insert into verify_0020 values (20,'SECOND active library import, same professional','REJECTED','ACCEPTED — unlimited imports',false);
  exception when others then
    insert into verify_0020 values (20,'SECOND active library import, same professional','REJECTED','REJECTED',true);
  end;

  -- 21. needs_review is non-terminal for a library run too
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_a, null, 'library', 'library_import', 'h3', 'v4', 'needs_review');
    insert into verify_0020 values (21,'library import while one is needs_review','REJECTED','ACCEPTED',false);
  exception when others then
    insert into verify_0020 values (21,'library import while one is needs_review','REJECTED','REJECTED',true);
  end;

  -- 22. the index constrains the RIGHT thing: a DIFFERENT professional may import
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
      values (v_user_b, null, 'library', 'library_import', 'h', 'v4', 'active');
    insert into verify_0020 values (22,'a DIFFERENT professional may import concurrently','ACCEPTED','ACCEPTED',true);
  exception when others then
    insert into verify_0020 values (22,'a DIFFERENT professional may import concurrently','ACCEPTED','REJECTED: ' || sqlerrm,false);
  end;

  -- 23. a packet run coexists with a library run (the two rules are independent)
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status,
                                      baseline_content_rev)
      values (v_user_a, v_packet, 'packet', 'organize', 'h', 'v4', 'active', 0);
    insert into verify_0020 values (23,'a packet run alongside this user''s library run','ACCEPTED','ACCEPTED',true);
  exception when others then
    insert into verify_0020 values (23,'a packet run alongside this user''s library run','ACCEPTED','REJECTED: ' || sqlerrm,false);
  end;

  -- 24. THE 0013 GUARANTEE: second non-terminal run on the SAME packet, and
  --     specifically in needs_review — the exact regression this design nearly shipped.
  begin
    insert into public.ingestion_runs(user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status,
                                      baseline_content_rev)
      values (v_user_a, v_packet, 'packet', 'append', 'h2', 'v4', 'needs_review', 0);
    insert into verify_0020 values (24,'SECOND packet run on one packet (needs_review)','REJECTED','ACCEPTED — 0013 REGRESSED',false);
  exception when others then
    insert into verify_0020 values (24,'SECOND packet run on one packet (needs_review)','REJECTED','REJECTED',true);
  end;
end
$probe$;

-- ===========================================================================
-- D. WHY THE LIBRARY INDEX IS KEYED ON user_id AND NOT packet_id.
--
-- Demonstrated on a throwaway temp table, so the real table is never touched:
-- a unique index over a nullable column does NOT constrain NULL rows, because
-- Postgres treats NULLs as distinct. Had library runs been left under the
-- packet-keyed index, unlimited simultaneous imports would have been legal.
-- ===========================================================================
create temp table null_demo (packet_id uuid, status text) on commit drop;
create unique index null_demo_uq on null_demo(packet_id) where status = 'active';

do $nulls$
declare v_n int;
begin
  insert into null_demo values (null,'active'), (null,'active'), (null,'active');
  select count(*) into v_n from null_demo;
  insert into verify_0020 values (
    25, 'a unique index does NOT constrain NULL keys (why user_id was used)',
    '3 rows accepted', v_n::text || ' rows accepted', v_n = 3);
exception when others then
  insert into verify_0020 values (25,'a unique index does NOT constrain NULL keys',
    '3 rows accepted','REJECTED: ' || sqlerrm, false);
end
$nulls$;

-- ===========================================================================
select n, check_name, expected, actual, ok from verify_0020 order by n;

select count(*) filter (where ok) || ' passed, ' ||
       count(*) filter (where not ok) || ' failed' as result,
       (count(*) filter (where not ok)) = 0 as all_green
  from verify_0020;

-- NOTHING ABOVE IS KEPT.
rollback;
