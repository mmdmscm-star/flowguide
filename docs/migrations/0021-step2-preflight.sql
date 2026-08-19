-- 0021 STEP 2 — PREFLIGHT. STRICTLY READ ONLY.
--
-- (Step 1 is the offline integrity check, which needs no database:
--    node scripts/migrations/verify-0021-integrity.mjs )
--
-- Nothing here creates, alters, drops or writes anything. EVERY ROW MUST BE
-- ok = true. If any is false, DO NOT APPLY 0021.
--
-- ===========================================================================
-- WHY ROWS 1 AND 2 ARE THE WHOLE POINT
--
-- The integrity script proves 0021 equals the migration-file definitions plus
-- the guard. That says nothing about PRODUCTION. If the live body has drifted
-- from the file for any reason — a hand-run CREATE OR REPLACE, a hotfix, a
-- partially applied migration — then applying 0021 would silently overwrite
-- that live behaviour with an older body. These two rows refuse that.
--
-- They compare pg_proc.prosrc, NOT pg_get_functiondef. Postgres stores the
-- function BODY verbatim in prosrc, but reconstructs the header from catalog
-- metadata when rendering functiondef — uppercased keywords, SET search_path TO
-- '', AS $function$ — so a functiondef comparison against a lower-case source
-- file can never match and would have to be fuzzy. prosrc is exact. The header
-- is checked separately in rows 3 and 4, from the catalog fields that define it.
--
-- The expected hashes below were computed mechanically from the same extraction
-- the integrity script performs, and that script re-derives them and fails if
-- these literals ever drift from the source files.
--
--   finalize_ingestion_run  <- 0014_item_ingestion_provenance.sql
--   discard_ingestion_run   <- 0012_ingestion_runs.sql
-- ===========================================================================

select 1 as n,
       'LIVE finalize_ingestion_run body == 0014 source (fail closed on drift)' as check_name,
       '81633731dcd07ca3fd2fdc3690bbeba4' as expected,
       coalesce((select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'finalize_ingestion_run'),
                'FUNCTION MISSING') as actual,
       coalesce((select md5(p.prosrc) = '81633731dcd07ca3fd2fdc3690bbeba4' from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'finalize_ingestion_run'), false) as ok
union all
select 2, 'LIVE discard_ingestion_run body == 0012 source (fail closed on drift)',
       '020e184cc7744a403006766d4ef3664b',
       coalesce((select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'discard_ingestion_run'),
                'FUNCTION MISSING'),
       coalesce((select md5(p.prosrc) = '020e184cc7744a403006766d4ef3664b' from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'discard_ingestion_run'), false)
union all
-- The header, from the catalog fields that actually define it. 0021 re-issues
-- these verbatim, so a mismatch here means the live signature is not the one
-- being replaced.
select 3, 'LIVE finalize_ingestion_run header matches what 0021 re-issues',
       'p_run_id uuid, p_owner uuid | jsonb | plpgsql | secdef | search_path=""',
       (select pg_get_function_identity_arguments(p.oid) || ' | ' ||
               pg_catalog.format_type(p.prorettype, null) || ' | ' || l.lanname ||
               ' | secdef=' || p.prosecdef::text ||
               ' | ' || coalesce(array_to_string(p.proconfig, ','), '(none)')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
               join pg_language l on l.oid = p.prolang
         where ns.nspname = 'public' and p.proname = 'finalize_ingestion_run'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_run_id uuid, p_owner uuid'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                    and l.lanname = 'plpgsql' and p.prosecdef
                    and coalesce(array_to_string(p.proconfig, ','), '') like 'search_path=%'
                  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                       join pg_language l on l.oid = p.prolang
                 where ns.nspname = 'public' and p.proname = 'finalize_ingestion_run'), false)
union all
select 4, 'LIVE discard_ingestion_run header matches what 0021 re-issues',
       'p_run_id uuid, p_owner uuid | jsonb | plpgsql | secdef | search_path=""',
       (select pg_get_function_identity_arguments(p.oid) || ' | ' ||
               pg_catalog.format_type(p.prorettype, null) || ' | ' || l.lanname ||
               ' | secdef=' || p.prosecdef::text ||
               ' | ' || coalesce(array_to_string(p.proconfig, ','), '(none)')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
               join pg_language l on l.oid = p.prolang
         where ns.nspname = 'public' and p.proname = 'discard_ingestion_run'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_run_id uuid, p_owner uuid'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                    and l.lanname = 'plpgsql' and p.prosecdef
                    and coalesce(array_to_string(p.proconfig, ','), '') like 'search_path=%'
                  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                       join pg_language l on l.oid = p.prolang
                 where ns.nspname = 'public' and p.proname = 'discard_ingestion_run'), false)
union all
select 5, 'exactly one overload of each (a second would be replaced blind)', '1 and 1',
       (select count(*) filter (where p.proname = 'finalize_ingestion_run')::text || ' and ' ||
               count(*) filter (where p.proname = 'discard_ingestion_run')::text
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname in ('finalize_ingestion_run','discard_ingestion_run')),
       (select count(*) filter (where p.proname = 'finalize_ingestion_run') = 1
           and count(*) filter (where p.proname = 'discard_ingestion_run') = 1
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname in ('finalize_ingestion_run','discard_ingestion_run'))
union all
select 6, 'neither function carries the guard yet', 'no guard in either',
       (select coalesce(string_agg(p.proname || '=' ||
                 (p.prosrc ilike '%cannot use the packet path%')::text, ', ' order by p.proname), '(none)')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname in ('finalize_ingestion_run','discard_ingestion_run')),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname = 'public'
                      and p.proname in ('finalize_ingestion_run','discard_ingestion_run')
                      and p.prosrc ilike '%cannot use the packet path%')
union all
-- ===========================================================================
-- State that 0021 depends on, and state it must not disturb.
-- ===========================================================================
select 7, '0020 is applied: destination column present',
       'present, not null, default packet',
       coalesce((select is_nullable || ' / ' || coalesce(column_default,'(none)')
                   from information_schema.columns
                  where table_schema='public' and table_name='ingestion_runs'
                    and column_name='destination'), 'MISSING — apply 0020 first'),
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='ingestion_runs'
                  and column_name='destination' and is_nullable='NO')
union all
select 8, 'both 0020 one-active indexes exist', '2',
       (select count(*)::text from pg_indexes where schemaname='public'
         and indexname in ('idx_ingestion_runs_one_active_packet','idx_ingestion_runs_one_active_library')),
       (select count(*) from pg_indexes where schemaname='public'
         and indexname in ('idx_ingestion_runs_one_active_packet','idx_ingestion_runs_one_active_library')) = 2
union all
select 9, 'library_import_proposals is absent (0021 creates it)', 'absent',
       coalesce(to_regclass('public.library_import_proposals')::text, 'absent'),
       to_regclass('public.library_import_proposals') is null
union all
select 10, 'library_save_proposal is absent (0021 creates it)', 'absent',
       coalesce((select 'ALREADY PRESENT' from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal' limit 1), 'absent'),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                    where ns.nspname='public' and p.proname='library_save_proposal')
union all
select 11, 'library_items exists (library_save_proposal writes to it)', 'present',
       coalesce(to_regclass('public.library_items')::text, 'MISSING — STOP'),
       to_regclass('public.library_items') is not null
union all
-- Replacing the two functions takes a brief lock. With nothing in flight there
-- is nothing to disrupt; if this is non-zero, wait rather than interrupt a run.
select 12, 'no ingestion run is in flight right now', '0',
       (select count(*)::text from public.ingestion_runs
         where status in ('active','finalizing','needs_review')),
       (select count(*) from public.ingestion_runs
         where status in ('active','finalizing','needs_review')) = 0
union all
select 13, 'the chunk engine is untouched and intact', '4 functions',
       (select count(*)::text from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')) = 4
order by n;
