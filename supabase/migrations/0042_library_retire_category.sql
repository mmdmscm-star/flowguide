-- ============================================================================
-- 0042 — CONTRACT. The legacy `category` goes, and Section becomes the only
-- answer to where something lives.
--
-- 0038 gave the Library one optional grouping as a text column. 0039 built real
-- Section and Group tables beside it, 0040 converted the text into them, and
-- 0041 caught up anything the outgoing runtime changed on its way out. Since
-- then `category` has been a SHADOW: written by placement, read by nobody,
-- carried only so a rollback to the pre-structure runtime would still show
-- where things lived.
--
-- That period is over. Library ORGANIZATION is re-creatable — a professional
-- can re-file things — so the shadow is no longer worth its cost, and the cost
-- is not zero: a second description of one fact is a second thing that can be
-- wrong, and the machinery guarding it (a dual-write, a mismatch guard, a
-- withheld rename) is machinery in the way of the product.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT TOUCH, AND CANNOT.
--
-- Library CONTENT is not re-creatable and is not in scope for any of this.
-- Nothing here deletes an item, and nothing here writes title, address,
-- description, notes, details, links, photos or contacts — the statements below
-- name one column and two schema objects, all three of them introduced by 0038
-- for `category` alone. Snapshot and copy semantics are untouched:
-- library_copy_into_section enumerates the fields it takes and `category` was
-- never among them, so no FlowGuide has ever carried it and none changes now.
--
-- THE ORGANIZATION SURVIVES TOO. Dropping a column does not disturb its
-- neighbours: library_sections, library_groups, section_id, group_id and
-- sort_order are all untouched, so every section, group, placement and manual
-- position is exactly where it was. Nothing is reset. That is asserted below
-- rather than assumed, because "it should be fine" is not a verification.
--
-- ---------------------------------------------------------------------------
-- `alter table ... drop column` is metadata-only in postgres: the attribute is
-- marked dropped, no table is rewritten, no row is visited and no trigger can
-- fire. library_items carries exactly one trigger and it is BEFORE DELETE, so
-- revision and updated_at cannot move — which is checked anyway.
--
-- search_tsv is a GENERATED column over title, address, description, notes,
-- details, contacts and links. It has never referenced `category`, so the
-- Library's full-text search is unaffected and no reindex is implied.
--
-- The index and the CHECK would be dropped automatically as dependents of the
-- column. They are dropped explicitly first so this migration says out loud
-- everything it removes.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

create temp table zz_0042_before on commit drop as
  select id, revision, updated_at, section_id, group_id, sort_order,
         labels, is_favorite,
         title, address, description, notes, details, links, photos, contacts
    from public.library_items;

create temp table zz_0042_structure on commit drop as
  select 'section'::text as kind, id, name, sort_order::bigint from public.library_sections
  union all
  select 'group'::text, id, name, sort_order::bigint from public.library_groups;

-- ---------------------------------------------------------------------------
-- PRECONDITION. Contract only after the model it replaces is genuinely dead:
-- every item's shadow must still agree with its section, which is what 0041
-- guaranteed. If anything disagrees, something wrote a category after the
-- cutover and dropping the column would discard a real intent.
-- ---------------------------------------------------------------------------
do $pre$
declare v_split bigint;
begin
  select count(*) into v_split from public.library_items li
    left join public.library_sections s on s.id = li.section_id
   where lower(coalesce(s.name, '')) is distinct from lower(btrim(li.category));
  if v_split <> 0 then
    raise exception '0042: % item(s) still describe two different homes — reconcile before contracting', v_split;
  end if;
end;
$pre$;

-- ---------------------------------------------------------------------------
-- The three objects 0038 created for `category`, and nothing else.
-- ---------------------------------------------------------------------------
drop index if exists public.library_items_category_page_idx;

alter table public.library_items
  drop constraint if exists library_items_category_trimmed;

alter table public.library_items
  drop column if exists category;

do $v$
declare v_moved bigint; v_lost bigint; v_struct bigint;
begin
  -- 1. Every item is otherwise byte-for-byte what it was: content, stamps,
  --    labels, favorite, AND its place in the structure.
  select count(*) into v_moved
    from public.library_items li join zz_0042_before b on b.id = li.id
   where li.revision    is distinct from b.revision
      or li.updated_at  is distinct from b.updated_at
      or li.section_id  is distinct from b.section_id
      or li.group_id    is distinct from b.group_id
      or li.sort_order  is distinct from b.sort_order
      or li.labels      is distinct from b.labels
      or li.is_favorite is distinct from b.is_favorite
      or li.title       is distinct from b.title
      or li.address     is distinct from b.address
      or li.description is distinct from b.description
      or li.notes       is distinct from b.notes
      or li.details     is distinct from b.details
      or li.links       is distinct from b.links
      or li.photos      is distinct from b.photos
      or li.contacts    is distinct from b.contacts;
  if v_moved <> 0 then
    raise exception '0042: % item(s) changed during a column drop', v_moved;
  end if;

  -- 2. NO ITEM WAS DELETED. Library content is not re-creatable; this is the
  --    line the whole migration is written around.
  select count(*) into v_lost from (
    (select id from zz_0042_before except select id from public.library_items)
    union all
    (select id from public.library_items except select id from zz_0042_before)
  ) d;
  if v_lost <> 0 then
    raise exception '0042: the library item set changed (% row(s)) — content must never be lost', v_lost;
  end if;

  -- 3. Every section and group survived, with its name and its rank.
  --   EXCEPT and UNION ALL share precedence and associate left, so an inline
  --   `A except B union all C` would mean `(A except B) union all C` and count
  --   rows that never differed. The current structure is named once in a CTE so
  --   each side of the symmetric difference is unambiguous.
  with cur as (
    select 'section'::text as kind, id, name, sort_order::bigint from public.library_sections
    union all
    select 'group'::text, id, name, sort_order::bigint from public.library_groups
  )
  select count(*) into v_struct from (
    (select kind, id, name, sort_order from zz_0042_structure
      except
     select kind, id, name, sort_order from cur)
    union all
    (select kind, id, name, sort_order from cur
      except
     select kind, id, name, sort_order from zz_0042_structure)
  ) d;
  if v_struct <> 0 then
    raise exception '0042: the section/group structure changed (% row(s)) during a column drop', v_struct;
  end if;

  -- 4. The column and everything that existed only for it are gone.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'library_items'
                and column_name = 'category') then
    raise exception '0042: library_items.category survived the contract migration';
  end if;
  if exists (select 1 from pg_constraint
              where conrelid = 'public.library_items'::regclass
                and conname = 'library_items_category_trimmed') then
    raise exception '0042: the category CHECK survived';
  end if;
  if to_regclass('public.library_items_category_page_idx') is not null then
    raise exception '0042: the category index survived';
  end if;

  -- 5. ...and everything that does NOT exist only for it is still here. A
  --    contract migration that took a neighbour with it would be far worse
  --    than one that left the column behind.
  if to_regclass('public.library_items_page_idx') is null
     or to_regclass('public.library_items_container_idx') is null
     or to_regclass('public.library_items_unorganized_idx') is null
     or to_regclass('public.library_items_favorite_page_idx') is null
     or to_regclass('public.library_items_labels_idx') is null
     or to_regclass('public.library_items_search_idx') is null then
    raise exception '0042: an index unrelated to category was dropped';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'library_items'
                    and column_name = 'search_tsv') then
    raise exception '0042: full-text search was lost';
  end if;
  for v_struct in
    select 1 from unnest(array['library_items_section_fk','library_items_group_fk',
                               'library_items_group_needs_section']) c
     where not exists (select 1 from pg_constraint
                        where conrelid = 'public.library_items'::regclass and conname = c)
  loop
    raise exception '0042: a structural constraint was dropped with the category column';
  end loop;

  -- 6. library_items still carries exactly one trigger, and it is BEFORE DELETE.
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.library_items'::regclass and not t.tgisinternal) <> 1 then
    raise exception '0042: library_items no longer carries exactly one trigger';
  end if;
end;
$v$;

commit;
