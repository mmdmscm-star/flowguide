-- 0021 STEP 4 — POST-APPLY VERIFICATION.
--
-- WRITES NOTHING. One transaction, ending in ROLLBACK. It creates a disposable
-- user, packet, runs and proposals — and briefly a fault-injection trigger —
-- because atomicity and refusal can only be proven by making them happen. None
-- of it commits.
--
-- Read the last column. Every row must be ok = true.
--
-- The expected body hashes below were generated mechanically from the applied
-- migration files, never typed:
--   finalize / discard / library_save_proposal  <- 0021
--   the four chunk-engine functions             <- 0012, which has never been
--                                                  superseded for them
--
-- As a cross-check on the mechanical construction: finalize grew 12148 -> 12781
-- bytes and discard 2334 -> 2967. Both +633, the same guard block, inserted once
-- in each.

begin;

create temp table verify_0021 (
  n int, check_name text, expected text, actual text, ok boolean
) on commit drop;

create temp table expected_body (proname text primary key, md5 text) on commit drop;
insert into expected_body values
  ('finalize_ingestion_run', 'e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run', 'ba0545d9bea5926905adbdb436df3247'),
  ('library_save_proposal', '75c84eaa4bd23ca0dbd96b2bbe1d5074'),
  ('claim_chunk', 'f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result', '1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed', 'a8fb32eef936a61405220661c221a48c'),
  ('split_chunk', 'db8e798dcbed4fb9c4e30c2b00317bcb');

create temp table fixture (k text primary key, v uuid) on commit drop;

-- ===========================================================================
-- ROW 0 — READ THIS FIRST.
--
-- Everything below assumes the editor honours BEGIN/ROLLBACK. The 0020
-- verification created disposable users and rolled back; if any survived, this
-- session does NOT roll back and the script must not run. Row 0 is that
-- evidence, and the fault-injection section aborts on it independently.
-- ===========================================================================
insert into verify_0021
select 0, 'earlier verification steps rolled back cleanly (no stray fixtures)',
       '0 stray users',
       (select count(*)::text from public.users
         where email like '0020-verify%' or email like '0021-verify%'),
       (select count(*) from public.users
         where email like '0020-verify%' or email like '0021-verify%') = 0;

-- ===========================================================================
-- A. THE REVIEW LAYER
-- ===========================================================================
insert into verify_0021
select 1, 'library_import_proposals exists', 'present',
       coalesce(to_regclass('public.library_import_proposals')::text, 'MISSING'),
       to_regclass('public.library_import_proposals') is not null;

insert into verify_0021
select 2, 'RLS enabled, and NO policy (service role only)', 'rls=true, policies=0',
       'rls=' || coalesce((select c.relrowsecurity::text from pg_class c
                             join pg_namespace ns on ns.oid = c.relnamespace
                            where ns.nspname='public' and c.relname='library_import_proposals'), '?')
         || ', policies=' || (select count(*)::text from pg_policies
                               where schemaname='public' and tablename='library_import_proposals'),
       coalesce((select c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
                  where ns.nspname='public' and c.relname='library_import_proposals'), false)
       and (select count(*) from pg_policies
             where schemaname='public' and tablename='library_import_proposals') = 0;

insert into verify_0021
select 3, 'identity key is unique (run_id, ordinal, idx)', 'one unique constraint on those 3',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid='public.library_import_proposals'::regclass and contype='u'), 'MISSING'),
       coalesce((select pg_get_constraintdef(oid) ilike '%run_id, ordinal, idx%' from pg_constraint
                  where conrelid='public.library_import_proposals'::regclass and contype='u'), false);

insert into verify_0021
select 4, 'payload must be a jsonb OBJECT', 'check present',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid='public.library_import_proposals'::regclass and contype='c'
                    and pg_get_constraintdef(oid) ilike '%jsonb_typeof%'), 'MISSING'),
       exists (select 1 from pg_constraint
                where conrelid='public.library_import_proposals'::regclass and contype='c'
                  and pg_get_constraintdef(oid) ilike '%jsonb_typeof%');

insert into verify_0021
select 5, 'proposals cascade when their run goes', 'ON DELETE CASCADE to ingestion_runs',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid='public.library_import_proposals'::regclass and contype='f'), 'MISSING'),
       coalesce((select pg_get_constraintdef(oid) ilike '%ingestion_runs%on delete cascade%'
                   from pg_constraint
                  where conrelid='public.library_import_proposals'::regclass and contype='f'), false);

insert into verify_0021
select 6, 'NO library_item_id bookkeeping column', 'absent',
       coalesce((select 'PRESENT' from information_schema.columns
                  where table_schema='public' and table_name='library_import_proposals'
                    and column_name='library_item_id'), 'absent'),
       not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='library_import_proposals'
                      and column_name='library_item_id');

-- ===========================================================================
-- B. library_save_proposal — shape and privileges
-- ===========================================================================
insert into verify_0021
select 7, 'library_save_proposal is security definer with a pinned search_path',
       'secdef=true, search_path set',
       coalesce((select 'secdef=' || p.prosecdef::text || ', ' ||
                        coalesce(array_to_string(p.proconfig, ','), '(none)')
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), 'MISSING'),
       coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig,','),'') like 'search_path=%'
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), false);

-- PUBLIC is a pseudo-role and cannot be passed to has_function_privilege, so the
-- ACL is read directly. A NULL proacl means DEFAULT privileges, which for a
-- function INCLUDE execute by PUBLIC — that is the trap 0015 was written for.
insert into verify_0021
select 8, 'only service_role may execute it', 'no PUBLIC / anon / authenticated',
       coalesce((select coalesce(array_to_string(p.proacl, ' '), 'DEFAULT — PUBLIC CAN EXECUTE')
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), 'MISSING'),
       coalesce((select p.proacl is not null
                     and array_to_string(p.proacl,' ') !~ '(^| )=X'
                     and array_to_string(p.proacl,' ') not like '%anon=X%'
                     and array_to_string(p.proacl,' ') not like '%authenticated=X%'
                   from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                  where ns.nspname='public' and p.proname='library_save_proposal'), false);

-- ===========================================================================
-- C+D. FULL BODY VERIFICATION — the guarded functions, and the untouched engine.
--
-- prosrc is the verbatim stored body. pg_get_functiondef would not do: it
-- rebuilds the header from catalog metadata, so it can never equal a lower-case
-- source file.
-- ===========================================================================
insert into verify_0021
select 9 + row_number() over (order by e.proname),
       'body md5 == source: ' || e.proname,
       e.md5,
       coalesce(md5(p.prosrc), 'FUNCTION MISSING'),
       coalesce(md5(p.prosrc) = e.md5, false)
  from expected_body e
  left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public')
    on p.proname = e.proname;

-- ===========================================================================
-- E–H. BEHAVIOUR. Fixtures first.
-- ===========================================================================
do $fixtures$
declare v_user uuid; v_packet uuid; v_lib uuid; v_pkt_run uuid; v_prop uuid; v_rev bigint;
begin
  insert into public.users(email) values ('0021-verify@disposable.invalid') returning id into v_user;
  insert into public.packets(user_id, slug, title, status, composition_mode, raw_input)
    values (v_user, '0021-verify-packet', '0021 verify', 'draft', 'legacy', '')
    returning id, content_rev into v_packet, v_rev;

  insert into public.ingestion_runs(user_id, packet_id, destination, entry_point,
                                    source_hash, segmenter_version, status)
    values (v_user, null, 'library', 'library_import', 'h', 'v4', 'active')
    returning id into v_lib;

  insert into public.ingestion_runs(user_id, packet_id, destination, entry_point,
                                    source_hash, segmenter_version, status, baseline_content_rev)
    values (v_user, v_packet, 'packet', 'organize', 'h', 'v4', 'active', v_rev)
    returning id into v_pkt_run;

  insert into public.library_import_proposals(run_id, ordinal, idx, payload)
    values (v_lib, 0, 0, jsonb_build_object(
      'title','Brookdale Chanate', 'address','3800 Chanate Rd',
      'description','Assisted living and memory care.', 'notes','',
      'details', jsonb_build_array(jsonb_build_object('label','AL Studio','value','$4,500/mo')),
      'links', jsonb_build_array(), 'photos', jsonb_build_array(), 'contacts', jsonb_build_array()))
    returning id into v_prop;

  insert into fixture values ('user',v_user),('packet',v_packet),('lib_run',v_lib),
                             ('pkt_run',v_pkt_run),('proposal',v_prop);
end
$fixtures$;

-- ---- E. the packet path REFUSES a library run ------------------------------
do $refuse$
declare v_user uuid; v_lib uuid; v_pkt uuid;
begin
  select v into v_user from fixture where k='user';
  select v into v_lib  from fixture where k='lib_run';
  select v into v_pkt  from fixture where k='pkt_run';

  begin
    perform public.finalize_ingestion_run(v_lib, v_user);
    insert into verify_0021 values (20,'finalize REFUSES a library run','raises destination error','completed — GUARD MISSING',false);
  exception when others then
    insert into verify_0021 values (20,'finalize REFUSES a library run','raises destination error',
      sqlerrm, sqlerrm ilike '%cannot use the packet path%');
  end;

  begin
    perform public.discard_ingestion_run(v_lib, v_user);
    insert into verify_0021 values (21,'discard REFUSES a library run','raises destination error','completed — GUARD MISSING',false);
  exception when others then
    insert into verify_0021 values (21,'discard REFUSES a library run','raises destination error',
      sqlerrm, sqlerrm ilike '%cannot use the packet path%');
  end;

  -- ...and does NOT refuse a packet run. A guard that rejects everything would
  -- pass a refusal-only test suite.
  --
  -- ORDER MATTERS: discard first, then finalize the now-discarded run. The guard
  -- sits BEFORE the status checks, so if it did not fire we get a STATUS error —
  -- which is exactly the distinction being proven, and it does not depend on
  -- finalize succeeding.
  begin
    perform public.discard_ingestion_run(v_pkt, v_user);
    insert into verify_0021 values (22,'discard still works on a packet run','succeeds','succeeded',true);
  exception when others then
    insert into verify_0021 values (22,'discard still works on a packet run','succeeds',
      'RAISED: ' || sqlerrm, false);
  end;

  begin
    perform public.finalize_ingestion_run(v_pkt, v_user);
    insert into verify_0021 values (23,'finalize does NOT refuse a packet run',
      'a status error, never a destination error','completed',true);
  exception when others then
    insert into verify_0021 values (23,'finalize does NOT refuse a packet run',
      'a status error, never a destination error',
      sqlerrm, sqlerrm not ilike '%cannot use the packet path%');
  end;
end
$refuse$;

-- ---- F. FAULT INJECTION at exactly the boundary in question ---------------
--
-- A trigger that raises on the proposal DELETE. The insert into library_items
-- has already happened by then. If the two writes were not one transaction, the
-- Library item would survive. This is the crash-between-two-writes scenario,
-- made to happen on purpose.
-- SAFETY GATE. Everything in this script depends on the editor honouring the
-- explicit BEGIN/ROLLBACK. If it did not, the 0020 verification would have left
-- its disposable users behind — so their absence is direct evidence that rollback
-- works here. If they ARE present, this aborts BEFORE creating a trigger that
-- would then be permanent.
do $gate$
begin
  -- Only the 0020 fixtures, and any leftover of THIS script from a previous
  -- attempt. Deliberately not '0021-verify%': this block runs after the fixtures
  -- section, which creates exactly such a user, and checking for it here would
  -- abort every single run.
  if exists (select 1 from public.users where email like '0020-verify%') then
    raise exception 'ABORT: 0020 verification fixtures are still present, so this session did not roll back. The fault-injection trigger must not be created.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname = 'tmp_0021_fault') then
    raise exception 'ABORT: tmp_0021_fault already exists — a previous run of this script did not roll back.';
  end if;
  execute 'create function public.tmp_0021_fault() returns trigger language plpgsql as $f$ begin raise exception ''INJECTED FAULT at the proposal delete''; end $f$';
  execute 'create trigger tmp_0021_fault_trg after delete on public.library_import_proposals for each row execute function public.tmp_0021_fault()';
end
$gate$;

do $inject$
declare v_user uuid; v_lib uuid; v_prop uuid; v_items int; v_props int;
begin
  select v into v_user from fixture where k='user';
  select v into v_lib  from fixture where k='lib_run';
  select v into v_prop from fixture where k='proposal';

  begin
    perform public.library_save_proposal(v_user, v_lib, v_prop);
    insert into verify_0021 values (24,'a fault at the delete aborts the whole save',
      'raises', 'completed — the delete did not fire?', false);
  exception when others then
    select count(*) into v_items from public.library_items where user_id = v_user;
    select count(*) into v_props from public.library_import_proposals where id = v_prop;
    insert into verify_0021 values (24,
      'FAULT INJECTION: the library_items insert is rolled back with the failed delete',
      '0 library items, proposal still present',
      v_items::text || ' library items, ' || v_props::text || ' proposal(s)',
      v_items = 0 and v_props = 1);
  end;
end
$inject$;

drop trigger if exists tmp_0021_fault_trg on public.library_import_proposals;
drop function if exists public.tmp_0021_fault();

-- ---- G. the real save, then an idempotent retry ---------------------------
do $save$
declare v_user uuid; v_lib uuid; v_prop uuid; v_new uuid; v_again uuid; v_items int; v_props int;
begin
  select v into v_user from fixture where k='user';
  select v into v_lib  from fixture where k='lib_run';
  select v into v_prop from fixture where k='proposal';

  v_new := public.library_save_proposal(v_user, v_lib, v_prop);
  select count(*) into v_items from public.library_items where user_id = v_user;
  select count(*) into v_props from public.library_import_proposals where id = v_prop;
  insert into verify_0021 values (25,'with no fault, the save creates the item and consumes the proposal',
    '1 item, 0 proposals, id returned',
    v_items::text || ' item(s), ' || v_props::text || ' proposal(s), id=' || coalesce(v_new::text,'null'),
    v_items = 1 and v_props = 0 and v_new is not null);

  -- THE RETRY. Exactly what a client re-sending after a timeout does.
  v_again := public.library_save_proposal(v_user, v_lib, v_prop);
  select count(*) into v_items from public.library_items where user_id = v_user;
  insert into verify_0021 values (26,'RETRY of a saved proposal is a no-op, not a duplicate',
    'returns null, still 1 item',
    'returned ' || coalesce(v_again::text,'null') || ', ' || v_items::text || ' item(s)',
    v_again is null and v_items = 1);

  -- the saved entry carries no packet lineage
  insert into verify_0021
  select 27, 'the imported entry records no packet lineage', 'source_packet_item_id is null',
         coalesce(source_packet_item_id::text,'null'), source_packet_item_id is null
    from public.library_items where user_id = v_user limit 1;

  -- and its content survived intact
  insert into verify_0021
  select 28, 'the payload reached library_items intact', 'title + detail present',
         title || ' / ' || coalesce(details::text,'null'),
         title = 'Brookdale Chanate' and details::text ilike '%AL Studio%'
    from public.library_items where user_id = v_user limit 1;
end
$save$;

-- ---- H. an untitled proposal is refused, not saved unfindable --------------
do $untitled$
declare v_user uuid; v_lib uuid; v_p2 uuid; v_items int;
begin
  select v into v_user from fixture where k='user';
  select v into v_lib  from fixture where k='lib_run';
  insert into public.library_import_proposals(run_id, ordinal, idx, payload)
    values (v_lib, 0, 1, jsonb_build_object('title','   ','description','no title'))
    returning id into v_p2;
  begin
    perform public.library_save_proposal(v_user, v_lib, v_p2);
    insert into verify_0021 values (29,'an untitled proposal is refused','raises','saved anyway',false);
  exception when others then
    select count(*) into v_items from public.library_items where user_id = v_user;
    insert into verify_0021 values (29,'an untitled proposal is refused','raises, nothing saved',
      sqlerrm || ' (' || v_items::text || ' item(s))',
      sqlerrm ilike '%no title%' and v_items = 1);
  end;
end
$untitled$;

-- ---- I. ownership and destination on the save itself -----------------------
do $authz$
declare v_user uuid; v_other uuid; v_lib uuid; v_pkt uuid; v_p3 uuid;
begin
  select v into v_user from fixture where k='user';
  select v into v_lib  from fixture where k='lib_run';
  select v into v_pkt  from fixture where k='pkt_run';
  insert into public.users(email) values ('0021-verify-other@disposable.invalid') returning id into v_other;
  insert into public.library_import_proposals(run_id, ordinal, idx, payload)
    values (v_lib, 0, 2, jsonb_build_object('title','Another')) returning id into v_p3;

  begin
    perform public.library_save_proposal(v_other, v_lib, v_p3);
    insert into verify_0021 values (30,'a non-owner cannot save from someone else''s import','raises','SAVED — OWNERSHIP HOLE',false);
  exception when others then
    insert into verify_0021 values (30,'a non-owner cannot save from someone else''s import','raises',
      sqlerrm, sqlerrm ilike '%does not own%');
  end;

  begin
    perform public.library_save_proposal(v_user, v_pkt, v_p3);
    insert into verify_0021 values (31,'the save refuses a PACKET run','raises','accepted — destination hole',false);
  exception when others then
    insert into verify_0021 values (31,'the save refuses a PACKET run','raises',
      sqlerrm, sqlerrm ilike '%not a library import%');
  end;
end
$authz$;

-- ===========================================================================
select n, check_name, expected, actual, ok from verify_0021 order by n;

select count(*) filter (where ok) || ' passed, ' ||
       count(*) filter (where not ok) || ' failed' as result,
       (count(*) filter (where not ok)) = 0 as all_green
  from verify_0021;

-- NOTHING ABOVE IS KEPT — including the fault trigger and its function.
rollback;
