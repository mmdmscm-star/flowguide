-- 0024 STEP 1 — PREFLIGHT. STRICTLY READ ONLY.
--
-- Nothing here creates, alters, drops, schedules or writes anything.
-- EVERY ROW MUST BE ok = true. If any is false, DO NOT APPLY 0024.
--
-- ===========================================================================
-- ROWS 1-5 ARE THE NEW RISK IN THIS MIGRATION.
--
-- 0024 is the first migration in this project to install an extension and
-- schedule a job. Both need privileges the previous migrations never exercised,
-- and pg_cron in particular cannot be installed at all unless the server was
-- started with it preloaded — a setting only the platform controls. Discovering
-- that mid-apply would leave the schema half-changed, so it is established here.
--
-- If row 3 is false, pg_cron cannot be installed by any SQL we write. Enable it
-- in Supabase → Database → Extensions first, then re-run this preflight.
-- ===========================================================================

select 1 as n, 'connected as a role that can create objects' as check_name,
       'CREATE on this database' as expected,
       current_user || ' (superuser=' ||
         coalesce((select rolsuper::text from pg_roles where rolname = current_user), '?') || ')' as actual,
       has_database_privilege(current_user, current_database(), 'CREATE') as ok
union all
select 2, 'the database pg_cron will run jobs in', 'matches the database holding our tables',
       current_database(),
       current_database() is not null
union all
-- THE DECISIVE ROW. pg_cron requires a preloaded library; without it
-- `create extension pg_cron` fails no matter who runs it.
select 3, 'pg_cron is PRELOADED by the server (installable at all)',
       'shared_preload_libraries contains pg_cron',
       current_setting('shared_preload_libraries', true),
       coalesce(current_setting('shared_preload_libraries', true), '') like '%pg_cron%'
union all
select 4, 'pg_cron is available to install, and not yet installed',
       'available, not installed',
       coalesce((select 'ALREADY INSTALLED ' || extversion from pg_extension where extname = 'pg_cron'),
                coalesce((select 'available ' || default_version from pg_available_extensions where name = 'pg_cron'),
                         'NOT AVAILABLE — STOP')),
       exists (select 1 from pg_available_extensions where name = 'pg_cron')
union all
select 5, 'no scheduled job of ours exists yet', 'none',
       coalesce((select count(*)::text || ' cron job(s) already present'
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'cron' and c.relname = 'job'), 'no cron schema yet'),
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'cron' and c.relname = 'job')
       or (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'cron' and c.relname = 'job') >= 0
union all
-- ===========================================================================
-- Nothing 0024 creates may already exist.
-- ===========================================================================
select 6, 'library_items has no origin_* columns yet', 'none of the three',
       coalesce((select string_agg(column_name, ', ' order by column_name)
                   from information_schema.columns
                  where table_schema='public' and table_name='library_items'
                    and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')), 'none'),
       not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='library_items'
                      and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index'))
union all
select 7, 'ingestion_runs has no retention column yet', 'absent',
       coalesce((select 'PRESENT' from information_schema.columns
                  where table_schema='public' and table_name='ingestion_runs'
                    and column_name='evidence_purge_after'), 'absent'),
       not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs'
                      and column_name='evidence_purge_after')
union all
select 8, 'purge_ingestion_evidence does not exist yet', 'absent',
       coalesce((select 'PRESENT' from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='purge_ingestion_evidence' limit 1), 'absent'),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                    where ns.nspname='public' and p.proname='purge_ingestion_evidence')
union all
-- ===========================================================================
-- The two functions 0024 re-issues. Their bodies must be exactly what the
-- applied migrations say, or 0024 would overwrite production drift with an
-- older definition — the same check 0021 needed.
-- ===========================================================================
select 9, 'LIVE library_close_import_run body == 0022 source (fail closed on drift)',
       'e8d5eeb970fdd4596b98e85858923abf',
       coalesce((select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_close_import_run'), 'MISSING'),
       coalesce((select md5(p.prosrc) = 'e8d5eeb970fdd4596b98e85858923abf'
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_close_import_run'), false)
union all
select 10, 'LIVE library_save_proposal body == 0021 source (fail closed on drift)',
       '75c84eaa4bd23ca0dbd96b2bbe1d5074',
       coalesce((select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), 'MISSING'),
       coalesce((select md5(p.prosrc) = '75c84eaa4bd23ca0dbd96b2bbe1d5074'
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), false)
union all
select 11, 'exactly one overload of each', '1 and 1',
       (select count(*) filter (where p.proname='library_close_import_run')::text || ' and ' ||
               count(*) filter (where p.proname='library_save_proposal')::text
          from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in ('library_close_import_run','library_save_proposal')),
       (select count(*) filter (where p.proname='library_close_import_run') = 1
           and count(*) filter (where p.proname='library_save_proposal') = 1
          from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
         where ns.nspname='public' and p.proname in ('library_close_import_run','library_save_proposal'))
union all
-- ===========================================================================
-- Structures 0024 depends on, and the posture it must preserve.
-- ===========================================================================
select 12, 'library_import_proposals still carries (run_id, ordinal, idx)', 'all three',
       (select coalesce(string_agg(column_name, ', ' order by column_name), 'MISSING')
          from information_schema.columns
         where table_schema='public' and table_name='library_import_proposals'
           and column_name in ('run_id','ordinal','idx')),
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='library_import_proposals'
           and column_name in ('run_id','ordinal','idx')) = 3
union all
-- Retained evidence is potentially sensitive user and business data: source text
-- can carry contacts, pricing, private notes and customer information. The
-- boundary that keeps it service-role-only must already hold before we extend
-- how long it lives.
select 13, 'RLS is on with NO policies on every table holding evidence',
       'rls on, 0 policies, for all four',
       (select string_agg(c.relname || '(rls=' || c.relrowsecurity::text || ',pol=' ||
                 (select count(*) from pg_policies pp where pp.schemaname='public' and pp.tablename=c.relname)::text || ')',
                 ', ' order by c.relname)
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public'
           and c.relname in ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals')),
       (select bool_and(c.relrowsecurity) and sum(
                 (select count(*) from pg_policies pp where pp.schemaname='public' and pp.tablename=c.relname)) = 0
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public'
           and c.relname in ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals'))
union all
select 14, 'no ingestion run is in flight', '0',
       (select count(*)::text from public.ingestion_runs
         where status in ('active','finalizing','needs_review')),
       (select count(*) from public.ingestion_runs
         where status in ('active','finalizing','needs_review')) = 0
union all
select 15, 'evidence that would be retained today, for scale', 'reference row, always true',
       (select coalesce(string_agg(left(r.id::text,8) || '=' || r.status ||
                 ' src=' || case when r.source_text is null then 'cleared' else pg_size_pretty(length(r.source_text)::bigint) end,
                 ' | ' order by r.created_at) , 'none')
          from public.ingestion_runs r where r.destination='library'),
       true
union all
select 16, 'earlier verification steps left nothing behind', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0
order by n;
