-- 0026 PREFLIGHT — READ ONLY. Creates nothing, changes nothing.
--
-- Identifier matching uses REGEX (~), never LIKE: several names here contain
-- underscores and LIKE treats `_` as a single-character wildcard.
with c as (
  select 1 as ord, 'schema is at 0025 — packet_deleted_at does not exist yet' as check_name, 'absent' as expected,
         coalesce((select 'present' from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='packet_deleted_at'),'absent') as actual
  union all
  select 2, '0025 IS applied — fact_ledger present', 'present',
         coalesce((select 'present' from information_schema.columns
                    where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger'),'ABSENT')
  union all
  -- What 0026 replaces, read from the live catalog.
  select 3, 'packet_id FK is currently ON DELETE CASCADE', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and contype='f'
             and pg_get_constraintdef(oid) ~ 'REFERENCES packets\(id\)'
             and pg_get_constraintdef(oid) ~ 'ON DELETE CASCADE')
  union all
  select 4, 'exactly one packets FK to replace', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and contype='f'
             and pg_get_constraintdef(oid) ~ 'REFERENCES packets\(id\)')
  union all
  select 5, 'packet_id is currently NOT NULL', 'NO',
         coalesce((select is_nullable from information_schema.columns
                    where table_schema='public' and table_name='ingestion_runs' and column_name='packet_id'),'missing')
  union all
  select 6, 'destination coherence constraint exists to replace', '1',
         (select count(*)::text from pg_constraint
           where conrelid='public.ingestion_runs'::regclass and conname='ingestion_runs_destination_coherent')
  union all
  select 7, 'no trigger of this name exists yet', '0',
         (select count(*)::text from pg_trigger
           where tgrelid='public.packets'::regclass and tgname='trg_stamp_orphaned_ingestion_runs')
  union all
  select 8, 'finalize/discard currently CLEAR packet evidence (what 0026 stops)', '2',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname in ('finalize_ingestion_run','discard_ingestion_run')
             and p.prosrc ~ 'segment_text\s*=\s*null')
  union all
  -- EVERY EXISTING ROW must satisfy the PROPOSED rule, or the constraint fails.
  select 9, 'rows violating the PROPOSED coherence rule', '0',
         (select count(*)::text from public.ingestion_runs r
           where not ((r.destination = 'packet' and r.packet_id is not null)
                   or (r.destination = 'library' and r.packet_id is null)))
  union all
  select 10, 'packet runs whose packet row is already missing', '0',
         (select count(*)::text from public.ingestion_runs r
           where r.destination='packet' and r.packet_id is not null
             and not exists (select 1 from public.packets p where p.id = r.packet_id))
  union all
  select 11, 'library runs carrying a packet_id (would violate)', '0',
         (select count(*)::text from public.ingestion_runs where destination='library' and packet_id is not null)
  union all
  -- The purge must reach PACKET evidence, not only library evidence.
  select 12, 'purge selects runs by expiry alone, with no destination filter', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'destination')
  union all
  select 13, 'purge clears chunk segment/result/ledger/error', '1',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'segment_text = null' and p.prosrc ~ 'fact_ledger = null'
             and p.prosrc ~ 'result = null')
  union all
  select 14, 'purge does NOT yet clear run-level error (0026 adds it)', '0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='purge_ingestion_evidence'
             and p.prosrc ~ 'set source_text = null, error')
  union all
  select 15, 'pg_cron purge job exists and is active', 'true',
         coalesce((select active::text from cron.job where jobname='flowguide-purge-ingestion-evidence'),'MISSING')
  union all
  -- SECURITY POSTURE. Retained evidence must stay service-role only.
  select 16, 'RLS enabled on ingestion_runs', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_runs'::regclass),'missing')
  union all
  select 17, 'RLS enabled on ingestion_chunks', 'true',
         coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_chunks'::regclass),'missing')
  union all
  select 18, 'anon/authenticated privileges on ingestion_runs', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name='ingestion_runs' and grantee in ('anon','authenticated'))
  union all
  select 19, 'anon/authenticated privileges on ingestion_chunks', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema='public' and table_name='ingestion_chunks' and grantee in ('anon','authenticated'))
  union all
  -- A discarded run must remain unusable: the chunk route refuses non-active runs.
  select 20, 'discarded/finalized runs currently in the system', 'report',
         (select count(*)::text from public.ingestion_runs where status in ('discarded','finalized'))
  union all
  select 21, 'runs already carrying an expiry (0024/0025 library retention)', 'report',
         (select count(*)::text from public.ingestion_runs where evidence_purge_after is not null)
  union all
  select 22, 'chunks currently holding retained evidence', 'report',
         (select count(*)::text from public.ingestion_chunks where segment_text is not null)
  union all
  select 23, 'packet runs that would newly retain evidence, per year at current rate', 'report',
         (select count(*)::text from public.ingestion_runs where destination='packet')
)
select ord, check_name, expected, actual,
       case when expected='report' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end as result
from c order by ord;
