-- 0023 STEP 4 CLEANUP CHECK. STRICTLY READ ONLY.
--
-- The Step 4 verification aborted on a type error while building the structural
-- signature. It runs inside BEGIN ... ROLLBACK, and an aborted transaction is
-- rolled back regardless, so nothing it created should survive. This proves that
-- rather than assuming it.
--
-- The failure happened in the equivalence block, which runs BEFORE the
-- fault-injection gate — so the temporary trigger and its function were never
-- created at all. Rows 3 and 4 confirm that independently.
--
-- EVERY ROW MUST BE ok = true.

select 1 as n, 'no Step 4 disposable users survived' as check_name, '0' as expected,
       (select count(*)::text from public.users where email like '0023-verify%') as actual,
       (select count(*) from public.users where email like '0023-verify%') = 0 as ok
union all
select 2, 'no Step 4 packets survived', '0',
       (select count(*)::text from public.packets
         where slug like '0023-verify%' or title = 'Should not survive'),
       (select count(*) from public.packets
         where slug like '0023-verify%' or title = 'Should not survive') = 0
union all
select 3, 'the fault-injection function was never created', 'absent',
       coalesce((select 'PRESENT' from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname='public' and p.proname='tmp_0023_fault' limit 1), 'absent'),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname='public' and p.proname='tmp_0023_fault')
union all
select 4, 'the fault-injection trigger was never created', 'absent',
       coalesce((select 'PRESENT' from pg_trigger where tgname='tmp_0023_fault_trg' limit 1), 'absent'),
       not exists (select 1 from pg_trigger where tgname='tmp_0023_fault_trg')
union all
select 5, 'no orphan section or item from the aborted run', '0 / 0',
       (select count(*)::text from public.sections s
          join public.packets pk on pk.id = s.packet_id where pk.slug like '0023-verify%') || ' / ' ||
       (select count(*)::text from public.library_items li
          join public.users u on u.id = li.user_id where u.email like '0023-verify%'),
       (select count(*) from public.sections s
          join public.packets pk on pk.id = s.packet_id where pk.slug like '0023-verify%') = 0
       and (select count(*) from public.library_items li
              join public.users u on u.id = li.user_id where u.email like '0023-verify%') = 0
union all
-- 0023 itself is untouched by a failed VERIFICATION — the verifier only reads.
select 6, '0023 is still applied and intact', 'all three functions present',
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'MISSING')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library')),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname='public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library')) = 3
union all
-- ---------------------------------------------------------------------------
-- DIAGNOSIS, needing nothing that the failed run created.
-- ---------------------------------------------------------------------------
select 7, 'packets.custom_identity is a json type, so a text sentinel cannot coalesce with it',
       'json or jsonb',
       coalesce((select data_type from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='custom_identity'), 'MISSING'),
       coalesce((select data_type in ('json','jsonb') from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='custom_identity'), false)
union all
select 8, 'every other packets column, with its type — read this before trusting any signature',
       'reference row, always true',
       (select string_agg(column_name || ':' || data_type, ', ' order by ordinal_position)
          from information_schema.columns
         where table_schema='public' and table_name='packets'),
       true
order by n;
