-- 0022 STEP 4 — POST-APPLY VERIFICATION.
--
-- WRITES NOTHING. One transaction ending in ROLLBACK. It creates disposable
-- users, a packet, runs, chunks and proposals — and briefly a fault-injection
-- trigger — because atomicity and refusal can only be proven by making them
-- happen. None of it commits.
--
-- Read the last column. Every row must be ok = true. READ ROW 0 FIRST: if
-- earlier verification fixtures survived, this session does not roll back and
-- nothing below should be trusted.
--
-- All expected body hashes were generated mechanically from the applied
-- migration files, never typed.

begin;

create temp table v22 (n int, check_name text, expected text, actual text, ok boolean) on commit drop;
create temp table expected_body (proname text primary key, md5 text) on commit drop;
insert into expected_body values
  ('claim_chunk', 'f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result', '1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed', 'a8fb32eef936a61405220661c221a48c'),
  ('split_chunk', 'db8e798dcbed4fb9c4e30c2b00317bcb'),
  ('finalize_ingestion_run', 'e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run', 'ba0545d9bea5926905adbdb436df3247'),
  ('library_save_proposal', '75c84eaa4bd23ca0dbd96b2bbe1d5074'),
  ('create_library_import_run', '125d2df8015f704377399ab665ea9e2f'),
  ('library_materialize_proposals', 'df006c498ea0b94480454fb4ea331727'),
  ('library_close_import_run', 'e8d5eeb970fdd4596b98e85858923abf');
create temp table fx (k text primary key, v uuid) on commit drop;

insert into v22
select 0, 'earlier verification steps rolled back cleanly', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0;

-- ===========================================================================
-- A. EXISTENCE AND SIGNATURES
-- ===========================================================================
insert into v22
select 1, 'create_library_import_run signature',
       'p_owner uuid, p_source_text text, p_source_hash text, p_source_len integer, p_segmenter_version text, p_chunks jsonb -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_library_import_run'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_source_text text, p_source_hash text, p_source_len integer, p_segmenter_version text, p_chunks jsonb'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_library_import_run'), false);

insert into v22
select 2, 'library_materialize_proposals signature', 'p_owner uuid, p_run_id uuid -> integer',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_materialize_proposals'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_run_id uuid'
                    and pg_catalog.format_type(p.prorettype, null) = 'integer'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_materialize_proposals'), false);

insert into v22
select 3, 'library_close_import_run signature', 'p_owner uuid, p_run_id uuid, p_status text -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_close_import_run'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_run_id uuid, p_status text'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_close_import_run'), false);

insert into v22
select 4, 'no accidental overloads of the three', '1 each',
       (select coalesce(string_agg(proname || '=' || c, ', ' order by proname), 'none') from (
          select p.proname, count(*) c from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname='public' and p.proname in
             ('create_library_import_run','library_materialize_proposals','library_close_import_run')
           group by p.proname) t),
       (select count(*) = 3 and bool_and(c = 1) from (
          select p.proname, count(*) c from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname='public' and p.proname in
             ('create_library_import_run','library_materialize_proposals','library_close_import_run')
           group by p.proname) t);

-- ===========================================================================
-- B. PRIVILEGES AND search_path
--
-- PUBLIC is a pseudo-role and cannot be passed to has_function_privilege, so the
-- ACL is read directly. A NULL proacl means DEFAULT privileges, which for a
-- function INCLUDE execute by PUBLIC.
-- ===========================================================================
insert into v22
select 5 + row_number() over (order by p.proname),
       'service-role only + pinned empty search_path: ' || p.proname,
       'service_role=X only, search_path=""',
       coalesce(array_to_string(p.proacl, ' '), 'DEFAULT — PUBLIC CAN EXECUTE')
         || ' | ' || coalesce(array_to_string(p.proconfig, ','), '(none)')
         || ' | secdef=' || p.prosecdef::text,
       p.prosecdef
         and coalesce(array_to_string(p.proconfig, ','), '') in ('search_path=', 'search_path=""')
         and p.proacl is not null
         and array_to_string(p.proacl, ' ') !~ '(^| )=X'
         and array_to_string(p.proacl, ' ') not like '%anon=X%'
         and array_to_string(p.proacl, ' ') not like '%authenticated=X%'
         and array_to_string(p.proacl, ' ') like '%service_role=X%'
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname='public' and p.proname in
   ('create_library_import_run','library_materialize_proposals','library_close_import_run');

-- ===========================================================================
-- C. BODIES — the three new ones, and everything that must not have moved.
-- ===========================================================================
insert into v22
select 9 + row_number() over (order by e.proname),
       'body md5 == source: ' || e.proname, e.md5,
       coalesce(md5(p.prosrc), 'FUNCTION MISSING'),
       coalesce(md5(p.prosrc) = e.md5, false)
  from expected_body e
  left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname='public')
    on p.proname = e.proname;

-- ===========================================================================
-- D. NO NEW WRITERS
-- ===========================================================================
insert into v22
select 21, 'the three 0022 functions write no packet composition', 'none',
       (select coalesce(string_agg(p.proname, ', '), 'none')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname in
           ('create_library_import_run','library_materialize_proposals','library_close_import_run')
           and (p.prosrc ilike '%insert into public.packets%' or p.prosrc ilike '%insert into public.sections%'
             or p.prosrc ilike '%insert into public.items%'  or p.prosrc ilike '%insert into public.packet_blocks%')),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname='public' and p.proname in
                      ('create_library_import_run','library_materialize_proposals','library_close_import_run')
                      and (p.prosrc ilike '%insert into public.packets%' or p.prosrc ilike '%insert into public.sections%'
                        or p.prosrc ilike '%insert into public.items%'  or p.prosrc ilike '%insert into public.packet_blocks%'));

-- The decisive one: across the ENTIRE database, exactly two functions may insert
-- a library_items row, and 0022 introduced neither.
insert into v22
select 22, 'only the two known functions insert library_items',
       'library_save_as_new_from_item, library_save_proposal',
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'NONE')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.prosrc ilike '%insert into public.library_items%'),
       (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.prosrc ilike '%insert into public.library_items%')
         = 'library_save_as_new_from_item,library_save_proposal';

-- ===========================================================================
-- E. BEHAVIOUR
-- ===========================================================================
do $fx$
declare a uuid; b uuid; c uuid; pk uuid; pr uuid;
begin
  insert into public.users(email) values ('0022-verify-a@disposable.invalid') returning id into a;
  insert into public.users(email) values ('0022-verify-b@disposable.invalid') returning id into b;
  insert into public.users(email) values ('0022-verify-c@disposable.invalid') returning id into c;
  insert into public.packets(user_id, slug, title, status, composition_mode, raw_input)
    values (a, '0022-verify-packet', '0022 verify', 'draft', 'legacy', '') returning id into pk;
  insert into public.ingestion_runs(user_id, packet_id, destination, entry_point,
                                    source_hash, segmenter_version, status, baseline_content_rev)
    values (a, pk, 'packet', 'organize', 'ph', 'v4', 'active', 0) returning id into pr;
  insert into fx values ('a',a),('b',b),('c',c),('packet',pk),('pkt_run',pr);
end
$fx$;

-- ---- C1. create: a library run with NULL packet_id, plus its chunks ---------
do $create$
declare a uuid; res jsonb; run uuid; r record; nch int;
begin
  select v into a from fx where k='a';
  res := public.create_library_import_run(a, 'Brookdale. Oakmont.', 'hash-1', 19, 'seg-v4',
    jsonb_build_array(
      jsonb_build_object('ordinal',0,'source_start',0,'source_end',11,'segment_text','Brookdale.','segment_hash','h0','section_hint','','is_continuation',false),
      jsonb_build_object('ordinal',1,'source_start',11,'source_end',19,'segment_text','Oakmont.','segment_hash','h1','section_hint','','is_continuation',false)));
  run := (res->>'run_id')::uuid;
  insert into fx values ('lib_run', run);

  select * into r from public.ingestion_runs where id = run;
  select count(*) into nch from public.ingestion_chunks where run_id = run;
  insert into v22 values (23, 'create makes a library run with NULL packet_id, and its chunks',
    'destination=library, packet_id null, entry_point=library_import, 2 chunks, total_chunks=2',
    'destination=' || r.destination || ', packet_id=' || coalesce(r.packet_id::text,'null') ||
      ', entry_point=' || r.entry_point || ', ' || nch || ' chunks, total=' || r.total_chunks,
    r.destination = 'library' and r.packet_id is null and r.entry_point = 'library_import'
      and nch = 2 and r.total_chunks = 2);
exception when others then
  insert into v22 values (23, 'create makes a library run with NULL packet_id, and its chunks',
    'succeeds', 'RAISED: ' || sqlerrm, false);
end
$create$;

-- ---- C2. the same paste reconnects; a different paste is refused -----------
do $reuse$
declare a uuid; run uuid; res jsonb; n int;
begin
  select v into a from fx where k='a'; select v into run from fx where k='lib_run';
  res := public.create_library_import_run(a, 'Brookdale. Oakmont.', 'hash-1', 19, 'seg-v4',
    jsonb_build_array(jsonb_build_object('ordinal',0,'source_start',0,'source_end',19,'segment_text','x','segment_hash','h','section_hint','','is_continuation',false)));
  select count(*) into n from public.ingestion_runs where user_id = a and destination = 'library';
  insert into v22 values (24, 'the SAME paste reconnects instead of creating a second run',
    'reused=true, same id, still 1 run',
    'reused=' || (res->>'reused') || ', same=' || ((res->>'run_id')::uuid = run)::text || ', runs=' || n,
    (res->>'reused')::boolean and (res->>'run_id')::uuid = run and n = 1);

  begin
    perform public.create_library_import_run(a, 'Something else entirely', 'hash-2', 23, 'seg-v4',
      jsonb_build_array(jsonb_build_object('ordinal',0,'source_start',0,'source_end',23,'segment_text','y','segment_hash','h','section_hint','','is_continuation',false)));
    insert into v22 values (25, 'a DIFFERENT paste is refused while one is open','raises','accepted',false);
  exception when others then
    insert into v22 values (25, 'a DIFFERENT paste is refused while one is open','raises',
      sqlerrm, sqlerrm ilike '%already in progress%');
  end;
end
$reuse$;

-- ---- C3. ATOMICITY: a chunk failure must roll the run back too -------------
do $gate$
begin
  -- Any earlier step's fixtures, but NOT this script's own: the fixtures block
  -- above created 0022-verify users moments ago, and including them would abort
  -- every run. (LIKE has no character classes — an earlier '002[01]-verify%'
  -- here matched a literal bracket and would never have fired at all.)
  if exists (select 1 from public.users
              where email like '00%-verify%' and email not like '0022-verify%') then
    raise exception 'ABORT: earlier fixtures survive, so this session does not roll back';
  end if;
  execute 'create function public.tmp_0022_fault() returns trigger language plpgsql as $f$ begin raise exception ''INJECTED FAULT on chunk insert''; end $f$';
  execute 'create trigger tmp_0022_fault_trg after insert on public.ingestion_chunks for each row execute function public.tmp_0022_fault()';
end
$gate$;

do $atomic$
declare b uuid; nruns int;
begin
  select v into b from fx where k='b';
  begin
    perform public.create_library_import_run(b, 'text', 'hash-b', 4, 'seg-v4',
      jsonb_build_array(jsonb_build_object('ordinal',0,'source_start',0,'source_end',4,'segment_text','text','segment_hash','h','section_hint','','is_continuation',false)));
    insert into v22 values (26,'ATOMICITY: a chunk failure rolls back the run too','raises','completed — the trigger did not fire?',false);
  exception when others then
    select count(*) into nruns from public.ingestion_runs where user_id = b;
    insert into v22 values (26,
      'ATOMICITY: a failure inserting chunks leaves NO run behind',
      '0 runs for this professional', nruns || ' run(s)', nruns = 0);
  end;
end
$atomic$;

drop trigger if exists tmp_0022_fault_trg on public.ingestion_chunks;
drop function if exists public.tmp_0022_fault();

-- ---- D. materialise: refuses early, then idempotent ------------------------
do $mat$
declare a uuid; run uuid; n1 int; n2 int; pid uuid; t text;
begin
  select v into a from fx where k='a'; select v into run from fx where k='lib_run';

  begin
    perform public.library_materialize_proposals(a, run);
    insert into v22 values (27,'materialise REFUSES before extraction is complete','raises','accepted',false);
  exception when others then
    insert into v22 values (27,'materialise REFUSES before extraction is complete','raises',
      sqlerrm, sqlerrm ilike '%outstanding%');
  end;

  update public.ingestion_chunks set status='completed',
         result = jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('title','Brookdale Chanate','address','3800 Chanate Rd'),
           jsonb_build_object('title','Second Item')))
   where run_id = run and ordinal = 0;
  update public.ingestion_chunks set status='completed',
         result = jsonb_build_object('items', jsonb_build_array(jsonb_build_object('title','Oakmont')))
   where run_id = run and ordinal = 1;

  n1 := public.library_materialize_proposals(a, run);
  insert into v22 values (28,'materialise creates one proposal per extracted item','3', n1::text, n1 = 3);

  -- A REVIEWED EDIT, then a second materialise.
  select id into pid from public.library_import_proposals where run_id = run and ordinal = 0 and idx = 0;
  update public.library_import_proposals
     set payload = jsonb_set(payload, '{title}', '"EDITED BY THE PROFESSIONAL"'), selected = true
   where id = pid;

  n2 := public.library_materialize_proposals(a, run);
  select payload->>'title' into t from public.library_import_proposals where id = pid;
  insert into v22 values (29,
    'a REPEAT materialise inserts nothing and does not touch a reviewed edit',
    '0 inserted, edit intact', n2 || ' inserted, title=' || coalesce(t,'null'),
    n2 = 0 and t = 'EDITED BY THE PROFESSIONAL');
end
$mat$;

-- ---- E. close: only two statuses, and only the right runs ------------------
do $close$
declare a uuid; c uuid; run uuid; pr uuid; res jsonb; n int; st text; src text;
begin
  select v into a from fx where k='a'; select v into c from fx where k='c';
  select v into run from fx where k='lib_run'; select v into pr from fx where k='pkt_run';

  begin
    perform public.library_close_import_run(a, run, 'archived');
    insert into v22 values (30,'close REFUSES an arbitrary status','raises','accepted — arbitrary status allowed',false);
  exception when others then
    insert into v22 values (30,'close REFUSES an arbitrary status','raises', sqlerrm,
      sqlerrm ilike '%must be finalized or discarded%');
  end;

  begin
    perform public.library_close_import_run(a, pr, 'finalized');
    insert into v22 values (31,'close REFUSES a packet run','raises','accepted',false);
  exception when others then
    insert into v22 values (31,'close REFUSES a packet run','raises', sqlerrm,
      sqlerrm ilike '%not a library import%');
  end;

  begin
    perform public.library_close_import_run(c, run, 'finalized');
    insert into v22 values (32,'close REFUSES a non-owner','raises','accepted — ownership hole',false);
  exception when others then
    insert into v22 values (32,'close REFUSES a non-owner','raises', sqlerrm,
      sqlerrm ilike '%does not own%');
  end;

  res := public.library_close_import_run(a, run, 'finalized');
  select status, source_text into st, src from public.ingestion_runs where id = run;
  select count(*) into n from public.library_import_proposals where run_id = run;
  insert into v22 values (33,'finish closes the run, drops what remained, clears the text',
    'finalized, 3 dropped, 0 proposals, source_text null',
    st || ', dropped=' || (res->>'droppedProposals') || ', ' || n || ' proposals, source=' || coalesce(src,'null'),
    st = 'finalized' and (res->>'droppedProposals')::int = 3 and n = 0 and src is null);

  res := public.library_close_import_run(a, run, 'finalized');
  insert into v22 values (34,'closing again is idempotent, not an error','reused=true',
    'reused=' || (res->>'reused'), (res->>'reused')::boolean);

  begin
    perform public.library_close_import_run(a, run, 'discarded');
    insert into v22 values (35,'a terminal run cannot be moved to the other status','raises','accepted',false);
  exception when others then
    insert into v22 values (35,'a terminal run cannot be moved to the other status','raises', sqlerrm,
      sqlerrm ilike '%already%');
  end;
end
$close$;

-- ---- abandon, on its own run ----------------------------------------------
do $abandon$
declare c uuid; res jsonb; run uuid; st text;
begin
  select v into c from fx where k='c';
  res := public.create_library_import_run(c, 'other', 'hash-c', 5, 'seg-v4',
    jsonb_build_array(jsonb_build_object('ordinal',0,'source_start',0,'source_end',5,'segment_text','other','segment_hash','h','section_hint','','is_continuation',false)));
  run := (res->>'run_id')::uuid;
  res := public.library_close_import_run(c, run, 'discarded');
  select status into st from public.ingestion_runs where id = run;
  insert into v22 values (36,'abandon reaches the discarded status','discarded', st, st = 'discarded');
end
$abandon$;

-- ===========================================================================
select n, check_name, expected, actual, ok from v22 order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as result,
       (count(*) filter (where not ok)) = 0 as all_green from v22;

-- NOTHING ABOVE IS KEPT.
rollback;
