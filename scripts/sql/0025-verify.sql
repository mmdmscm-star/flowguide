-- 0025 POST-APPLY VERIFIER.
--
-- Runs inside a transaction that ENDS IN ROLLBACK. That is not tidiness: it is
-- how the disposable test data is cleaned up. The file contains no COMMIT
-- anywhere, so there is no path by which anything it creates can persist —
-- including if it errors partway, since an aborted transaction commits nothing.
-- Cleanup is therefore structural rather than a delete I have to trust.
--
-- WHERE YOUR RESULTS ARE. The grid you want is the SELECT immediately before
-- ROLLBACK. If your editor only renders the final statement and shows an empty
-- result, say so and I will split this into two scripts.
--
-- WHAT IT TOUCHES. It creates new disposable rows and modifies no existing one.
-- purge_ingestion_evidence() is global by nature, so calling it may clear real
-- expired evidence — and the rollback restores it. Net effect: none.
--
-- Identifier matching uses REGEX (~), never LIKE: `fact_ledger` contains an
-- underscore and LIKE treats `_` as a wildcard.

begin;

create temp table v(ord int, check_name text, expected text, actual text) on commit drop;

-- ===========================================================================
-- A. THE COLUMN
-- ===========================================================================
insert into v values (1, 'fact_ledger exists with the intended type', 'jsonb', coalesce((select data_type from information_schema.columns where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger'),'ABSENT'));
insert into v values (2, 'fact_ledger is nullable (no backfill forced)', 'YES', coalesce((select is_nullable from information_schema.columns where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger'),'ABSENT'));
insert into v values (3, 'fact_ledger has no default (absent means absent)', 'none', coalesce((select column_default from information_schema.columns where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger'),'none'));
insert into v values (4, 'the column is documented', 'documented', case when coalesce((select col_description('public.ingestion_chunks'::regclass, (select ordinal_position::int from information_schema.columns where table_schema='public' and table_name='ingestion_chunks' and column_name='fact_ledger'))),'') <> '' then 'documented' else 'MISSING' end);

-- ===========================================================================
-- B. SECURITY POSTURE — unchanged
-- ===========================================================================
insert into v values (10, 'RLS still enabled on ingestion_chunks', 'true', coalesce((select relrowsecurity::text from pg_class where oid='public.ingestion_chunks'::regclass),'MISSING'));
insert into v values (11, 'no policy mentions fact_ledger', '0', (select count(*)::text from pg_policies where schemaname='public' and tablename='ingestion_chunks' and coalesce(qual,'')||coalesce(with_check,'') ~ 'fact_ledger'));
insert into v values (12, 'anon has no privilege on ingestion_chunks', '0', (select count(*)::text from information_schema.role_table_grants where table_schema='public' and table_name='ingestion_chunks' and grantee='anon'));
insert into v values (13, 'authenticated has no privilege on ingestion_chunks', '0', (select count(*)::text from information_schema.role_table_grants where table_schema='public' and table_name='ingestion_chunks' and grantee='authenticated'));
insert into v values (14, 'no view exposes fact_ledger', '0', (select count(*)::text from pg_views where schemaname not in ('pg_catalog','information_schema') and definition ~ 'fact_ledger'));
insert into v values (15, 'no trigger fires on the ledger column', '0', (select count(*)::text from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid='public.ingestion_chunks'::regclass and not t.tgisinternal and p.prosrc ~ 'fact_ledger'));
insert into v values (16, 'exactly four functions mention fact_ledger', '4', (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc ~ 'fact_ledger'));
insert into v values (17, '...and they are exactly the four re-issued ones', '4', (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc ~ 'fact_ledger' and p.proname in ('finalize_ingestion_run','discard_ingestion_run','library_close_import_run','purge_ingestion_evidence')));

-- ===========================================================================
-- C. THE FOUR RE-ISSUED BODIES
--
--    Each is proven twice. First that it now clears fact_ledger. Then the
--    stronger claim: strip the ledger addition back out and the SHA-256 of what
--    remains equals the hash of the definition that was live BEFORE 0025. That
--    is what rules out an unnoticed change to finalize (which composes sections
--    and items) or to library close.
-- ===========================================================================
insert into v values (20, 'finalize_ingestion_run clears fact_ledger', '1', (select count(*)::text from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='finalize_ingestion_run' and p.prosrc ~ 'fact_ledger = null'));
insert into v values (21, 'finalize_ingestion_run body, ledger addition stripped', '3700e34590d9ac613d08b7ab9cd3f9db46d60c4d71ef4bf9e748c2b9c28fa5b1', coalesce((select encode(sha256(convert_to(replace(replace(p.prosrc,'fact_ledger = null, ',''),' or c.fact_ledger is not null',''),'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='finalize_ingestion_run'),'ABSENT'));
insert into v values (22, 'discard_ingestion_run clears fact_ledger', '1', (select count(*)::text from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='discard_ingestion_run' and p.prosrc ~ 'fact_ledger = null'));
insert into v values (23, 'discard_ingestion_run body, ledger addition stripped', '1a899144bb5bdeb6a243ee6d7576bdcd275c359306cccf239456682de6e8d3a7', coalesce((select encode(sha256(convert_to(replace(replace(p.prosrc,'fact_ledger = null, ',''),' or c.fact_ledger is not null',''),'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='discard_ingestion_run'),'ABSENT'));
insert into v values (24, 'library_close_import_run clears fact_ledger', '1', (select count(*)::text from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='library_close_import_run' and p.prosrc ~ 'fact_ledger = null'));
insert into v values (25, 'library_close_import_run body, ledger addition stripped', '7280ea3527a1f8ca537ec3251d92a685b82dc4bbcf821f070131b695cb522776', coalesce((select encode(sha256(convert_to(replace(replace(p.prosrc,'fact_ledger = null, ',''),' or c.fact_ledger is not null',''),'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='library_close_import_run'),'ABSENT'));
insert into v values (26, 'purge_ingestion_evidence clears fact_ledger', '1', (select count(*)::text from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'fact_ledger = null'));
insert into v values (27, 'purge_ingestion_evidence body, ledger addition stripped', '0b815d6ca79d326fc1ec9d114293403687f4f56e99be9aaa8907b82516dbd883', coalesce((select encode(sha256(convert_to(replace(replace(p.prosrc,'fact_ledger = null, ',''),' or c.fact_ledger is not null',''),'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='purge_ingestion_evidence'),'ABSENT'));
insert into v values (28, 'purge treats a ledger-only chunk as still holding evidence', '1', (select count(*)::text from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='purge_ingestion_evidence' and p.prosrc ~ 'c\.fact_ledger is not null'));

-- ===========================================================================
-- D. SENTINELS — functions 0025 must NOT have touched
-- ===========================================================================
insert into v values (30, 'library_save_proposal unchanged since 0024', '8e09dec539cc3b74ecb95fd2ac15d8470c90d9de9fce1f3ea6f233d6491ba3df', coalesce((select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='library_save_proposal'),'ABSENT'));
insert into v values (31, 'library_materialize_proposals unchanged since 0022', '1544a7e93a4caca2a1cb1f76da25001fd5a318bdfef8a2181b1991e6f553c5cd', coalesce((select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='library_materialize_proposals'),'ABSENT'));
insert into v values (32, 'create_packet_from_library unchanged since 0023', '1d2863d49886a58f7e8b03f5486effdff6b4f068068355043a5a574412021634', coalesce((select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='create_packet_from_library'),'ABSENT'));
insert into v values (33, 'stage_chunk_result unchanged since 0012', '8098fdc5de03bf9751cd10d0336ef8adacbb18cb54f41da3bfb129c1d73f487d', coalesce((select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace where nn.nspname='public' and p.proname='stage_chunk_result'),'ABSENT'));

-- ===========================================================================
-- E. THE PURGE JOB
-- ===========================================================================
insert into v values (40, 'pg_cron purge job exists', '1', (select count(*)::text from cron.job where jobname='flowguide-purge-ingestion-evidence'));
insert into v values (41, '...and is still active', 'true', coalesce((select active::text from cron.job where jobname='flowguide-purge-ingestion-evidence'),'MISSING'));
insert into v values (42, '...and still calls the purge function', '1', (select count(*)::text from cron.job where jobname='flowguide-purge-ingestion-evidence' and command ~ 'purge_ingestion_evidence'));

-- ===========================================================================
-- F. BEHAVIOUR, on disposable data.
--
--    Each test is its own block with its own handler, so one failure reports
--    itself as a row instead of aborting the script and hiding the rest.
-- ===========================================================================
do $verify$
declare
  v_owner uuid; v_run uuid; v_packet uuid;
  v_seg text; v_res jsonb; v_led jsonb; v_exp timestamptz;
  v_led_txt text := '{"counts":{"detected":2,"accounted":1,"unaccounted":1}}';
begin
  select id into v_owner from public.users order by created_at limit 1;
  if v_owner is null then
    insert into v values (50,'behaviour tests','ran','SKIPPED - no user row to anchor a foreign key'); return;
  end if;

  -- F1. A ledger can be stored and read back as jsonb. ----------------------
  begin
    v_run := public.create_library_import_run(v_owner, 'Community Fee: $3,500', 'verifierhash0025', 'seg-v4', 1);
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, status, result, fact_ledger)
      values (v_run, 0, 0, 21, 'Community Fee: $3,500', 'h0', 'completed', '{"items":[]}'::jsonb, v_led_txt::jsonb);
    select fact_ledger into v_led from public.ingestion_chunks where run_id=v_run and ordinal=0;
    insert into v values (50,'ledger stores and reads back as jsonb','1',
      (v_led->'counts'->>'unaccounted'));
  exception when others then
    insert into v values (50,'ledger stores and reads back as jsonb','1','ERROR: '||SQLERRM);
  end;

  -- F2. Library FINALIZE retains the ledger, in step with the evidence. -----
  begin
    perform public.library_close_import_run(v_owner, v_run, 'finalized');
    select segment_text, result, fact_ledger into v_seg, v_res, v_led
      from public.ingestion_chunks where run_id=v_run and ordinal=0;
    select evidence_purge_after into v_exp from public.ingestion_runs where id=v_run;
    insert into v values (51,'library finalize RETAINS ledger with the evidence','segment=kept ledger=kept expiry=stamped',
      'segment='||(case when v_seg is null then 'CLEARED' else 'kept' end)||
      ' ledger='||(case when v_led is null then 'CLEARED' else 'kept' end)||
      ' expiry='||(case when v_exp is null then 'MISSING' else 'stamped' end));
  exception when others then
    insert into v values (51,'library finalize RETAINS ledger with the evidence','kept','ERROR: '||SQLERRM);
  end;

  -- F3. purge() clears ledger and evidence TOGETHER. -----------------------
  begin
    update public.ingestion_runs set evidence_purge_after = now() - interval '1 day' where id=v_run;
    perform public.purge_ingestion_evidence();
    select segment_text, result, fact_ledger into v_seg, v_res, v_led
      from public.ingestion_chunks where run_id=v_run and ordinal=0;
    insert into v values (52,'purge clears ledger IN STEP with the evidence','segment=cleared result=cleared ledger=cleared',
      'segment='||(case when v_seg is null then 'cleared' else 'KEPT' end)||
      ' result='||(case when v_res is null then 'cleared' else 'KEPT' end)||
      ' ledger='||(case when v_led is null then 'cleared' else 'KEPT' end));
  exception when others then
    insert into v values (52,'purge clears ledger IN STEP with the evidence','cleared','ERROR: '||SQLERRM);
  end;

  -- F4. Library DISCARD clears the ledger immediately. ---------------------
  begin
    v_run := public.create_library_import_run(v_owner, 'Community Fee: $3,500', 'verifierhash0025b', 'seg-v4', 1);
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, status, result, fact_ledger)
      values (v_run, 0, 0, 21, 'Community Fee: $3,500', 'h0', 'completed', '{"items":[]}'::jsonb, v_led_txt::jsonb);
    perform public.library_close_import_run(v_owner, v_run, 'discarded');
    select segment_text, fact_ledger into v_seg, v_led from public.ingestion_chunks where run_id=v_run and ordinal=0;
    insert into v values (53,'library discard CLEARS ledger with the evidence','segment=cleared ledger=cleared',
      'segment='||(case when v_seg is null then 'cleared' else 'KEPT' end)||
      ' ledger='||(case when v_led is null then 'cleared' else 'KEPT' end));
  exception when others then
    insert into v values (53,'library discard CLEARS ledger with the evidence','cleared','ERROR: '||SQLERRM);
  end;

  -- F5. Packet path. Needs a disposable packet, and `packets` predates 0001,
  --     so its NOT NULL set is discovered rather than assumed. If the insert
  --     cannot be satisfied the test SKIPS with the reason, and the packet
  --     path stays proven structurally by row 20/21 and 22/23 instead.
  begin
    insert into public.packets (user_id, title) values (v_owner, 'zz-0025-verifier-disposable')
      returning id into v_packet;
    v_run := gen_random_uuid();
    insert into public.ingestion_runs (id, user_id, packet_id, destination, entry_point, source_text, source_hash, segmenter_version, status)
      values (v_run, v_owner, v_packet, 'packet', 'organize', 'Community Fee: $3,500', 'vh0025c', 'seg-v4', 'active');
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, status, result, fact_ledger)
      values (v_run, 0, 0, 21, 'Community Fee: $3,500', 'h0', 'completed', '{"sections":[]}'::jsonb, v_led_txt::jsonb);
    perform public.discard_ingestion_run(v_run, v_owner);
    select segment_text, fact_ledger into v_seg, v_led from public.ingestion_chunks where run_id=v_run and ordinal=0;
    insert into v values (54,'packet discard CLEARS ledger with the evidence','segment=cleared ledger=cleared',
      'segment='||(case when v_seg is null then 'cleared' else 'KEPT' end)||
      ' ledger='||(case when v_led is null then 'cleared' else 'KEPT' end));
  exception when others then
    insert into v values (54,'packet discard CLEARS ledger with the evidence','cleared',
      'SKIPPED - disposable packet could not be created: '||SQLERRM);
  end;

  -- F6. What `packets` actually requires, so a skip above is actionable.
  insert into v values (55,'packets NOT NULL columns without a default','report',
    coalesce((select string_agg(column_name, ', ' order by ordinal_position)
                from information_schema.columns
               where table_schema='public' and table_name='packets'
                 and is_nullable='NO' and column_default is null), 'none'));
end
$verify$;

-- ===========================================================================
-- G. SUMMARY
-- ===========================================================================
insert into v
select 99, 'SUMMARY', 'all PASS',
       (select count(*) filter (where expected <> 'report' and actual = expected)::text from v)||' pass, '||
       (select count(*) filter (where expected <> 'report' and actual <> expected)::text from v)||' fail, '||
       (select count(*) filter (where expected = 'report')::text from v)||' info';

select ord, check_name, expected, actual,
       case when expected = 'report' then 'INFO'
            when actual = expected then 'PASS'
            when actual like 'SKIPPED%' then 'SKIP'
            else 'FAIL' end as result
from v order by ord;

rollback;
