-- 0028 PREFLIGHT — READ ONLY. Creates nothing, changes nothing.
-- Regex (~) throughout, never LIKE: these names contain underscores.
with c as (
  select 1::numeric as ord, 'schema is at 0027 — resolve_review_unit exists' as check_name, '1' as expected,
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='resolve_review_unit') as actual
  union all
  select 2, 'review_units does NOT exist yet', '0',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='ingestion_chunks' and column_name='review_units')
  union all
  select 3, 'fact_ledger exists — 0028 sits beside it, not on top of it', '1',
         (select count(*)::text from information_schema.columns
           where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger')
  union all
  -- THE RE-ISSUE SET. 0028 re-issues exactly the functions that clear chunk
  -- evidence. If a third one exists, the migration would leave it behind and a
  -- verbatim excerpt would outlive the evidence it belongs to.
  select 4, 'exactly two live functions clear chunk evidence', '2',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  select 5, 'they are the two 0028 re-issues', 'library_close_import_run,purge_ingestion_evidence',
         (select string_agg(p.proname, ',' order by p.proname)
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  select 6, 'both already clear the ledger — the line 0028 extends', '2',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosrc ~ 'fact_ledger\s*=\s*null')
  union all
  select 7, 'the purge eligibility predicate is where 0028 expects it', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'c\.result is not null or c\.segment_text is not null or c\.fact_ledger is not null')
  union all
  select 8, 'purge still leaves ingestion_runs.review alone', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'review\y'
             and p.prosrc !~ 'review_units')
  union all
  select 9, 'RLS still enabled on ingestion_chunks', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_chunks'::regclass),'missing')
  union all
  select 10, 'anon/authenticated still have no privileges on ingestion_chunks', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name='ingestion_chunks' and grantee in ('anon','authenticated'))
  union all
  -- MIGRATION OF EXISTING DATA. Enforcement has never been on for production
  -- traffic, so nothing should be sitting in the old channel. If this is not
  -- zero, 0028 needs a backfill and this preflight has just said so.
  select 11, 'chunks carrying units in the OLD fact_ledger channel', '0',
         (select count(*)::text from public.ingestion_chunks
           where jsonb_array_length(coalesce(fact_ledger->'unresolved','[]'::jsonb)) > 0)
  union all
  select 12, 'runs currently held in needs_review', 'report',
         (select count(*)::text from public.ingestion_runs where status='needs_review')
  union all
  select 13, 'chunks holding any evidence at all', 'report',
         (select count(*)::text from public.ingestion_chunks
           where result is not null or segment_text is not null or fact_ledger is not null)
)
select ord, check_name, expected, actual,
       case when expected='report' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
