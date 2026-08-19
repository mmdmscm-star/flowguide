-- 0023 STEP 4 — NARROW DIAGNOSTIC for the single failing row.
--
-- PART 1 is pure SQL reads: no transaction, no fixtures, no writes at all. It
-- re-runs every assertion that needs nothing created — signatures, privileges,
-- search_path, all fourteen body hashes, and the coercion. If the failure is
-- here, it is identified with nothing written anywhere.
--
-- PART 2 runs only if Part 1 is entirely green, and only for the assertions that
-- genuinely need data. It is one transaction ending in ROLLBACK and prints a
-- KEY-LEVEL diff rather than a pass/fail, so the failing field names itself.
--
-- CLEANUP: none is needed. The Step 4 verifier COMPLETED — it printed its
-- summary — so it reached its final `rollback`, and it drops the fault trigger
-- and function explicitly before that. Rows 1 and 2 below confirm both rather
-- than relying on that reasoning.

-- ===========================================================================
-- PART 1 — READ ONLY. Nothing is created; there is no transaction to roll back.
-- ===========================================================================
select 1 as n, 'no Step 4 fixtures survived' as check_name,
       '0 users, 0 packets' as expected,
       (select count(*)::text from public.users where email like '0023-verify%') || ' users, ' ||
       (select count(*)::text from public.packets where slug like '0023-verify%' or title = 'Should not survive') || ' packets' as actual,
       (select count(*) from public.users where email like '0023-verify%') = 0
       and (select count(*) from public.packets where slug like '0023-verify%' or title = 'Should not survive') = 0 as ok
union all
select 2, 'the fault-injection trigger and function are gone', 'both absent',
       coalesce((select 'fn PRESENT' from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='tmp_0023_fault' limit 1), 'fn absent') || ', ' ||
       coalesce((select 'trg PRESENT' from pg_trigger where tgname='tmp_0023_fault_trg' limit 1), 'trg absent'),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname='public' and p.proname='tmp_0023_fault')
       and not exists (select 1 from pg_trigger where tgname='tmp_0023_fault_trg')
union all
-- ---- signatures ------------------------------------------------------------
select 3, 'library_canonical_photos signature', 'p_photos jsonb -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_canonical_photos'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_photos jsonb'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_canonical_photos'), false)
union all
select 4, 'library_copy_into_section signature',
       'p_owner uuid, p_packet_id uuid, p_section_id uuid, p_library_item_ids uuid[] -> uuid[]',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_copy_into_section'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_packet_id uuid, p_section_id uuid, p_library_item_ids uuid[]'
                    and pg_catalog.format_type(p.prorettype, null) = 'uuid[]'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='library_copy_into_section'), false)
union all
select 5, 'create_packet_from_library signature',
       'p_owner uuid, p_slug text, p_title text, p_client_name text, p_library_item_ids uuid[] -> jsonb',
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_packet_from_library'), 'MISSING'),
       coalesce((select pg_get_function_identity_arguments(p.oid) = 'p_owner uuid, p_slug text, p_title text, p_client_name text, p_library_item_ids uuid[]'
                    and pg_catalog.format_type(p.prorettype, null) = 'jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='create_packet_from_library'), false)
union all
-- ---- privileges and search_path --------------------------------------------
select 6, 'service_role only + search_path pinned EMPTY, all three', 'all three clean',
       (select coalesce(string_agg(p.proname || '[' ||
                 coalesce(array_to_string(p.proconfig, ','), 'no-config') || ']', ', ' order by p.proname), 'MISSING')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library')),
       (select bool_and(
                 coalesce(array_to_string(p.proconfig, ','), '') in ('search_path=', 'search_path=""')
                 and p.proacl is not null
                 and array_to_string(p.proacl, ' ') !~ '(^| )=X'
                 and array_to_string(p.proacl, ' ') not like '%anon=X%'
                 and array_to_string(p.proacl, ' ') not like '%authenticated=X%'
                 and array_to_string(p.proacl, ' ') ~ 'service_role=X')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library'))
union all
-- ---- the coercion ----------------------------------------------------------
select 7, 'library_canonical_photos coerces, preserves and drops correctly',
       'coerced / preserved / [] / []',
       public.library_canonical_photos('["https://a/1.jpg"]'::jsonb)::text || ' / ' ||
       public.library_canonical_photos('[{"url":"https://a/1.jpg"}]'::jsonb)::text || ' / ' ||
       public.library_canonical_photos('[{},null,"",7]'::jsonb)::text || ' / ' ||
       public.library_canonical_photos(null)::text,
       public.library_canonical_photos('["https://a/1.jpg"]'::jsonb) = '[{"url": "https://a/1.jpg"}]'::jsonb
       and public.library_canonical_photos('[{"url":"https://a/1.jpg"}]'::jsonb) = '[{"url": "https://a/1.jpg"}]'::jsonb
       and public.library_canonical_photos('[{},null,"",7]'::jsonb) = '[]'::jsonb
       and public.library_canonical_photos(null) = '[]'::jsonb
order by n;

-- ---- all fourteen body hashes, individually --------------------------------
-- Any row with ok = false here is a function that moved.
with expected(proname, md5) as (values
  ('update_item_content','7a3312aa742a74bae46742fc54be4418'),
  ('claim_chunk','f5eba9a090a6af893bbbdfc41412c263'),
  ('stage_chunk_result','1b03552adc6d9dc8afd522f9e9231c67'),
  ('mark_chunk_failed','a8fb32eef936a61405220661c221a48c'),
  ('split_chunk','db8e798dcbed4fb9c4e30c2b00317bcb'),
  ('finalize_ingestion_run','e9a7f5635d86ad8d16430144b75c3864'),
  ('discard_ingestion_run','ba0545d9bea5926905adbdb436df3247'),
  ('library_save_proposal','75c84eaa4bd23ca0dbd96b2bbe1d5074'),
  ('create_library_import_run','125d2df8015f704377399ab665ea9e2f'),
  ('library_materialize_proposals','df006c498ea0b94480454fb4ea331727'),
  ('library_close_import_run','e8d5eeb970fdd4596b98e85858923abf'),
  ('library_canonical_photos','982e77eb31abd2ad31924a029343f7ed'),
  ('library_copy_into_section','fe7dab27c2cae14903f635f23191e455'),
  ('create_packet_from_library','4886536ace5366c6dcca84322ecba168'))
select e.proname, e.md5 as expected_md5,
       coalesce(md5(p.prosrc), 'FUNCTION MISSING') as actual_md5,
       coalesce(md5(p.prosrc) = e.md5, false) as ok
  from expected e
  left join (pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname='public')
    on p.proname = e.proname
 order by ok, e.proname;

-- ===========================================================================
-- PART 2 — the assertions that need data. One transaction, ending in ROLLBACK.
--
-- This does NOT re-assert pass/fail. It prints the two structural signatures
-- KEY BY KEY and shows only the keys that differ, so the failing field names
-- itself instead of being guessed at.
-- ===========================================================================
begin;

create temp table diag (label text, detail text) on commit drop;

do $d$
declare a uuid; blank uuid; made uuid; res jsonb; lid uuid; ids uuid[] := '{}'; i int;
        sb jsonb; sm jsonb;
begin
  insert into public.users(email) values ('0023-diag@disposable.invalid') returning id into a;
  for i in 1..4 loop
    insert into public.library_items (user_id, title, photos)
    values (a, 'Community ' || i,
            case when i = 1 then '["https://example.com/legacy-shape.jpg"]'::jsonb
                 else jsonb_build_array(jsonb_build_object('url','https://example.com/p' || i || '.jpg')) end)
    returning id into lid;
    ids := ids || lid;
  end loop;

  res := public.create_packet_from_library(a, '0023-diag-made', 'Reyes family', 'The Reyes family', ids);
  made := (res->>'packet_id')::uuid;

  insert into public.packets (user_id, slug, title, client_name, packet_type)
  values (a, '0023-diag-blank', 'Reyes family', 'The Reyes family', 'general')
  returning id into blank;

  select to_jsonb(pk) - 'id' - 'slug' - 'created_at' - 'updated_at' - 'title' - 'client_name'
    into sb from public.packets pk where pk.id = blank;
  select to_jsonb(pk) - 'id' - 'slug' - 'created_at' - 'updated_at' - 'title' - 'client_name'
    into sm from public.packets pk where pk.id = made;

  insert into diag values ('signatures equal?', (sb = sm)::text);
  insert into diag values ('keys compared', (select count(*)::text from jsonb_object_keys(sm)));

  -- THE ANSWER: every key whose value differs between the two packets.
  insert into diag
  select 'DIFFERS: ' || k,
         'blank=' || coalesce((sb->k)::text,'<absent>') || '   from-library=' || coalesce((sm->k)::text,'<absent>')
    from (select jsonb_object_keys(sb || sm) as k) t
   where (sb->k) is distinct from (sm->k);

  -- Context that makes the difference interpretable.
  insert into diag select 'context: sections in the from-library packet',
    (select count(*)::text from public.sections where packet_id = made);
  insert into diag select 'context: items in the from-library packet',
    (select count(*)::text from public.items it join public.sections s on s.id = it.section_id where s.packet_id = made);
  insert into diag select 'context: sections in the blank packet',
    (select count(*)::text from public.sections where packet_id = blank);
end
$d$;

select label, detail from diag order by label;

rollback;
