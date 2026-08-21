-- 0028 POST-APPLY VERIFIER.
--
-- Part A reads the catalog. Part B makes the clearers actually RUN against a
-- fixture and checks what survived - because "the body contains review_units =
-- null" and "the column is cleared" are different claims.
--
-- BEGIN ... ROLLBACK, deliberately no COMMIT.
begin;

create temp table v(ord numeric, check_name text, expected text, actual text) on commit drop;

-- ===========================================================================
-- PART A - structure
-- ===========================================================================
insert into v
select 1, 'review_units exists on ingestion_chunks', 'jsonb',
       coalesce((select data_type from information_schema.columns
                  where table_schema='public' and table_name='ingestion_chunks'
                    and column_name='review_units'),'ABSENT')
union all
-- Nullable on purpose: "cleared" and "never had any" are the same state, and
-- the purge-eligibility predicate keys off IS NOT NULL.
select 2, 'review_units is nullable, so cleared and empty are one state', 'YES',
       coalesce((select is_nullable from information_schema.columns
                  where table_schema='public' and table_name='ingestion_chunks'
                    and column_name='review_units'),'ABSENT')
union all
select 3, 'fact_ledger still exists beside it', 'jsonb',
       coalesce((select data_type from information_schema.columns
                  where table_schema='public' and table_name='ingestion_chunks'
                    and column_name='fact_ledger'),'ABSENT')
union all
select 4, 'the column is documented', 'documented',
       coalesce((select case when col_description('public.ingestion_chunks'::regclass, ordinal_position::int) is null
                             then 'NO COMMENT' else 'documented' end
                   from information_schema.columns
                  where table_schema='public' and table_name='ingestion_chunks'
                    and column_name='review_units'),'ABSENT')
union all
-- Still exactly two clearers, and both now clear the new column.
select 5, 'both evidence clearers clear review_units', '2',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.prosrc ~ 'segment_text\s*=\s*null'
           and p.prosrc ~ 'review_units\s*=\s*null')
union all
select 6, 'and no clearer was left behind', '2',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.prosrc ~ 'segment_text\s*=\s*null')
union all
select 7, 'a review_units-only chunk is still purge-eligible', '1',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='purge_ingestion_evidence'
           and p.prosrc ~ 'c\.review_units is not null')
union all
-- ingestion_runs.review is the DURABLE creator-facing state and must remain
-- outside the evidence lifecycle entirely.
select 8, 'purge still never touches ingestion_runs.review', '0',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='purge_ingestion_evidence'
           and p.prosrc ~ '\yreview\y' and p.prosrc !~ 'review_units')
union all
select 9, 'library close still never touches ingestion_runs.review', '0',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='library_close_import_run'
           and p.prosrc ~ 'set review\s*=')
union all
select 10, 'resolve_review_unit (0027) is untouched by 0028', '1',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='resolve_review_unit')
union all
select 11, 'anon/authenticated still have no privileges on ingestion_chunks', '0',
       (select count(*)::text from information_schema.role_table_grants
         where table_schema='public' and table_name='ingestion_chunks' and grantee in ('anon','authenticated'));

-- ===========================================================================
-- PART B - the clearers, actually run
-- ===========================================================================
do $b$
declare
  v_user uuid; v_run uuid; v_chunk uuid; v_lib uuid; v_libchunk uuid;
  v_units jsonb := '[{"id":"u_test","code":"privacy_rejected","text":"VERBATIM HELD PROSE","status":"unresolved"}]'::jsonb;
begin
  select u.id into v_user from public.users u
   where not exists (select 1 from public.ingestion_runs r
                      where r.user_id=u.id and r.status in ('active','finalizing','needs_review'))
   limit 1;
  -- ABSENCE READS AS SUCCESS: with no owner nothing below is exercised at all.
  if v_user is null then raise exception '0028-verify: no eligible fixture owner'; end if;

  -- ---- purge: an EXPIRED run whose chunk holds ONLY review_units ----------
  insert into public.ingestion_runs
    (user_id, packet_id, destination, entry_point, source_hash, segmenter_version,
     status, evidence_purge_after)
  values (v_user, null, 'library', 'library_import', 'verify-0028', 'verify',
          'finalized', now() - interval '1 day')
  returning id into v_run;
  -- result, segment_text and fact_ledger are ALL null. Under the pre-0028
  -- predicate this chunk was invisible to purge, and the excerpt below would
  -- have sat outside every lifecycle for ever.
  insert into public.ingestion_chunks
    (run_id, ordinal, source_start, source_end, segment_hash, status, review_units)
  values (v_run, 0, 0, 10, 'verify-0028-seg', 'completed', v_units)
  returning id into v_chunk;

  insert into v values (12, 'the fixture chunk holds only review_units', 'only review_units',
    (select case when result is null and segment_text is null and fact_ledger is null
                  and review_units is not null then 'only review_units' else 'MIXED' end
       from public.ingestion_chunks where id = v_chunk));

  perform public.purge_ingestion_evidence();

  insert into v values (13, 'purge clears review_units', 'cleared',
    (select case when review_units is null then 'cleared' else 'STILL PRESENT' end
       from public.ingestion_chunks where id = v_chunk));
  insert into v values (14, 'and the verbatim excerpt is gone with it', '0',
    (select count(*)::text from public.ingestion_chunks
      where id = v_chunk and review_units::text ~ 'VERBATIM HELD PROSE'));

  -- ---- library close (discard): clears the transport channel --------------
  insert into public.ingestion_runs
    (user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status)
  values (v_user, null, 'library', 'library_import', 'verify-0028-lib', 'verify', 'active')
  returning id into v_lib;
  insert into public.ingestion_chunks
    (run_id, ordinal, source_start, source_end, segment_hash, status, segment_text, review_units)
  values (v_lib, 0, 0, 10, 'verify-0028-lib-seg', 'completed', 'some source', v_units)
  returning id into v_libchunk;

  perform public.library_close_import_run(v_user, v_lib, 'discarded');

  insert into v values (15, 'library close clears review_units with the rest', 'cleared',
    (select case when review_units is null then 'cleared' else 'STILL PRESENT' end
       from public.ingestion_chunks where id = v_libchunk));
  -- This is the ROLLOUT BLOCKER, stated as a fact rather than a worry: on the
  -- Library path the units are cleared and nothing ever showed them.
  insert into v values (16, 'library close leaves NO review state behind (the known gap)', 'no review state',
    (select case when jsonb_array_length(coalesce(review->'failures','[]'::jsonb)) = 0
                 then 'no review state' else 'has review state' end
       from public.ingestion_runs where id = v_lib));
end
$b$;

select ord, check_name, expected, actual,
       case when expected = actual then 'PASS' else 'FAIL' end as result
from v
union all
select 99, 'SUMMARY', 'all PASS',
       (select count(*) filter (where expected=actual)::text || ' PASS / '
             || count(*) filter (where expected is distinct from actual)::text || ' FAIL' from v),
       (select case when count(*) filter (where expected is distinct from actual) = 0
                    then 'PASS' else 'FAIL' end from v)
order by ord;

rollback;
