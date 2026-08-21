-- 0027 PREFLIGHT — READ ONLY. Creates nothing, changes nothing.
-- Regex (~) throughout, never LIKE: these names contain underscores.
with c as (
  select 1::numeric as ord, 'schema is at 0026 — packet_deleted_at exists' as check_name, 'present' as expected,
         coalesce((select 'present' from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='packet_deleted_at'),'ABSENT') as actual
  union all
  select 2, 'resolve_review_unit does NOT exist yet', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='resolve_review_unit')
  union all
  -- 0027 is FUNCTION-ONLY. Everything it needs must already be there.
  select 3, 'review column exists (0013)', 'jsonb',
         coalesce((select data_type from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='review'),'ABSENT')
  union all
  select 4, 'review is NOT NULL with a default, so a run always has one', '1',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='ingestion_runs' and column_name='review'
             and is_nullable='NO' and column_default is not null)
  union all
  select 5, 'needs_review is an allowed status (0013)', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_status_check'
             and pg_get_constraintdef(oid) ~ 'needs_review')
  union all
  select 6, 'finalized is an allowed status — the exit 0027 transitions to', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_status_check'
             and pg_get_constraintdef(oid) ~ 'finalized')
  union all
  select 7, 'the publish block that 0027 lifts still exists (0013)', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='block_publish_during_ingest')
  union all
  -- 0020 SPLIT this index into a packet-keyed and a library-keyed one; the
  -- single `idx_ingestion_runs_one_active` from 0013 no longer exists. The
  -- expectation, not the schema, was stale — and looking for a name rather than
  -- a property is what made it stale.
  select 8, 'both one-active-run indexes still count needs_review', '2',
         (select count(*)::text from pg_indexes
           where schemaname='public' and tablename='ingestion_runs'
             and indexname ~ 'one_active' and indexdef ~ 'needs_review')
  union all
  select 9, 'finalized_at exists — 0027 stamps it on exit', 'present',
         coalesce((select 'present' from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='finalized_at'),'ABSENT')
  union all
  -- Retention: review must NOT be cleared by the evidence purge, or an
  -- unresolved unit could vanish before the professional acted on it.
  select 10, 'purge does NOT touch review', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'review')
  union all
  select 11, 'RLS still enabled on ingestion_runs', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_runs'::regclass),'missing')
  union all
  select 12, 'anon/authenticated still have no privileges on ingestion_runs', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name='ingestion_runs' and grantee in ('anon','authenticated'))
  union all
  -- Current data: nothing should already be sitting in needs_review.
  select 13, 'runs currently in needs_review', 'report',
         (select count(*)::text from public.ingestion_runs where status='needs_review')
  union all
  select 14, 'runs whose review already carries failures', 'report',
         (select count(*)::text from public.ingestion_runs
           where jsonb_array_length(coalesce(review->'failures','[]'::jsonb)) > 0)
  union all
  select 15, 'review entries lacking a stable id (0027 addresses by id)', 'report',
         (select coalesce(count(*),0)::text from public.ingestion_runs r,
                 lateral jsonb_array_elements(coalesce(r.review->'failures','[]'::jsonb)) f
           where f->>'id' is null)
)
select ord, check_name, expected, actual,
       case when expected='report' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
