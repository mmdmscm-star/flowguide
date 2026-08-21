-- 0027 POST-APPLY VERIFIER.
--
-- Part A reads the catalog. Part B actually CALLS the function against a
-- fixture run and asserts what it did — because "the code says it raises" and
-- "it raises" are different claims, and only the second one is evidence.
--
-- The whole file is BEGIN ... ROLLBACK. There is deliberately no COMMIT: the
-- fixture run, its review JSON and every mutation made here are discarded.
begin;

create temp table v(ord numeric, check_name text, expected text, actual text) on commit drop;

-- ===========================================================================
-- PART A — security posture, from the catalog
-- ===========================================================================
insert into v
select 1, 'resolve_review_unit exists with the 4-arg signature', '1',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='resolve_review_unit'
           and pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, text, text')
union all
select 2, 'is SECURITY DEFINER', 'true',
       coalesce((select p.prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='resolve_review_unit'),'missing')
union all
-- SECURITY DEFINER runs as the owner. Without a pinned search_path the caller
-- chooses which schema's objects that privileged body resolves to.
select 3, 'search_path is pinned', 'search_path=',
       coalesce((select array_to_string(p.proconfig,',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='resolve_review_unit'),'NOT PINNED')
union all
-- The default EXECUTE grant to PUBLIC is the one that actually matters: every
-- authenticated visitor inherits it. Absence of an ACL entry is NOT proof of
-- absence of privilege, so this asserts an explicit, non-null ACL.
select 4, 'proacl is explicit (not left at the PUBLIC default)', 'explicit',
       coalesce((select case when p.proacl is null then 'DEFAULT — PUBLIC CAN EXECUTE' else 'explicit' end
                   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='resolve_review_unit'),'missing')
union all
select 5, 'no EXECUTE for PUBLIC, anon or authenticated', '0',
       (select coalesce(count(*),0)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
               lateral aclexplode(p.proacl) a left join pg_roles r on r.oid=a.grantee
         where n.nspname='public' and p.proname='resolve_review_unit'
           and a.privilege_type='EXECUTE'
           and (a.grantee = 0 or r.rolname in ('anon','authenticated')))
union all
select 6, 'service_role can execute', '1',
       (select coalesce(count(*),0)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
               lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
         where n.nspname='public' and p.proname='resolve_review_unit'
           and a.privilege_type='EXECUTE' and r.rolname='service_role')
union all
select 7, 'every object reference inside the body is schema-qualified', '0',
       (select coalesce(count(*),0)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='resolve_review_unit'
           and p.prosrc ~ '[^.]\yingestion_runs\y');

-- ===========================================================================
-- PART B — behaviour, against a fixture
-- ===========================================================================
do $b$
declare
  v_user uuid; v_run uuid; v_dup uuid; v_res jsonb; v_a text; v_rev jsonb;
  v_items_before text; v_items_after text;
begin
  -- A library-destination run needs no packet row. Pick an owner with no run
  -- occupying the one-active slot, so the fixture cannot collide with real work.
  select u.id into v_user from public.users u
   where not exists (select 1 from public.ingestion_runs r
                      where r.user_id=u.id and r.status in ('active','finalizing','needs_review'))
   limit 1;
  -- ABSENCE READS AS SUCCESS: with no owner the fixture never builds, every
  -- later comparison sees NULL, and NULL <> expected reads as a clean FAIL only
  -- if we say so here. Fail loudly instead of testing nothing.
  if v_user is null then raise exception '0027-verify: no eligible fixture owner'; end if;

  select md5(coalesce(string_agg(l.id::text || l.title, '|' order by l.id), 'none'))
    into v_items_before from public.library_items l where l.user_id = v_user;

  insert into public.ingestion_runs
    (user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status, review)
  values (v_user, null, 'library', 'library_import', 'verify-0027', 'verify', 'needs_review', $j$
    {"ok": false, "summary": "3 units need review", "customKey": "must survive",
     "failures": [
       {"id":"u-a","code":"unresolved_unit","text":"VERBATIM A","itemIds":["i1"],"status":"unresolved"},
       {"id":"u-b","code":"unresolved_unit","text":"VERBATIM B","itemIds":["i2"]},
       {"id":"u-c","code":"unresolved_unit","text":"VERBATIM C","itemIds":["i3"],"status":"unresolved"}
     ]}
  $j$::jsonb) returning id into v_run;

  -- 8. status whitelist
  begin perform public.resolve_review_unit(v_user, v_run, 'u-a', 'deleted'); v_a := 'NO ERROR';
  exception when others then v_a := 'rejected'; end;
  insert into v values (8, 'p_status outside resolved|ignored is rejected', 'rejected', v_a);

  -- 9. ownership. p_owner is checked against the run, not trusted.
  begin perform public.resolve_review_unit(gen_random_uuid(), v_run, 'u-a', 'resolved'); v_a := 'NO ERROR';
  exception when others then v_a := 'rejected'; end;
  insert into v values (9, 'a caller who does not own the run is rejected', 'rejected', v_a);

  -- 10. unknown unit
  begin perform public.resolve_review_unit(v_user, v_run, 'no-such-unit', 'resolved'); v_a := 'NO ERROR';
  exception when others then v_a := 'rejected'; end;
  insert into v values (10, 'an unknown unit id is not-found, not a no-op success', 'rejected', v_a);

  -- 11. duplicate ids must FAIL rather than mutate one of two indistinguishable units
  insert into public.ingestion_runs
    (user_id, packet_id, destination, entry_point, source_hash, segmenter_version, status, review)
  values (v_user, null, 'library', 'library_import', 'verify-0027-dup', 'verify', 'needs_review', $d$
    {"ok": false, "failures":[{"id":"dup","text":"X","status":"unresolved"},
                              {"id":"dup","text":"Y","status":"unresolved"}]}
  $d$::jsonb) returning id into v_dup;
  begin perform public.resolve_review_unit(v_user, v_dup, 'dup', 'resolved'); v_a := 'NO ERROR';
  exception when others then v_a := 'rejected'; end;
  insert into v values (11, 'duplicate unit ids fail rather than mutate ambiguously', 'rejected', v_a);
  insert into v values (12, 'the ambiguous run was left completely untouched', 'both intact',
    (select case when count(*)=2 then 'both intact' else 'MUTATED' end
       from public.ingestion_runs r, lateral jsonb_array_elements(r.review->'failures') f
      where r.id=v_dup and f ? 'text' and coalesce(f->>'status','unresolved')='unresolved'));

  -- 13-16. resolve one unit
  v_res := public.resolve_review_unit(v_user, v_run, 'u-a', 'resolved');
  insert into v values (13, 'resolving reports changed', 'true', v_res->>'changed');
  -- u-b carries NO status key at all — the legacy shape. If it were excluded
  -- from the remaining count the run would finalize with real work still in it.
  insert into v values (14, 'a legacy unit with no status counts as unresolved', '2', v_res->>'remaining');
  insert into v values (15, 'the run stays in needs_review while units remain', 'needs_review',
    (select status from public.ingestion_runs where id=v_run));

  select review into v_rev from public.ingestion_runs where id=v_run;
  insert into v values (16, 'the verbatim excerpt is removed from the resolved unit', 'gone',
    (select case when f ? 'text' then 'STILL PRESENT' else 'gone' end
       from jsonb_array_elements(v_rev->'failures') f where f->>'id'='u-a'));
  insert into v values (17, 'audit metadata and a resolution timestamp are retained', 'kept',
    (select case when f->>'code'='unresolved_unit' and f->'itemIds'=$i$["i1"]$i$::jsonb
                  and f->>'status'='resolved' and f->>'resolved_at' is not null
                 then 'kept' else 'LOST: '||f::text end
       from jsonb_array_elements(v_rev->'failures') f where f->>'id'='u-a'));
  insert into v values (18, 'unrelated units keep their own text untouched', '2',
    (select count(*)::text from jsonb_array_elements(v_rev->'failures') f
      where f->>'id' in ('u-b','u-c') and f->>'text' is not null));
  insert into v values (19, 'unrelated review keys survive the update', 'must survive',
    coalesce(v_rev->>'customKey','LOST'));
  insert into v values (20, 'failure order is preserved', 'u-a,u-b,u-c',
    (select string_agg(f->>'id', ',') from jsonb_array_elements(v_rev->'failures') f));

  -- 21. stale client replays the same resolution
  v_res := public.resolve_review_unit(v_user, v_run, 'u-a', 'ignored');
  insert into v values (21, 'a stale repeat is idempotent, not an overwrite', 'false', v_res->>'changed');
  insert into v values (22, 'the original resolution stands', 'resolved',
    (select f->>'status' from public.ingestion_runs r, lateral jsonb_array_elements(r.review->'failures') f
      where r.id=v_run and f->>'id'='u-a'));

  -- 23. the legacy unit resolves normally
  v_res := public.resolve_review_unit(v_user, v_run, 'u-b', 'resolved');
  insert into v values (23, 'the legacy unit resolves and one remains', '1', v_res->>'remaining');
  insert into v values (24, 'still blocked while one remains', 'needs_review',
    (select status from public.ingestion_runs where id=v_run));

  -- 25+. the LAST unit — ignored, not resolved, must transition identically
  v_res := public.resolve_review_unit(v_user, v_run, 'u-c', 'ignored');
  insert into v values (25, 'the last unit clears the run', '0', v_res->>'remaining');
  select review into v_rev from public.ingestion_runs where id=v_run;
  insert into v values (26, 'the run transitions to finalized', 'finalized',
    (select status from public.ingestion_runs where id=v_run));
  insert into v values (27, 'finalized_at is stamped', 'stamped',
    (select case when finalized_at is null then 'NULL' else 'stamped' end
       from public.ingestion_runs where id=v_run));
  -- The JSON must not still read "failed" while the run reads finalized.
  insert into v values (28, 'review.ok agrees with the finalized status', 'true', (v_rev->>'ok'));
  insert into v values (29, 'the stale failure summary is cleared', '', coalesce(v_rev->>'summary','NULL'));
  insert into v values (30, 'no verbatim text survives anywhere in review', '0',
    (select count(*)::text from jsonb_array_elements(v_rev->'failures') f where f ? 'text'));
  insert into v values (31, 'every unit kept its audit row', '3',
    (select jsonb_array_length(v_rev->'failures')::text));

  -- 32. the one-active-run slot is free again, in the same transaction
  insert into v values (32, 'the one-active-run slot is released', '0',
    (select count(*)::text from public.ingestion_runs
      where user_id=v_user and status in ('active','finalizing','needs_review') and id=v_run));

  -- 33. blast radius
  select md5(coalesce(string_agg(l.id::text || l.title, '|' order by l.id), 'none'))
    into v_items_after from public.library_items l where l.user_id = v_user;
  insert into v values (33, 'no packet or item content was touched', v_items_before, v_items_after);

  -- 34. a finalized run no longer accepts resolutions
  begin perform public.resolve_review_unit(v_user, v_run, 'u-a', 'resolved'); v_a := 'NO ERROR';
  exception when others then v_a := 'rejected'; end;
  insert into v values (34, 'a run outside needs_review rejects resolutions', 'rejected', v_a);
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
