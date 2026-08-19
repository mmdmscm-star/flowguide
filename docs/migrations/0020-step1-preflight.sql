-- 0020 STEP 1 — PREFLIGHT. STRICTLY READ ONLY.
--
-- Nothing here creates, alters, drops or writes anything. Run it in the
-- Supabase SQL editor and paste the whole result back.
--
-- Its job is to record what production looks like BEFORE 0020, so that after
-- 0020 every claim of "unchanged" can be checked against a captured value
-- rather than a memory. Rows 10, 12 and 15 are the ones that matter most:
--
--   10 — the live one-active index predicate. 0013 widened it to include
--        needs_review. If the value below does not contain needs_review, stop:
--        the migration's assumptions are wrong.
--   12 — md5 of the two functions that must come through 0020 byte-identical.
--   15 — every function in the database whose body mentions ingestion_runs,
--        which is how we find out whether the inventory taken from the
--        migration files missed anything that exists only in production.

select 1 as n, 'postgres version' as label,
       current_setting('server_version') as value
union all
select 2, 'ingestion_runs exists',
       coalesce(to_regclass('public.ingestion_runs')::text, 'MISSING — STOP')
union all
select 3, 'destination column (must be: absent)',
       coalesce((select 'ALREADY PRESENT — STOP: ' || data_type
                 from information_schema.columns
                 where table_schema = 'public' and table_name = 'ingestion_runs'
                   and column_name = 'destination'), 'absent')
union all
select 4, 'packet_id is_nullable (must be: NO)',
       coalesce((select is_nullable from information_schema.columns
                 where table_schema = 'public' and table_name = 'ingestion_runs'
                   and column_name = 'packet_id'), 'COLUMN MISSING — STOP')
union all
select 5, 'runs with null packet_id (must be: 0)',
       (select count(*)::text from public.ingestion_runs where packet_id is null)
union all
select 6, 'total runs',
       (select count(*)::text from public.ingestion_runs)
union all
select 7, 'runs by status',
       coalesce((select string_agg(status || '=' || c, ', ' order by status)
                 from (select status, count(*) c from public.ingestion_runs group by status) t),
                '(no runs)')
union all
select 8, 'non-terminal runs right now (a live import would be disrupted)',
       (select count(*)::text from public.ingestion_runs
        where status in ('active','finalizing','needs_review'))
union all
select 9, 'all indexes on ingestion_runs',
       coalesce((select string_agg(indexname || ' :: ' || indexdef, E'\n' order by indexname)
                 from pg_indexes where schemaname = 'public' and tablename = 'ingestion_runs'),
                '(none)')
union all
select 10, 'ONE-ACTIVE index predicate (must contain needs_review)',
       coalesce((select indexdef from pg_indexes
                 where schemaname = 'public' and indexname = 'idx_ingestion_runs_one_active'),
                'MISSING — STOP')
union all
select 11, 'all constraints on ingestion_runs',
       coalesce((select string_agg(conname || ' :: ' || pg_get_constraintdef(oid), E'\n' order by conname)
                 from pg_constraint where conrelid = 'public.ingestion_runs'::regclass), '(none)')
union all
select 12, 'md5 of functions that must survive 0020 UNCHANGED',
       coalesce((select string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), E'\n' order by p.proname)
                 from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
                 where nsp.nspname = 'public'
                   and p.proname in ('block_publish_during_ingest','ingest_invalidate_offsets')),
                'MISSING — STOP')
union all
select 13, 'ingestion RPC signatures (record for post-apply comparison)',
       coalesce((select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', E'\n' order by p.proname)
                 from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
                 where nsp.nspname = 'public'
                   and p.proname in ('create_ingestion_run','create_organize_run','claim_chunk',
                                     'stage_chunk_result','mark_chunk_failed','split_chunk',
                                     'finalize_ingestion_run','discard_ingestion_run')), '(none)')
union all
select 14, 'library_import_proposals (must be: absent — that is 0021)',
       coalesce(to_regclass('public.library_import_proposals')::text, 'absent')
union all
select 15, 'EVERY function whose body mentions ingestion_runs (completeness)',
       coalesce((select string_agg(p.proname, ', ' order by p.proname)
                 from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
                 where nsp.nspname = 'public' and p.prokind = 'f'
                   and pg_get_functiondef(p.oid) ilike '%ingestion_runs%'), '(none)')
union all
select 16, 'any VIEW over ingestion_runs (expected: none)',
       coalesce((select string_agg(viewname, ', ' order by viewname)
                 from pg_views where schemaname = 'public' and definition ilike '%ingestion_runs%'), 'none')
union all
select 17, 'library_items exists (0021 depends on it)',
       coalesce(to_regclass('public.library_items')::text, 'MISSING — STOP')
order by n;
