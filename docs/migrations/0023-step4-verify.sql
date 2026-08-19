-- 0023 STEP 4 — POST-APPLY VERIFICATION.
--
-- WRITES NOTHING. One transaction ending in ROLLBACK. It creates disposable
-- users, Library entries, FlowGuides and — briefly — a fault-injection trigger,
-- because atomicity can only be proven by making a failure happen. None of it
-- commits.
--
-- Read the last column. EVERY row must be ok = true. READ ROW 0 FIRST: if
-- fixtures from an earlier step survive, this session does not roll back and
-- nothing below can be trusted.
--
-- Expected body hashes are generated mechanically from the applied migration
-- files, never typed.

begin;

create temp table v23 (n int, check_name text, expected text, actual text, ok boolean) on commit drop;
create temp table expected_body (proname text primary key, md5 text) on commit drop;
insert into expected_body values
  ('update_item_content', '7a3312aa742a74bae46742fc54be4418'),
  ('claim_chunk', 'f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result', '1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed', 'a8fb32eef936a61405220661c221a48c'),
  ('split_chunk', 'db8e798dcbed4fb9c4e30c2b00317bcb'),
  ('finalize_ingestion_run', 'e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run', 'ba0545d9bea5926905adbdb436df3247'),
  ('library_save_proposal', '75c84eaa4bd23ca0dbd96b2bbe1d5074'),
  ('create_library_import_run', '125d2df8015f704377399ab665ea9e2f'),
  ('library_materialize_proposals', 'df006c498ea0b94480454fb4ea331727'),
  ('library_close_import_run', 'e8d5eeb970fdd4596b98e85858923abf'),
  ('library_canonical_photos', '982e77eb31abd2ad31924a029343f7ed'),
  ('library_copy_into_section', 'fe7dab27c2cae14903f635f23191e455'),
  ('create_packet_from_library', '4886536ace5366c6dcca84322ecba168');
create temp table fx (k text primary key, v uuid) on commit drop;

insert into v23
select 0, 'earlier verification steps rolled back cleanly', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0;

-- ===========================================================================
-- A. SIGNATURES, PRIVILEGES, search_path
-- ===========================================================================
insert into v23
select 1, 'library_canonical_photos signature', 'p_photos jsonb -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_canonical_photos'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_photos jsonb'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_canonical_photos'), false);

insert into v23
select 2, 'library_copy_into_section signature',
       'p_owner uuid, p_packet_id uuid, p_section_id uuid, p_library_item_ids uuid[] -> uuid[]',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_copy_into_section'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_packet_id uuid, p_section_id uuid, p_library_item_ids uuid[]'
                    and pg_catalog.format_type(p.prorettype, null) = 'uuid[]'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_copy_into_section'), false);

insert into v23
select 3, 'create_packet_from_library signature',
       'p_owner uuid, p_slug text, p_title text, p_client_name text, p_library_item_ids uuid[] -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_packet_from_library'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_slug text, p_title text, p_client_name text, p_library_item_ids uuid[]'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_packet_from_library'), false);

insert into v23
select 4, 'no accidental overloads', '1 each',
       (select coalesce(string_agg(proname || '=' || c, ', ' order by proname), 'none') from (
          select p.proname, count(*) c from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname='public' and p.proname in
             ('library_canonical_photos','library_copy_into_section','create_packet_from_library')
           group by p.proname) t),
       (select count(*) = 3 and bool_and(c = 1) from (
          select p.proname, count(*) c from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname='public' and p.proname in
             ('library_canonical_photos','library_copy_into_section','create_packet_from_library')
           group by p.proname) t);

-- PUBLIC is a pseudo-role and cannot be passed to has_function_privilege, so the
-- ACL is read directly. A NULL proacl means DEFAULT privileges, which for a
-- function INCLUDE execute by PUBLIC. And search_path must be pinned EMPTY:
-- 'search_path=public' is not a pinned path, it is the resolution behaviour
-- these functions exist to avoid.
insert into v23
select 4 + row_number() over (order by p.proname),
       'service_role only + search_path pinned EMPTY: ' || p.proname,
       'service_role=X only, search_path empty',
       coalesce(array_to_string(p.proacl, ' '), 'DEFAULT — PUBLIC CAN EXECUTE')
         || ' | ' || coalesce(array_to_string(p.proconfig, ','), '(none)'),
       coalesce(array_to_string(p.proconfig, ','), '') in ('search_path=', 'search_path=""')
         and p.proacl is not null
         and array_to_string(p.proacl, ' ') !~ '(^| )=X'
         and array_to_string(p.proacl, ' ') not like '%anon=X%'
         and array_to_string(p.proacl, ' ') not like '%authenticated=X%'
         -- Regex, not LIKE: _ is a wildcard there, so '%service_role=X%' would
         -- also accept "service role=X". Same hazard that failed the first apply.
         and array_to_string(p.proacl, ' ') ~ 'service_role=X'
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname='public' and p.proname in
   ('library_canonical_photos','library_copy_into_section','create_packet_from_library');

-- ===========================================================================
-- B. EXISTING LIBRARY AND INGESTION MACHINERY IS UNCHANGED
-- ===========================================================================
insert into v23
select 9 + row_number() over (order by e.proname),
       'body md5 == source: ' || e.proname, e.md5,
       coalesce(md5(p.prosrc), 'FUNCTION MISSING'),
       coalesce(md5(p.prosrc) = e.md5, false)
  from expected_body e
  left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname='public')
    on p.proname = e.proname;

-- ===========================================================================
-- C. THE COERCION
-- ===========================================================================
insert into v23
select 30, 'bare strings become canonical, canonical is preserved, junk is dropped',
       'coerced / preserved / []',
       public.library_canonical_photos('["https://a/1.jpg"]'::jsonb)::text || ' / ' ||
       public.library_canonical_photos('[{"url":"https://a/1.jpg"}]'::jsonb)::text || ' / ' ||
       public.library_canonical_photos('[{},null,"",7]'::jsonb)::text,
       public.library_canonical_photos('["https://a/1.jpg"]'::jsonb) = '[{"url": "https://a/1.jpg"}]'::jsonb
       and public.library_canonical_photos('[{"url":"https://a/1.jpg"}]'::jsonb) = '[{"url": "https://a/1.jpg"}]'::jsonb
       and public.library_canonical_photos('[{},null,"",7]'::jsonb) = '[]'::jsonb
       and public.library_canonical_photos(null) = '[]'::jsonb;

-- ===========================================================================
-- D. BEHAVIOUR
-- ===========================================================================
do $fx$
declare a uuid; b uuid; ids uuid[] := '{}'; lid uuid; i int;
begin
  insert into public.users(email) values ('0023-verify-a@disposable.invalid') returning id into a;
  insert into public.users(email) values ('0023-verify-b@disposable.invalid') returning id into b;

  for i in 1..4 loop
    insert into public.library_items (user_id, title, address, description, notes, details, links, photos, contacts)
    values (a,
      case when i = 3 then 'FAULT INJECTION TARGET' else 'Community ' || i end,
      i || '00 Example Rd', 'Assisted living and memory care.', 'Private note',
      jsonb_build_array(jsonb_build_object('label','AL Studio','value','$' || (3+i) || ',500/mo')),
      jsonb_build_array(jsonb_build_object('url','https://example.com/' || i,'label','Website')),
      case when i = 1 then '["https://example.com/legacy-shape.jpg"]'::jsonb
           else jsonb_build_array(jsonb_build_object('url','https://example.com/p' || i || '.jpg')) end,
      jsonb_build_array(jsonb_build_object('name','Pat Rivera','role','Director','phone','707-555-0100','email','pat@example.com','website','')))
    returning id into lid;
    ids := ids || lid;
  end loop;
  insert into fx values ('a',a),('b',b),('l1',ids[1]),('l2',ids[2]),('l3',ids[3]),('l4',ids[4]);

  insert into public.library_items (user_id, title) values (b, 'Not yours') returning id into lid;
  insert into fx values ('foreign', lid);
end
$fx$;

-- ---- D1. four entries -> four independent copies ---------------------------
do $create$
declare a uuid; res jsonb; pid uuid; sid uuid; n int; titles text;
begin
  select v into a from fx where k='a';
  res := public.create_packet_from_library(a, '0023-verify-slug-1', 'Reyes family', 'The Reyes family',
    array[(select v from fx where k='l1'),(select v from fx where k='l2'),
          (select v from fx where k='l3'),(select v from fx where k='l4')]);
  pid := (res->>'packet_id')::uuid; sid := (res->>'section_id')::uuid;
  insert into fx values ('packet', pid),('section', sid);

  select count(*), string_agg(title, ' | ' order by sort_order) into n, titles
    from public.items where section_id = sid;
  insert into v23 values (31, 'four chosen entries produce exactly four items, in the order chosen',
    '4 items, selection order', n || ': ' || coalesce(titles,''),
    n = 4 and titles = 'Community 1 | Community 2 | FAULT INJECTION TARGET | Community 4');

  insert into v23 select 32, 'every copy records lineage, both columns together', 'all four',
    count(*) filter (where library_item_id is not null and library_item_revision is not null)::text || ' of ' || count(*)::text,
    count(*) = 4 and count(*) filter (where library_item_id is not null and library_item_revision is not null) = 4
    from public.items where section_id = sid;

  insert into v23 select 33, 'and none fabricates ingestion provenance', '0 with any origin_* set',
    count(*) filter (where origin_run_id is not null or origin_chunk_ordinal is not null or origin_emit_index is not null)::text,
    count(*) filter (where origin_run_id is not null or origin_chunk_ordinal is not null or origin_emit_index is not null) = 0
    from public.items where section_id = sid;

  insert into v23 select 34, 'the legacy bare-string photo arrived as a real url',
    'https://example.com/legacy-shape.jpg',
    coalesce((select ph.url from public.item_photos ph join public.items it on it.id = ph.item_id
               where it.section_id = sid and it.sort_order = 0), 'MISSING'),
    exists (select 1 from public.item_photos ph join public.items it on it.id = ph.item_id
             where it.section_id = sid and it.sort_order = 0
               and ph.url = 'https://example.com/legacy-shape.jpg');

  insert into v23 select 35, 'details, links and contacts travelled with every copy', '4 / 4 / 4',
    (select count(*)::text from public.item_details d join public.items it on it.id = d.item_id where it.section_id = sid) || ' / ' ||
    (select count(*)::text from public.item_links l join public.items it on it.id = l.item_id where it.section_id = sid) || ' / ' ||
    (select count(*)::text from public.item_contacts c join public.items it on it.id = c.item_id where it.section_id = sid),
    (select count(*) from public.item_details d join public.items it on it.id = d.item_id where it.section_id = sid) = 4
    and (select count(*) from public.item_links l join public.items it on it.id = l.item_id where it.section_id = sid) = 4
    and (select count(*) from public.item_contacts c join public.items it on it.id = c.item_id where it.section_id = sid) = 4;

  insert into v23 select 36, 'nothing published', 'draft', status, status = 'draft'
    from public.packets where id = pid;
end
$create$;

-- ---- D2. structural equivalence with the ordinary blank create -------------
do $equiv$
declare a uuid; blank uuid; made uuid; sig_blank jsonb; sig_made jsonb;
begin
  select v into a from fx where k='a'; select v into made from fx where k='packet';
  -- EXACTLY the columns POST /api/packets sets. Everything else is a column
  -- default, which is the whole point of the comparison.
  insert into public.packets (user_id, slug, title, client_name, packet_type)
  values (a, '0023-verify-blank', 'Reyes family', 'The Reyes family', 'general')
  returning id into blank;

  -- THE WHOLE ROW AS JSONB, MINUS THE KEYS EXPECTED TO DIFFER.
  --
  -- The first version of this built a signature by concatenating a hand-picked
  -- list of columns with a '~' sentinel for nulls. That failed on
  -- custom_identity, which is jsonb: coalesce(custom_identity, '~') asks
  -- Postgres to parse '~' as json. Casting that one column would have fixed the
  -- error and left the CLASS of error in place — every other column's type was
  -- still being assumed, and any column added later would be silently omitted
  -- from the comparison entirely.
  --
  -- to_jsonb(row) needs no casts, cannot mis-resolve a type, and covers every
  -- column there is. Subtracting a key is how a difference gets excluded, so the
  -- exclusions are explicit and few: identity and the content actually passed in.
  select to_jsonb(pk) - 'id' - 'slug' - 'created_at' - 'updated_at' - 'title' - 'client_name'
    into sig_blank from public.packets pk where pk.id = blank;
  select to_jsonb(pk) - 'id' - 'slug' - 'created_at' - 'updated_at' - 'title' - 'client_name'
    into sig_made from public.packets pk where pk.id = made;

  insert into v23 values (37, 'blank-create and Create-from-Library share EVERY structural column',
    sig_blank::text, sig_made::text, sig_blank = sig_made);

  -- And prove the comparison is not vacuous: an empty or tiny signature would
  -- compare equal to another empty one and assert nothing at all.
  insert into v23 values (43, 'companion to row 37 — the comparison covers a real set of columns',
    'at least 10 columns compared',
    (select count(*)::text from jsonb_object_keys(sig_made)) || ' columns: ' ||
    (select string_agg(k, ', ' order by k) from jsonb_object_keys(sig_made) as k),
    (select count(*) from jsonb_object_keys(sig_made)) >= 10);

  insert into v23 select 38, 'and the initial section matches an ordinary one',
    'title="" description="" sort_order=0',
    'title=' || quote_literal(title) || ' description=' || quote_literal(description) || ' sort_order=' || sort_order,
    title = '' and description = '' and sort_order = 0
    from public.sections where id = (select v from fx where k='section');
end
$equiv$;

-- ---- D3. a missing or foreign entry rolls the WHOLE thing back -------------
do $reject$
declare a uuid; before_n int; after_n int;
begin
  select v into a from fx where k='a';
  select count(*) into before_n from public.packets where user_id = a;

  begin
    perform public.create_packet_from_library(a, '0023-verify-missing', '', '',
      array[(select v from fx where k='l1'), gen_random_uuid()]);
    insert into v23 values (39, 'a MISSING entry aborts the whole creation','raises','created anyway',false);
  exception when others then
    select count(*) into after_n from public.packets where user_id = a;
    insert into v23 values (39, 'a MISSING entry aborts the whole creation, leaving no packet',
      'raises, packet count unchanged',
      sqlerrm || ' | ' || before_n || ' -> ' || after_n, after_n = before_n);
  end;

  begin
    perform public.create_packet_from_library(a, '0023-verify-foreign', '', '',
      array[(select v from fx where k='l1'), (select v from fx where k='foreign')]);
    insert into v23 values (40, 'another professional''s entry aborts it too','raises','created anyway',false);
  exception when others then
    select count(*) into after_n from public.packets where user_id = a;
    insert into v23 values (40, 'another professional''s entry aborts it too, leaving no packet',
      'raises, packet count unchanged',
      sqlerrm || ' | ' || before_n || ' -> ' || after_n, after_n = before_n);
  end;
end
$reject$;

-- ---- D4. FAULT INJECTION on the THIRD of four copies -----------------------
--
-- The packet, the section and two items already exist by the time this fires.
-- Compensating cleanup could not have guaranteed their removal; a transaction
-- can. The gate refuses to create the trigger unless rollback is proven to work.
do $gate$
begin
  if exists (select 1 from public.users
              where email like '00%-verify%' and email not like '0023-verify%') then
    raise exception 'ABORT: fixtures from an earlier step survive, so this session does not roll back';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname='tmp_0023_fault') then
    raise exception 'ABORT: tmp_0023_fault already exists — a previous run did not roll back';
  end if;
  execute 'create function public.tmp_0023_fault() returns trigger language plpgsql as $f$ begin if new.title = ''FAULT INJECTION TARGET'' then raise exception ''INJECTED FAULT on the third copy''; end if; return new; end $f$';
  execute 'create trigger tmp_0023_fault_trg before insert on public.items for each row execute function public.tmp_0023_fault()';
end
$gate$;

do $inject$
declare a uuid; p_before int; s_before int; i_before int; p_after int; s_after int; i_after int;
begin
  select v into a from fx where k='a';
  select count(*) into p_before from public.packets where user_id = a;
  select count(*) into s_before from public.sections s join public.packets pk on pk.id = s.packet_id where pk.user_id = a;
  select count(*) into i_before from public.items it join public.sections s on s.id = it.section_id
    join public.packets pk on pk.id = s.packet_id where pk.user_id = a;

  begin
    perform public.create_packet_from_library(a, '0023-verify-fault', 'Should not survive', '',
      array[(select v from fx where k='l1'),(select v from fx where k='l2'),
            (select v from fx where k='l3'),(select v from fx where k='l4')]);
    insert into v23 values (41, 'FAULT INJECTION on the third of four copies', 'raises',
      'completed — the trigger did not fire?', false);
  exception when others then
    select count(*) into p_after from public.packets where user_id = a;
    select count(*) into s_after from public.sections s join public.packets pk on pk.id = s.packet_id where pk.user_id = a;
    select count(*) into i_after from public.items it join public.sections s on s.id = it.section_id
      join public.packets pk on pk.id = s.packet_id where pk.user_id = a;
    insert into v23 values (41,
      'FAULT on the THIRD copy leaves ZERO new packet, section or item',
      'all three counts unchanged',
      p_before || '->' || p_after || ' packets, ' || s_before || '->' || s_after || ' sections, ' ||
      i_before || '->' || i_after || ' items',
      p_after = p_before and s_after = s_before and i_after = i_before);

    insert into v23 values (42, 'and no orphan draft carrying that title exists', '0',
      (select count(*)::text from public.packets where title = 'Should not survive'),
      (select count(*) from public.packets where title = 'Should not survive') = 0);
  end;
end
$inject$;

drop trigger if exists tmp_0023_fault_trg on public.items;
drop function if exists public.tmp_0023_fault();

-- ===========================================================================
select n, check_name, expected, actual, ok from v23 order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as result,
       (count(*) filter (where not ok)) = 0 as all_green from v23;

-- NOTHING ABOVE IS KEPT.
rollback;
