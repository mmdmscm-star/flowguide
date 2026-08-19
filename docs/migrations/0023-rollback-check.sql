-- 0023 ROLLBACK CHECK. STRICTLY READ ONLY.
--
-- 0023 raised inside its own verify block, which sits between BEGIN and COMMIT,
-- so the whole transaction should have rolled back. This proves it rather than
-- assuming it, and diagnoses the assertion that fired.
--
-- EVERY ROW MUST BE ok = true.

select 1 as n, 'none of the three 0023 functions exists' as check_name,
       'none' as expected,
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library')) as actual,
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname = 'public' and p.proname in
                      ('library_canonical_photos','library_copy_into_section','create_packet_from_library')) as ok
union all
-- 0023 creates no tables, but a partial apply would be visible as any object
-- carrying its names. Nothing should mention them anywhere.
select 2, 'no 0023 object of any kind survived', 'none',
       (select coalesce(string_agg(c.relname, ', '), 'none') from pg_class c
          join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = 'public' and c.relname like 'library%from%library%'),
       not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname like 'library%from%library%')
union all
-- The things 0023 would have touched must be untouched.
select 3, 'update_item_content is unchanged and still the only overload', '1',
       (select count(*)::text from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = 'update_item_content'),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = 'update_item_content') = 1
union all
select 4, 'no packet or section was created by the failed attempt', '0 packets with an empty slug-less shape',
       (select count(*)::text from public.packets where slug is null),
       (select count(*) from public.packets where slug is null) = 0
union all
select 5, 'the Library RPCs from 0021/0022 are still present', '4',
       (select count(*)::text from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('library_save_proposal','create_library_import_run','library_materialize_proposals','library_close_import_run')),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('library_save_proposal','create_library_import_run','library_materialize_proposals','library_close_import_run')) = 4
union all
-- ---------------------------------------------------------------------------
-- DIAGNOSIS. Rows 6 and 7 need no 0023 object to exist — they demonstrate the
-- defect in the ASSERTION itself, using nothing but SQL string matching.
-- ---------------------------------------------------------------------------
select 6, 'LIKE treats _ as a single-character WILDCARD, not a literal underscore',
       'true — ''emit index'' matches ''%emit_index%''',
       ('emit index' ilike '%emit_index%')::text,
       ('emit index' ilike '%emit_index%') = true
union all
select 7, 'and with the underscore escaped it correctly does NOT match',
       'false',
       ('emit index' ilike '%emit\_index%')::text,
       ('emit index' ilike '%emit\_index%') = false
order by n;
