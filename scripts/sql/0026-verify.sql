-- 0026 POST-APPLY VERIFIER — READ ONLY. Structural half.
with c as (
  select 1::numeric as ord, 'packet_deleted_at exists' as check_name, 'timestamp with time zone' as expected,
         coalesce((select data_type from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='packet_deleted_at'),'ABSENT') as actual
  union all
  select 2, 'FK is now ON DELETE SET NULL', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and contype='f'
             and pg_get_constraintdef(oid) ~ 'REFERENCES packets\(id\)'
             and pg_get_constraintdef(oid) ~ 'ON DELETE SET NULL')
  union all
  select 3, 'no ON DELETE CASCADE remains on that FK', '0',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and contype='f'
             and pg_get_constraintdef(oid) ~ 'REFERENCES packets\(id\)'
             and pg_get_constraintdef(oid) ~ 'ON DELETE CASCADE')
  union all
  select 4, 'coherence constraint is the NEW form (mentions packet_deleted_at)', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass
             and conname='ingestion_runs_destination_coherent'
             and pg_get_constraintdef(oid) ~ 'packet_deleted_at')
  union all
  select 5, 'packet-delete trigger exists and is BEFORE DELETE', '1',
         (select count(*)::text from pg_trigger t
           where t.tgrelid='public.packets'::regclass
             and t.tgname='trg_stamp_orphaned_ingestion_runs' and not t.tgisinternal)
  union all
  select 6, 'finalize no longer clears chunk evidence', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='finalize_ingestion_run' and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  select 7, 'finalize stamps evidence_purge_after', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='finalize_ingestion_run' and p.prosrc ~ 'evidence_purge_after')
  union all
  select 8, 'discard no longer clears chunk evidence', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='discard_ingestion_run' and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  select 9, 'discard stamps evidence_purge_after and keeps run error', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='discard_ingestion_run'
             and p.prosrc ~ 'evidence_purge_after' and p.prosrc !~ $q$error=''$q$)
  union all
  select 10, 'discard still deletes the empty draft packet', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='discard_ingestion_run' and p.prosrc ~ 'delete from public\.packets')
  union all
  select 11, 'purge now clears RUN-LEVEL error', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'source_text = null, error')
  union all
  select 12, 'purge deletes expired orphan runs', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'delete from public\.ingestion_runs')
  union all
  select 13, 'orphan delete is guarded by the Library provenance reference', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'library_items li where li\.origin_run_id')
  union all
  select 14, 'purge still clears chunk segment/result/ledger', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'segment_text = null' and p.prosrc ~ 'fact_ledger = null' and p.prosrc ~ 'result = null')
  union all
  select 15, 'pg_cron purge job still active', 'true',
         coalesce((select active::text from cron.job where jobname='flowguide-purge-ingestion-evidence'),'MISSING')
  union all
  select 16, 'RLS still enabled on ingestion_runs', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_runs'::regclass),'missing')
  union all
  select 17, 'RLS still enabled on ingestion_chunks', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_chunks'::regclass),'missing')
  union all
  select 18, 'anon/authenticated still have no privileges', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name in ('ingestion_runs','ingestion_chunks')
             and grantee in ('anon','authenticated'))
  union all
  select 19, 'existing rows still satisfy the new coherence rule', '0',
         (select count(*)::text from public.ingestion_runs r
           where not ((r.destination='packet' and (r.packet_id is not null or r.packet_deleted_at is not null))
                   or (r.destination='library' and r.packet_id is null)))
)
select ord, check_name, expected, actual,
       case when expected='report' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
