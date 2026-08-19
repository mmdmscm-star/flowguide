-- 0022 STEP 2 — PREFLIGHT. STRICTLY READ ONLY.
--
-- (Step 1 is the offline integrity check, which needs no database:
--    node scripts/migrations/verify-0022-integrity.mjs )
--
-- Nothing here creates, alters, drops or writes anything. EVERY ROW MUST BE
-- ok = true. If any is false, DO NOT APPLY 0022.
--
-- 0022 adds three functions and touches nothing existing, so this is shorter
-- than 0020's and 0021's. What it establishes is that the ground 0022 stands on
-- is actually there — rows 1 to 6 — and that nothing it creates already exists.

select 1 as n, 'entry_point CHECK allows library_import (0020)' as check_name,
       'contains library_import' as expected,
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid = 'public.ingestion_runs'::regclass
                    and conname = 'ingestion_runs_entry_point_check'), 'MISSING — apply 0020') as actual,
       coalesce((select pg_get_constraintdef(oid) ilike '%library_import%' from pg_constraint
                  where conrelid = 'public.ingestion_runs'::regclass
                    and conname = 'ingestion_runs_entry_point_check'), false) as ok
union all
-- create_library_import_run inserts a run with destination='library' and a NULL
-- packet_id. Without this CHECK in place that row would be rejected.
select 2, 'destination coherence CHECK is in place (0020)', 'present',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid = 'public.ingestion_runs'::regclass
                    and conname = 'ingestion_runs_destination_coherent'), 'MISSING — apply 0020'),
       exists (select 1 from pg_constraint
                where conrelid = 'public.ingestion_runs'::regclass
                  and conname = 'ingestion_runs_destination_coherent')
union all
select 3, 'one-active-import index is in place (0020)', 'keyed on user_id',
       coalesce((select indexdef from pg_indexes where schemaname = 'public'
                  and indexname = 'idx_ingestion_runs_one_active_library'), 'MISSING — apply 0020'),
       coalesce((select indexdef ilike '%(user_id)%' from pg_indexes where schemaname = 'public'
                  and indexname = 'idx_ingestion_runs_one_active_library'), false)
union all
select 4, 'library_import_proposals exists (0021)', 'present',
       coalesce(to_regclass('public.library_import_proposals')::text, 'MISSING — apply 0021'),
       to_regclass('public.library_import_proposals') is not null
union all
-- library_materialize_proposals inserts with `on conflict (run_id, ordinal, idx)`,
-- which requires exactly this unique constraint to exist.
select 5, 'the (run_id, ordinal, idx) unique key exists (0021)', 'present',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid = 'public.library_import_proposals'::regclass and contype = 'u'), 'MISSING'),
       coalesce((select pg_get_constraintdef(oid) ilike '%run_id, ordinal, idx%' from pg_constraint
                  where conrelid = 'public.library_import_proposals'::regclass and contype = 'u'), false)
union all
select 6, 'library_save_proposal exists (0021) — the only Library writer', 'present',
       coalesce((select 'present' from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'library_save_proposal' limit 1),
                'MISSING — apply 0021'),
       exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                where ns.nspname = 'public' and p.proname = 'library_save_proposal')
union all
-- ---------------------------------------------------------------------------
-- Nothing 0022 creates may already exist.
-- ---------------------------------------------------------------------------
select 7, 'the three 0022 functions are all absent', '0 present',
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('create_library_import_run','library_materialize_proposals','library_close_import_run')),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname = 'public' and p.proname in
                      ('create_library_import_run','library_materialize_proposals','library_close_import_run'))
union all
-- ---------------------------------------------------------------------------
-- State 0022 must not disturb.
-- ---------------------------------------------------------------------------
select 8, 'no ingestion run is in flight right now', '0',
       (select count(*)::text from public.ingestion_runs
         where status in ('active','finalizing','needs_review')),
       (select count(*) from public.ingestion_runs
         where status in ('active','finalizing','needs_review')) = 0
union all
select 9, 'no library import exists yet', '0 library runs, 0 proposals',
       (select count(*)::text from public.ingestion_runs where destination = 'library')
         || ' runs, ' || (select count(*)::text from public.library_import_proposals) || ' proposals',
       (select count(*) from public.ingestion_runs where destination = 'library') = 0
         and (select count(*) from public.library_import_proposals) = 0
union all
select 10, 'the chunk engine is untouched and intact', '4 functions',
       (select count(*)::text from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('claim_chunk','stage_chunk_result','mark_chunk_failed','split_chunk')) = 4
union all
-- The guards 0021 installed must still be there; 0022 does not re-issue them.
select 11, 'the packet-path destination guards are still present (0021)', 'both',
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'NEITHER')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname in ('finalize_ingestion_run','discard_ingestion_run')
           and p.prosrc ilike '%cannot use the packet path%'),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname in ('finalize_ingestion_run','discard_ingestion_run')
           and p.prosrc ilike '%cannot use the packet path%') = 2
union all
-- Rollback evidence, as in 0021: earlier verification steps created disposable
-- users inside transactions that ended in ROLLBACK. Any survivor means a session
-- did not roll back, and the runtime proof must not be trusted until that is
-- understood.
select 12, 'earlier verification steps left nothing behind', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0
order by n;
