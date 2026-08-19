-- 0023 STEP 2 — PREFLIGHT. STRICTLY READ ONLY.
--
-- (Step 1 is offline: node scripts/migrations/verify-0023-integrity.mjs — 31/31)
--
-- Nothing here creates, alters, drops or writes anything.
-- EVERY ROW MUST BE ok = true. If any is false, DO NOT APPLY 0023.
--
-- Rows 4 to 7 are new since the equivalence review. 0023 no longer restates
-- status, composition_mode or packet_type — it relies on the same column
-- defaults the ordinary blank create relies on, and then asserts the result.
-- Those assertions are only meaningful if the defaults are what we measured, so
-- they are checked HERE, before applying, rather than discovered at runtime.

select 1 as n,
       'update_item_content signature — 0023 calls it POSITIONALLY' as check_name,
       '12 args, p_item_id .. p_contacts jsonb -> void' as expected,
       coalesce((select pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_catalog.format_type(p.prorettype, null)
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'update_item_content'), 'MISSING — STOP') as actual,
       coalesce((select pg_get_function_identity_arguments(p.oid) =
                   'p_item_id uuid, p_owner_id uuid, p_packet_id uuid, p_require_mode text, p_title text, p_description text, p_notes text, p_address text, p_details jsonb, p_links jsonb, p_photos jsonb, p_contacts jsonb'
                   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'update_item_content'), false) as ok
union all
select 2, 'exactly one update_item_content overload', '1',
       (select count(*)::text from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = 'update_item_content'),
       (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = 'update_item_content') = 1
union all
select 3, 'the three 0023 functions are all absent', 'none present',
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none')
          from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname in
           ('library_canonical_photos','library_copy_into_section','create_packet_from_library')),
       not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname = 'public' and p.proname in
                      ('library_canonical_photos','library_copy_into_section','create_packet_from_library'))
union all
-- ---------------------------------------------------------------------------
-- The defaults 0023 now RELIES ON, exactly as the blank create does.
-- ---------------------------------------------------------------------------
select 4, 'packets.status defaults to draft', 'draft',
       coalesce((select column_default from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='status'), '(none)'),
       coalesce((select column_default like '%draft%' from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='status'), false)
union all
select 5, 'packets.composition_mode defaults to legacy', 'legacy',
       coalesce((select column_default from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='composition_mode'), '(none)'),
       coalesce((select column_default like '%legacy%' from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='composition_mode'), false)
union all
select 6, 'packets.packet_type has a default', 'general',
       coalesce((select column_default from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='packet_type'), '(none)'),
       coalesce((select column_default is not null from information_schema.columns
                  where table_schema='public' and table_name='packets' and column_name='packet_type'), false)
union all
-- 0023 inserts a section with only (packet_id, title, sort_order); description
-- must default, or its section would differ from an editor-added one.
select 7, 'sections.description defaults rather than requiring a value', 'default present, nullable or defaulted',
       coalesce((select coalesce(column_default,'(none)') || ' / nullable=' || is_nullable
                   from information_schema.columns
                  where table_schema='public' and table_name='sections' and column_name='description'), 'MISSING'),
       coalesce((select column_default is not null or is_nullable = 'YES'
                   from information_schema.columns
                  where table_schema='public' and table_name='sections' and column_name='description'), false)
union all
-- 0023's slug-collision handling depends on a unique violation actually being
-- raised. Without the constraint it would silently create a duplicate slug.
select 8, 'packets.slug is uniquely constrained', 'a unique index on (slug)',
       coalesce((select string_agg(indexname, ', ') from pg_indexes
                  where schemaname='public' and tablename='packets'
                    and indexdef ilike '%unique%' and indexdef ilike '%(slug)%'), 'MISSING — STOP'),
       exists (select 1 from pg_indexes where schemaname='public' and tablename='packets'
                and indexdef ilike '%unique%' and indexdef ilike '%(slug)%')
union all
-- ---------------------------------------------------------------------------
-- Structures 0023 writes into.
-- ---------------------------------------------------------------------------
select 9, 'library_items exists and carries a revision', 'present',
       coalesce((select 'present' from information_schema.columns
                  where table_schema='public' and table_name='library_items' and column_name='revision'), 'MISSING — STOP'),
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='library_items' and column_name='revision')
union all
select 10, 'items carries both lineage columns (0017)', 'both present',
       (select coalesce(string_agg(column_name, ', ' order by column_name), 'MISSING — STOP')
          from information_schema.columns
         where table_schema='public' and table_name='items'
           and column_name in ('library_item_id','library_item_revision')),
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='items'
           and column_name in ('library_item_id','library_item_revision')) = 2
union all
-- 0023 always creates a LEGACY FlowGuide precisely because these exist. Their
-- presence is what makes that choice load-bearing rather than incidental.
select 11, 'the block-mode freeze triggers still exist', 'both present',
       (select coalesce(string_agg(tgname, ', ' order by tgname), 'MISSING')
          from pg_trigger where tgname in ('trg_freeze_items','trg_freeze_sections') and not tgisinternal),
       (select count(*) from pg_trigger
         where tgname in ('trg_freeze_items','trg_freeze_sections') and not tgisinternal) = 2
union all
-- ---------------------------------------------------------------------------
-- Safe moment.
-- ---------------------------------------------------------------------------
select 12, 'no ingestion run is in flight', '0',
       (select count(*)::text from public.ingestion_runs
         where status in ('active','finalizing','needs_review')),
       (select count(*) from public.ingestion_runs
         where status in ('active','finalizing','needs_review')) = 0
union all
select 13, 'earlier verification steps left nothing behind', '0 stray users',
       (select count(*)::text from public.users where email like '00%-verify%'),
       (select count(*) from public.users where email like '00%-verify%') = 0
order by n;
