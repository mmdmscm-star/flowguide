-- 0025 PREFLIGHT — READ ONLY. Creates nothing, changes nothing.
--
-- Identifier matching uses REGEX (~), never LIKE. `fact_ledger` contains an
-- underscore, and LIKE treats `_` as a single-character wildcard — the exact
-- mistake that produced a false match during 0023.
with c as (
  select 1 as ord, 'column fact_ledger does not exist yet' as check,
         'absent' as expected,
         coalesce((select 'present' from information_schema.columns
                    where table_schema='public' and table_name='ingestion_chunks'
                      and column_name='fact_ledger'), 'absent') as actual
  union all
  select 2, 'ingestion_chunks exists', 'present',
         coalesce((select 'present' from information_schema.tables
                    where table_schema='public' and table_name='ingestion_chunks'),'absent')
  union all
  select 3, 'RLS is enabled on ingestion_chunks', 'true',
         coalesce((select relrowsecurity::text from pg_class
                    where oid='public.ingestion_chunks'::regclass),'missing')
  union all
  -- The new column inherits whatever policies the table has. Report the count so
  -- the ledger's exposure is a stated fact rather than an assumption.
  select 4, 'policies on ingestion_chunks (ledger inherits these)', 'report',
         (select count(*)::text from pg_policies
           where schemaname='public' and tablename='ingestion_chunks')
  union all
  select 5, 'finalize_ingestion_run exists', 'present',
         coalesce((select 'present' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='finalize_ingestion_run'),'absent')
  union all
  select 6, 'discard_ingestion_run exists', 'present',
         coalesce((select 'present' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='discard_ingestion_run'),'absent')
  union all
  select 7, 'library_close_import_run exists', 'present',
         coalesce((select 'present' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='library_close_import_run'),'absent')
  union all
  select 8, 'purge_ingestion_evidence exists', 'present',
         coalesce((select 'present' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='purge_ingestion_evidence'),'absent')
  union all
  -- Exactly four live functions clear chunk evidence. If this is not 4, a path
  -- exists that 0025 does not re-issue, and a ledger would survive it.
  select 9, 'live functions clearing chunk evidence', '4',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  select 10, 'none of them clears fact_ledger yet', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosrc ~ 'fact_ledger')
  union all
  -- My re-issued bodies were extracted from the migration files. This proves the
  -- DATABASE agrees with those files, so the extraction is faithful to what is
  -- actually running.
  select 11, 'finalize_ingestion_run clearing statement is the one 0025 edits', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='finalize_ingestion_run'
             and p.prosrc ~ 'set result = null, segment_text = null, section_hint = '''', error = '''', updated_at = now\(\)')
  union all
  select 12, 'discard_ingestion_run clearing statement is the one 0025 edits', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='discard_ingestion_run'
             and p.prosrc ~ 'set result=null, segment_text=null, section_hint='''', error='''', updated_at=now\(\)')
  union all
  select 13, 'library_close_import_run clearing statement is the one 0025 edits', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='library_close_import_run'
             and p.prosrc ~ 'set result = null, segment_text = null, section_hint = '''', error = '''', updated_at = now\(\)')
  union all
  select 14, 'purge_ingestion_evidence clearing statement is the one 0025 edits', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'set result = null, segment_text = null, section_hint = '''', error = '''', updated_at = now\(\)')
  union all
  select 15, 'pg_cron purge job still scheduled', '1',
         (select count(*)::text from cron.job where jobname='flowguide-purge-ingestion-evidence')
  union all
  -- Context, not a gate: how much retained evidence 0025 will apply to.
  select 16, 'runs currently holding retained evidence', 'report',
         (select count(*)::text from public.ingestion_runs where evidence_purge_after is not null)
  union all
  select 17, 'chunks currently holding a segment', 'report',
         (select count(*)::text from public.ingestion_chunks where segment_text is not null)
  union all
  select 18, 'active runs (0025 re-issues functions they may call)', 'report',
         (select count(*)::text from public.ingestion_runs where status='active')
)
select ord, check, expected, actual,
       case when expected='report' then 'INFO'
            when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
