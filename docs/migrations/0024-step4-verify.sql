-- 0024 STEP 4 — POST-APPLY VERIFICATION.
--
-- WRITES NOTHING. One transaction ending in ROLLBACK. It creates a disposable
-- user, runs, chunks, proposals and Library entries, because retention and
-- traceability can only be proven by producing and then finishing a real import.
-- None of it commits.
--
-- Read the last column. EVERY row must be ok = true. READ ROW 0 FIRST.
--
-- Expected body hashes are generated mechanically from the applied migrations.

begin;

create temp table v24 (n int, check_name text, expected text, actual text, ok boolean) on commit drop;
create temp table expected_body (proname text primary key, md5 text) on commit drop;
insert into expected_body values
  ('update_item_content', '7a3312aa742a74bae46742fc54be4418'),
  ('claim_chunk', 'f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result', '1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed', 'a8fb32eef936a61405220661c221a48c'),
  ('split_chunk', 'db8e798dcbed4fb9c4e30c2b00317bcb'),
  ('finalize_ingestion_run', 'e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run', 'ba0545d9bea5926905adbdb436df3247'),
  ('create_library_import_run', '125d2df8015f704377399ab665ea9e2f'),
  ('library_materialize_proposals', 'df006c498ea0b94480454fb4ea331727'),
  ('library_canonical_photos', '982e77eb31abd2ad31924a029343f7ed'),
  ('library_copy_into_section', 'fe7dab27c2cae14903f635f23191e455'),
  ('create_packet_from_library', '4886536ace5366c6dcca84322ecba168'),
  ('library_save_proposal', 'e7cb8a2b3eedd0a05d2dbd93541dfbe0'),
  ('library_close_import_run', '64b0ad3ce0f41e521c291a4f63ba1d0d'),
  ('purge_ingestion_evidence', 'a10c9f4bf2c1bc71290ba513ca3c7ff3'),
  ('library_clear_origin_on_run_delete', 'f8e889e1d70ca6438c7c248aa361eec7');
create temp table fx (k text primary key, v text) on commit drop;

insert into v24
select 0, 'earlier verification steps rolled back cleanly', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0;

-- ===========================================================================
-- A. STRUCTURE
-- ===========================================================================
insert into v24
select 1, 'ingestion_runs.evidence_purge_after exists', 'timestamptz, nullable',
       coalesce((select data_type || ', nullable=' || is_nullable from information_schema.columns
                  where table_schema='public' and table_name='ingestion_runs'
                    and column_name='evidence_purge_after'), 'MISSING'),
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='ingestion_runs'
                  and column_name='evidence_purge_after' and data_type like 'timestamp%');

insert into v24
select 2, 'library_items carries the full origin triplet', 'all three',
       (select coalesce(string_agg(column_name || ':' || data_type, ', ' order by column_name), 'MISSING')
          from information_schema.columns
         where table_schema='public' and table_name='library_items'
           and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')),
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='library_items'
           and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')) = 3;

insert into v24
select 3, 'the coherence CHECK covers all three columns', 'all three named',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid='public.library_items'::regclass
                    and conname='library_items_origin_coherent'), 'MISSING'),
       coalesce((select pg_get_constraintdef(oid) ~ 'origin_run_id'
                    and pg_get_constraintdef(oid) ~ 'origin_chunk_ordinal'
                    and pg_get_constraintdef(oid) ~ 'origin_item_index'
                   from pg_constraint where conrelid='public.library_items'::regclass
                    and conname='library_items_origin_coherent'), false);

insert into v24
select 4, 'the clearing trigger is BEFORE DELETE on ingestion_runs', 'present, BEFORE',
       coalesce((select t.tgname || ' type=' || t.tgtype::text from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                  where c.relname='ingestion_runs' and t.tgname='trg_library_clear_origin'
                    and not t.tgisinternal), 'MISSING'),
       exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname='ingestion_runs' and t.tgname='trg_library_clear_origin'
                  and not t.tgisinternal and (t.tgtype & 2) <> 0 and (t.tgtype & 8) <> 0);

-- ===========================================================================
-- B. THE SCHEDULE — retention is a policy only if this exists
-- ===========================================================================
insert into v24
select 5, 'pg_cron is installed', 'installed',
       coalesce((select 'v' || extversion from pg_extension where extname='pg_cron'), 'NOT INSTALLED'),
       exists (select 1 from pg_extension where extname='pg_cron');

insert into v24
select 6, 'the daily purge job exists and is ACTIVE', 'active, 17 3 * * *, calls purge_ingestion_evidence',
       coalesce((select 'schedule=' || j.schedule || ' active=' || j.active::text || ' cmd=' || left(j.command, 60)
                   from cron.job j where j.jobname='flowguide-purge-ingestion-evidence'), 'NOT SCHEDULED'),
       coalesce((select j.active and j.schedule = '17 3 * * *' and j.command ~ 'purge_ingestion_evidence'
                   from cron.job j where j.jobname='flowguide-purge-ingestion-evidence'), false);

insert into v24
select 7, 'exactly one such job — re-running 0024 did not stack duplicates', '1',
       (select count(*)::text from cron.job where jobname='flowguide-purge-ingestion-evidence'),
       (select count(*) from cron.job where jobname='flowguide-purge-ingestion-evidence') = 1;

-- ===========================================================================
-- C. BODIES — what 0024 changed, and everything it must not have
-- ===========================================================================
insert into v24
select 9 + row_number() over (order by e.proname),
       'body md5 == source: ' || e.proname, e.md5,
       coalesce(md5(p.prosrc), 'FUNCTION MISSING'),
       coalesce(md5(p.prosrc) = e.md5, false)
  from expected_body e
  left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname='public')
    on p.proname = e.proname;

-- ===========================================================================
-- D. PRIVILEGES — evidence stays service-role only
-- ===========================================================================
insert into v24
select 30, 'the new functions are service_role only with search_path pinned EMPTY',
       'all clean',
       (select coalesce(string_agg(p.proname || '[' ||
                 coalesce(array_to_string(p.proconfig, ','), 'none') || ']', ', ' order by p.proname), 'MISSING')
          from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in
           ('purge_ingestion_evidence','library_clear_origin_on_run_delete')),
       (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') in ('search_path=', 'search_path=""')
                    and p.proacl is not null
                    and array_to_string(p.proacl,' ') !~ '(^| )=X'
                    and array_to_string(p.proacl,' ') not like '%anon=X%'
                    and array_to_string(p.proacl,' ') not like '%authenticated=X%')
          from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in
           ('purge_ingestion_evidence','library_clear_origin_on_run_delete'));

insert into v24
select 31, 'no RLS policy exists on any table holding evidence', '0 policies',
       (select coalesce(string_agg(tablename || '=' || cnt::text, ', ') , 'none') from (
          select c.relname as tablename,
                 (select count(*) from pg_policies pp where pp.schemaname='public' and pp.tablename=c.relname) cnt
            from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname in
             ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals')) t),
       not exists (select 1 from pg_policies where schemaname='public'
                    and tablename in ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals'));

-- ===========================================================================
-- E. BEHAVIOUR
-- ===========================================================================
do $fx$
declare a uuid; res jsonb; run uuid; src text; pid uuid; lib uuid;
begin
  insert into public.users(email) values ('0024-verify@disposable.invalid') returning id into a;
  insert into fx values ('a', a::text);

  -- A source whose two chunk spans are exact substrings, so the span check below
  -- is a real reconstruction rather than a coincidence.
  src := 'Brookdale Chanate. 3800 Chanate Rd. Assisted living and memory care.'
      || 'Oakmont of Villa Capri. 1300 Fountaingrove Pkwy. Independent living.';
  insert into fx values ('src', src);

  res := public.create_library_import_run(a, src, 'hash-0024', length(src), 'seg-v4',
    jsonb_build_array(
      jsonb_build_object('ordinal',0,'source_start',0,'source_end',68,
        'segment_text', substr(src,1,68), 'segment_hash','h0','section_hint','','is_continuation',false),
      jsonb_build_object('ordinal',1,'source_start',68,'source_end',length(src),
        'segment_text', substr(src,69), 'segment_hash','h1','section_hint','','is_continuation',false)));
  run := (res->>'run_id')::uuid;
  insert into fx values ('run', run::text);

  -- Simulate a completed extraction: staged model output per chunk.
  update public.ingestion_chunks set status='completed',
         result = jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('title','Brookdale Chanate','address','3800 Chanate Rd')))
   where run_id = run and ordinal = 0;
  update public.ingestion_chunks set status='completed',
         result = jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('title','Oakmont of Villa Capri','address','1300 Fountaingrove Pkwy')))
   where run_id = run and ordinal = 1;

  perform public.library_materialize_proposals(a, run);
  select id into pid from public.library_import_proposals
   where run_id = run and ordinal = 1 and idx = 0;
  lib := public.library_save_proposal(a, run, pid);
  insert into fx values ('lib', lib::text);
end
$fx$;

-- ---- E1. saving records the coordinates --------------------------------------
insert into v24
select 32, 'a saved entry records which run, chunk and item produced it',
       'run matches, ordinal 1, index 0',
       coalesce((select 'run=' || (li.origin_run_id = (select v::uuid from fx where k='run'))::text ||
                        ' ordinal=' || li.origin_chunk_ordinal::text ||
                        ' index=' || li.origin_item_index::text
                   from public.library_items li where li.id = (select v::uuid from fx where k='lib')), 'MISSING'),
       coalesce((select li.origin_run_id = (select v::uuid from fx where k='run')
                    and li.origin_chunk_ordinal = 1 and li.origin_item_index = 0
                   from public.library_items li where li.id = (select v::uuid from fx where k='lib')), false);

-- ---- E2. finishing RETAINS the evidence and stamps an expiry ------------------
do $finish$
declare a uuid; run uuid; r record; nchunks int;
begin
  select v::uuid into a from fx where k='a'; select v::uuid into run from fx where k='run';
  perform public.library_close_import_run(a, run, 'finalized');

  select * into r from public.ingestion_runs where id = run;
  select count(*) into nchunks from public.ingestion_chunks
   where run_id = run and result is not null and segment_text is not null;

  insert into v24 values (33,
    'FINISHING KEEPS THE EVIDENCE — source, segments and model results all survive',
    'source present, 2 chunks with result+segment',
    'source=' || (r.source_text is not null)::text || ' chunks_with_evidence=' || nchunks::text,
    r.source_text is not null and nchunks = 2);

  insert into v24 values (34, 'and stamps a retention expiry about 30 days out',
    'between 29 and 31 days from now',
    coalesce(r.evidence_purge_after::text, 'null'),
    r.evidence_purge_after is not null
      and r.evidence_purge_after > now() + interval '29 days'
      and r.evidence_purge_after < now() + interval '31 days');
end
$finish$;

-- ---- E3. TRACEABILITY: saved entry -> model result -> source span -------------
do $trace$
declare lib uuid; li record; r record; c record; model jsonb; span text;
begin
  select v::uuid into lib from fx where k='lib';
  select * into li from public.library_items where id = lib;

  -- Walk it the way a diagnosis would, starting from the entry alone.
  select * into r from public.ingestion_runs where id = li.origin_run_id;
  select * into c from public.ingestion_chunks
   where run_id = li.origin_run_id and ordinal = li.origin_chunk_ordinal;
  model := c.result->'items'->li.origin_item_index;

  insert into v24 values (35,
    'TRACEABLE: a saved entry reaches the exact model output that produced it',
    'title matches the model item',
    coalesce(model->>'title', '<no model item>') || ' vs saved ' || li.title,
    model is not null and model->>'title' = li.title);

  -- The chunk's span must really slice the retained source.
  span := substr(r.source_text, c.source_start + 1, c.source_end - c.source_start);
  insert into v24 values (36,
    'and the chunk span reconstructs from the retained source, not merely stored beside it',
    'substr(source, start, len) = segment_text',
    left(span, 40) || ' | ' || left(c.segment_text, 40),
    span = c.segment_text);

  insert into v24 values (37, 'the original source is recoverable in full', 'matches what was pasted',
    length(r.source_text)::text || ' chars',
    r.source_text = (select v from fx where k='src'));
end
$trace$;

-- ---- E4. the triplet is all-or-nothing ---------------------------------------
do $coh$
declare lib uuid;
begin
  select v::uuid into lib from fx where k='lib';
  begin
    update public.library_items set origin_run_id = null where id = lib;
    insert into v24 values (38, 'clearing ONE origin column is rejected', 'raises', 'accepted — half state allowed', false);
  exception when others then
    insert into v24 values (38, 'clearing ONE origin column is rejected', 'raises', sqlerrm, sqlerrm ~ 'origin_coherent');
  end;
end
$coh$;

-- ---- E5. PURGE clears evidence and leaves the entry alone ---------------------
do $purge$
declare a uuid; run uuid; lib uuid; before_title text; before_rev bigint; n int;
        after_src text; after_chunks int; li record;
begin
  select v::uuid into a from fx where k='a'; select v::uuid into run from fx where k='run';
  select v::uuid into lib from fx where k='lib';
  select title, revision into before_title, before_rev from public.library_items where id = lib;

  -- Move this run's expiry into the past, as thirty days would.
  update public.ingestion_runs set evidence_purge_after = now() - interval '1 minute' where id = run;
  n := public.purge_ingestion_evidence();

  select source_text into after_src from public.ingestion_runs where id = run;
  select count(*) into after_chunks from public.ingestion_chunks
   where run_id = run and (result is not null or segment_text is not null);

  insert into v24 values (39, 'the purge clears retained evidence once the window passes',
    'source null, 0 chunks holding evidence, 1 run purged',
    'source=' || coalesce(after_src,'null') || ' chunks=' || after_chunks::text || ' runs=' || n::text,
    after_src is null and after_chunks = 0 and n = 1);

  select * into li from public.library_items where id = lib;
  insert into v24 values (40,
    'and does NOT mutate or delete the saved Library entry',
    'same title, same revision, still present',
    coalesce(li.title,'GONE') || ' rev=' || coalesce(li.revision::text,'-'),
    li.id is not null and li.title = before_title and li.revision = before_rev);

  insert into v24 values (41,
    'the coordinates survive the purge, because the run and chunk rows do',
    'triplet intact',
    'run=' || (li.origin_run_id = run)::text || ' ordinal=' || coalesce(li.origin_chunk_ordinal::text,'null'),
    li.origin_run_id = run and li.origin_chunk_ordinal = 1 and li.origin_item_index = 0);

  n := public.purge_ingestion_evidence();
  insert into v24 values (42, 'purging again is a no-op', '0 runs', n::text, n = 0);
end
$purge$;

-- ---- E6. DISCARD still clears immediately ------------------------------------
do $discard$
declare a uuid; res jsonb; run2 uuid; src2 text; r record; nch int;
begin
  select v::uuid into a from fx where k='a';
  src2 := 'Third community. 500 Example Rd. Memory care only.';
  res := public.create_library_import_run(a, src2, 'hash-0024b', length(src2), 'seg-v4',
    jsonb_build_array(jsonb_build_object('ordinal',0,'source_start',0,'source_end',length(src2),
      'segment_text', src2, 'segment_hash','h','section_hint','','is_continuation',false)));
  run2 := (res->>'run_id')::uuid;
  update public.ingestion_chunks set status='completed',
         result = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('title','Third community')))
   where run_id = run2;

  perform public.library_close_import_run(a, run2, 'discarded');
  select * into r from public.ingestion_runs where id = run2;
  select count(*) into nch from public.ingestion_chunks
   where run_id = run2 and (result is not null or segment_text is not null);

  insert into v24 values (43,
    'DISCARD still clears everything immediately, and retains nothing',
    'source null, 0 chunks with evidence, no expiry stamp',
    'source=' || coalesce(r.source_text,'null') || ' chunks=' || nch::text ||
      ' expiry=' || coalesce(r.evidence_purge_after::text,'null'),
    r.source_text is null and nch = 0 and r.evidence_purge_after is null);
end
$discard$;

-- ---- E7. deleting a run clears the whole triplet atomically -------------------
do $del$
declare lib uuid; run uuid; li record;
begin
  select v::uuid into lib from fx where k='lib'; select v::uuid into run from fx where k='run';
  begin
    delete from public.ingestion_runs where id = run;
    select * into li from public.library_items where id = lib;
    insert into v24 values (44,
      'deleting a run clears all three origin columns together, and the entry survives',
      'entry present, triplet all null',
      coalesce(li.title,'ENTRY GONE') || ' run=' || coalesce(li.origin_run_id::text,'null') ||
        ' ord=' || coalesce(li.origin_chunk_ordinal::text,'null') ||
        ' idx=' || coalesce(li.origin_item_index::text,'null'),
      li.id is not null and li.origin_run_id is null
        and li.origin_chunk_ordinal is null and li.origin_item_index is null);
  exception when others then
    insert into v24 values (44,
      'deleting a run clears all three origin columns together, and the entry survives',
      'succeeds', 'DELETE FAILED: ' || sqlerrm, false);
  end;
end
$del$;

-- ===========================================================================
select n, check_name, expected, actual, ok from v24 order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as result,
       (count(*) filter (where not ok)) = 0 as all_green from v24;

-- NOTHING ABOVE IS KEPT.
rollback;
