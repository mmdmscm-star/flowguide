-- 0024 STEP 0 — SCHEDULED-PURGE FEASIBILITY. STRICTLY READ ONLY.
--
-- The retention design says "30 days". Whether that is a real deletion policy or
-- a lazy one depends entirely on whether this project can run a small scheduled
-- job inside the database. That is a fact about your Supabase project, not
-- something to assume — so it is measured here before the migration is written.
--
-- Row 1 is the decisive one.

select 1 as n, 'pg_cron is INSTALLED (a scheduled purge can live in the database)' as check_name,
       coalesce((select extversion from pg_extension where extname = 'pg_cron'), 'not installed') as detail
union all
select 2, 'pg_cron is AVAILABLE to install, even if not installed yet',
       coalesce((select default_version from pg_available_extensions where name = 'pg_cron'), 'not available on this instance')
union all
select 3, 'pg_net (an alternative scheduling/HTTP path), for completeness',
       coalesce((select extversion from pg_extension where extname = 'pg_net'), 'not installed')
union all
select 4, 'existing scheduled jobs, if pg_cron is present',
       coalesce((select count(*)::text || ' job(s)' from pg_catalog.pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'cron' and c.relname = 'job'), 'no cron schema')
union all
-- Size of what retention would keep, measured rather than estimated. These are
-- the two real Library imports; the second is the 61-record one.
select 5, 'evidence footprint of the real imports (source + segments + results)',
       coalesce((select string_agg(
                   left(r.id::text, 8) || ': source ' ||
                   pg_size_pretty(coalesce(length(r.source_text), r.source_len)::bigint) ||
                   ', ' || (select count(*) from public.ingestion_chunks c where c.run_id = r.id)::text || ' chunks',
                   ' | ' order by r.created_at)
                 from public.ingestion_runs r where r.destination = 'library'), 'none')
union all
select 6, 'total ingestion_chunks rows across ALL runs (purge workload)',
       (select count(*)::text from public.ingestion_chunks)
union all
select 7, 'runs that would already be past a 30-day window today',
       (select count(*)::text from public.ingestion_runs
         where status in ('finalized','discarded') and updated_at < now() - interval '30 days')
order by n;
