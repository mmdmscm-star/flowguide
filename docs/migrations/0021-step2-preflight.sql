-- 0021 STEP 2 — PREFLIGHT. STRICTLY READ ONLY.
--
-- (Step 1 is the offline integrity check, which needs no database:
--    node scripts/migrations/verify-0021-integrity.mjs )
--
-- Nothing here creates, alters, drops or writes anything. Every row must be
-- ok = true before 0021 is applied.
--
-- Rows 6 and 7 are the ones to read closely. They record what
-- finalize_ingestion_run and discard_ingestion_run hash to RIGHT NOW, and
-- confirm neither yet carries the guard — so after 0021 we can say the guard
-- appeared here and nowhere else. Unlike 0020, these two hashes are EXPECTED to
-- change; they are captured so the change is attributable, not so it is refused.

select 1 as n, '0020 is applied: destination column present' as check_name,
       'present, not null, default packet' as expected,
       coalesce((select is_nullable || ' / ' || coalesce(column_default,'(none)')
                 from information_schema.columns
                 where table_schema='public' and table_name='ingestion_runs'
                   and column_name='destination'), 'MISSING — apply 0020 first') as actual,
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='ingestion_runs'
                 and column_name='destination' and is_nullable='NO') as ok
union all
select 2, 'both 0020 one-active indexes exist', '2',
       (select count(*)::text from pg_indexes where schemaname='public'
         and indexname in ('idx_ingestion_runs_one_active_packet','idx_ingestion_runs_one_active_library')),
       (select count(*) from pg_indexes where schemaname='public'
         and indexname in ('idx_ingestion_runs_one_active_packet','idx_ingestion_runs_one_active_library')) = 2
union all
select 3, 'library_import_proposals is absent (0021 creates it)', 'absent',
       coalesce(to_regclass('public.library_import_proposals')::text, 'absent'),
       to_regclass('public.library_import_proposals') is null
union all
select 4, 'library_save_proposal is absent (0021 creates it)', 'absent',
       coalesce((select 'ALREADY PRESENT' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='library_save_proposal' limit 1), 'absent'),
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='library_save_proposal')
union all
select 5, 'library_items exists (library_save_proposal writes to it)', 'present',
       coalesce(to_regclass('public.library_items')::text, 'MISSING — STOP'),
       to_regclass('public.library_items') is not null
union all
select 6, 'finalize_ingestion_run: pre-0021 md5, guard NOT yet present',
       'no guard',
       (select md5(pg_get_functiondef(p.oid)) || ' guard=' ||
               (pg_get_functiondef(p.oid) ilike '%cannot use the packet path%')::text
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='finalize_ingestion_run'),
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='finalize_ingestion_run'
                     and pg_get_functiondef(p.oid) ilike '%cannot use the packet path%')
union all
select 7, 'discard_ingestion_run: pre-0021 md5, guard NOT yet present',
       'no guard',
       (select md5(pg_get_functiondef(p.oid)) || ' guard=' ||
               (pg_get_functiondef(p.oid) ilike '%cannot use the packet path%')::text
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='discard_ingestion_run'),
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='discard_ingestion_run'
                     and pg_get_functiondef(p.oid) ilike '%cannot use the packet path%')
union all
-- Replacing these two functions takes a brief lock. With no run in flight there
-- is nothing to disrupt; if this is non-zero, wait rather than interrupt an
-- import mid-flight.
select 8, 'no ingestion run is in flight right now', '0',
       (select count(*)::text from public.ingestion_runs
         where status in ('active','finalizing','needs_review')),
       (select count(*) from public.ingestion_runs
         where status in ('active','finalizing','needs_review')) = 0
union all
select 9, 'the chunk engine is untouched and intact', '4 functions',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')),
       (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')) = 4
order by n;
