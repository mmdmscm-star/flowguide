-- 0024 STEP 4 — DETAILS ONLY. STRICTLY READ ONLY.
--
-- No transaction, no fixtures, no writes, nothing created or dropped. This
-- re-derives every assertion that can be read from the CURRENT applied state,
-- and returns them as ONE result set so the editor shows it.
--
-- WHAT THIS CANNOT SHOW, and why: rows 32-44 of the full verifier were
-- BEHAVIOURAL. They created an import, finished it, traced it, purged it and
-- deleted its run — all inside a transaction that ended in ROLLBACK. Those rows
-- were computed against fixtures that no longer exist, so they cannot be
-- re-derived by reading. Their result is already known: the run you completed
-- reported 39 passed, 0 failed, so every one of them passed.

with expected(proname, md5) as (values
  ('update_item_content','7a3312aa742a74bae46742fc54be4418'),
  ('claim_chunk','f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result','1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed','a8fb32eef936a61405220661c221a48c'),
  ('split_chunk','db8e798dcbed4fb9c4e30c2b00317bcb'),
  ('finalize_ingestion_run','e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run','ba0545d9bea5926905adbdb436df3247'),
  ('create_library_import_run','125d2df8015f704377399ab665ea9e2f'),
  ('library_materialize_proposals','df006c498ea0b94480454fb4ea331727'),
  ('library_canonical_photos','982e77eb31abd2ad31924a029343f7ed'),
  ('library_copy_into_section','fe7dab27c2cae14903f635f23191e455'),
  ('create_packet_from_library','4886536ace5366c6dcca84322ecba168'),
  ('library_save_proposal','e7cb8a2b3eedd0a05d2dbd93541dfbe0'),
  ('library_close_import_run','64b0ad3ce0f41e521c291a4f63ba1d0d'),
  ('purge_ingestion_evidence','a10c9f4bf2c1bc71290ba513ca3c7ff3'),
  ('library_clear_origin_on_run_delete','f8e889e1d70ca6438c7c248aa361eec7')
)
select * from (

  select 0 as n, 'earlier verification steps rolled back cleanly' as check_name,
         '0 stray users' as expected,
         (select count(*)::text from public.users where email like '00%-verify%') as actual,
         (select count(*) from public.users where email like '00%-verify%') = 0 as ok
  union all
  select 1, 'ingestion_runs.evidence_purge_after exists', 'timestamptz, nullable',
         coalesce((select data_type || ', nullable=' || is_nullable from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs'
                      and column_name='evidence_purge_after'), 'MISSING'),
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='ingestion_runs'
                    and column_name='evidence_purge_after' and data_type like 'timestamp%')
  union all
  select 2, 'library_items carries the full origin triplet', 'all three',
         (select coalesce(string_agg(column_name || ':' || data_type, ', ' order by column_name), 'MISSING')
            from information_schema.columns
           where table_schema='public' and table_name='library_items'
             and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')),
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='library_items'
             and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')) = 3
  union all
  select 3, 'the coherence CHECK covers all three columns', 'all three named',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid='public.library_items'::regclass
                      and conname='library_items_origin_coherent'), 'MISSING'),
         coalesce((select pg_get_constraintdef(oid) ~ 'origin_run_id'
                      and pg_get_constraintdef(oid) ~ 'origin_chunk_ordinal'
                      and pg_get_constraintdef(oid) ~ 'origin_item_index'
                     from pg_constraint where conrelid='public.library_items'::regclass
                      and conname='library_items_origin_coherent'), false)
  union all
  select 4, 'the clearing trigger is BEFORE DELETE on ingestion_runs', 'present, BEFORE, DELETE',
         coalesce((select t.tgname || ' type=' || t.tgtype::text from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                    where c.relname='ingestion_runs' and t.tgname='trg_library_clear_origin'
                      and not t.tgisinternal), 'MISSING'),
         exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname='ingestion_runs' and t.tgname='trg_library_clear_origin'
                    and not t.tgisinternal and (t.tgtype & 2) <> 0 and (t.tgtype & 8) <> 0)
  union all
  select 5, 'pg_cron is installed', 'installed',
         coalesce((select 'v' || extversion from pg_extension where extname='pg_cron'), 'NOT INSTALLED'),
         exists (select 1 from pg_extension where extname='pg_cron')
  union all
  select 6, 'the daily purge job exists and is ACTIVE', 'active, 17 3 * * *, calls purge_ingestion_evidence',
         coalesce((select 'schedule=' || j.schedule || ' active=' || j.active::text || ' cmd=' || left(j.command, 60)
                     from cron.job j where j.jobname='flowguide-purge-ingestion-evidence'), 'NOT SCHEDULED'),
         coalesce((select j.active and j.schedule = '17 3 * * *' and j.command ~ 'purge_ingestion_evidence'
                     from cron.job j where j.jobname='flowguide-purge-ingestion-evidence'), false)
  union all
  select 7, 'exactly one such job — re-running 0024 did not stack duplicates', '1',
         (select count(*)::text from cron.job where jobname='flowguide-purge-ingestion-evidence'),
         (select count(*) from cron.job where jobname='flowguide-purge-ingestion-evidence') = 1
  union all
  select 8, 'the index supporting provenance lookups exists', 'library_items_origin_idx',
         coalesce((select indexname from pg_indexes where schemaname='public'
                    and tablename='library_items' and indexname='library_items_origin_idx'), 'MISSING'),
         exists (select 1 from pg_indexes where schemaname='public'
                  and tablename='library_items' and indexname='library_items_origin_idx')
  union all
  -- body hashes: twelve that must be unchanged, four that 0024 created or re-issued
  select 9 + row_number() over (order by e.proname), 'body md5 == source: ' || e.proname, e.md5,
         coalesce(md5(p.prosrc), 'FUNCTION MISSING'),
         coalesce(md5(p.prosrc) = e.md5, false)
    from expected e
    left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname='public')
      on p.proname = e.proname
  union all
  select 30, 'the new functions are service_role only with search_path pinned EMPTY', 'all clean',
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
             ('purge_ingestion_evidence','library_clear_origin_on_run_delete'))
  union all
  select 31, 'no RLS policy exists on any table holding evidence', '0 policies',
         (select coalesce(string_agg(tablename || '=' || cnt::text, ', ') , 'none') from (
            select c.relname as tablename,
                   (select count(*) from pg_policies pp where pp.schemaname='public' and pp.tablename=c.relname) cnt
              from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relname in
               ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals')) t),
         not exists (select 1 from pg_policies where schemaname='public'
                      and tablename in ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals'))
  union all
  -- Current retention state, for context rather than pass/fail.
  select 45, 'runs currently holding retained evidence', 'reference row, always true',
         coalesce((select string_agg(left(r.id::text,8) || ' ' || r.status ||
                    ' expires=' || coalesce(r.evidence_purge_after::text,'none') ||
                    ' src=' || case when r.source_text is null then 'cleared'
                                    else pg_size_pretty(length(r.source_text)::bigint) end,
                    ' | ' order by r.created_at)
              from public.ingestion_runs r where r.destination='library'), 'no library runs'),
         true
  union all
  select 46, 'Library entries carrying provenance coordinates', 'reference row, always true',
         (select count(*) filter (where origin_run_id is not null)::text || ' of ' || count(*)::text ||
                 ' entries have an origin' from public.library_items),
         true
) t order by n;
