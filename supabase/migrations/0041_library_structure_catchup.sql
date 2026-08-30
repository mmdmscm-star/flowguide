-- ============================================================================
-- 0041 — CATCH-UP. Reconcile anything the previous runtime changed on its way out.
--
-- Applied IMMEDIATELY AFTER the structured runtime is live, and prepared BEFORE
-- the cutover begins rather than in response to drift, so the whole sequence is
-- known and approved in advance.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS AT ALL, GIVEN 0040 ALREADY DID THIS.
--
-- 0040 runs before the new runtime deploys. Between those two moments the OLD
-- runtime is still serving, and it can still write `category` — it has never
-- heard of section_id. So an item can come out of that window with section_id
-- naming the home 0040 gave it and `category` naming a different one, which is
-- the professional's more recent intent expressed through the only field the
-- old code had.
--
-- This migration is that reconciliation, carrying byte-for-byte the logic
-- 0040 ran, because an APPLIED MIGRATION IS IMMUTABLE. Re-running 0040 is not
-- an option and is not what this is; this is a separate, separately-approved,
-- separately-hashed migration that happens to do the same well-tested thing.
--
-- It is expected to change NOTHING. On a clean cutover every statement below
-- matches zero rows, and that is the good outcome — not a reason to skip it,
-- because the only way to know is to run it.
--
-- ---------------------------------------------------------------------------
-- WHAT IT MUST NOT DISTURB.
--
-- By the time this runs the new runtime has been live for a minute, so some
-- items may legitimately have GROUPS and a MANUAL ORDER that no `category` can
-- express. Those items have a shadow that already agrees with their section, so:
--
--   * step 2 skips them (`section_id is distinct from s.id` is false), which is
--     what leaves their group_id alone;
--   * step 5 orders by sort_order FIRST, so a hand-made sequence is re-densified
--     into exactly itself.
--
-- A group is cleared ONLY when a legacy category actually moves the item to a
-- different section — where keeping it would be impossible anyway, since a
-- group belongs to the section it sits under and 0039's composite foreign key
-- would refuse the row.
--
-- ---------------------------------------------------------------------------
-- READ-ONLY WITH RESPECT TO CONTENT. revision, updated_at, category, labels,
-- is_favorite and every content column are asserted unchanged below. This
-- migration reads the shadow and never edits it.
-- ============================================================================

begin;

create temp table zz_0041_before on commit drop as
  select id, revision, updated_at, category, labels, is_favorite,
         title, address, description, notes, details, links, photos, contacts
    from public.library_items;


-- 1. A section for every category in use that does not have one yet.
--
--    `distinct on` folds case, because normalizeCategory prevents "Communities"
--    and "communities" coexisting at WRITE time but the 0038 CHECK only demands
--    the value be trimmed — so a folded duplicate is representable, and would
--    otherwise collide with library_sections_user_name_key.
--
--    WHERE is evaluated before the window function, so row_number ranks only
--    the sections actually being added and they append after any that exist.
insert into public.library_sections (user_id, name, sort_order)
select c.user_id, c.name,
       coalesce((select max(s2.sort_order) + 1 from public.library_sections s2
                  where s2.user_id = c.user_id), 0)
       + (row_number() over (partition by c.user_id order by lower(c.name), c.name) - 1)::int
  from (
    select distinct on (user_id, lower(btrim(category)))
           user_id, btrim(category) as name
      from public.library_items
     where btrim(category) <> ''
     order by user_id, lower(btrim(category)), btrim(category)
  ) c
 where not exists (select 1 from public.library_sections s
                    where s.user_id = c.user_id and lower(s.name) = lower(c.name));

-- 2. Point every categorised item at the section its category names.
--
--    The group is CLEARED when the section changes, because a group belongs to
--    the section it sits under — an item that moves cannot carry it along, and
--    0039's composite foreign key would refuse the row if it tried.
--
--    NO GROUP IS EVER INVENTED. A category said one thing about an item;
--    splitting it into a second level would be structure the professional never
--    asked for, and guessing that "Large Community - Petaluma" means a group
--    called Petaluma is exactly the kind of guess that is not ours to make.
--
--    The sentinel sort_order makes the dense pass in step 5 APPEND arrivals
--    behind anything already placed by hand — and makes a first run, where
--    every row is an arrival, reduce to ordering by updated_at desc, id desc:
--    precisely the order the professional can currently see.
update public.library_items li
   set section_id = s.id, group_id = null, sort_order = 2147483647
  from public.library_sections s
 where s.user_id = li.user_id
   and lower(s.name) = lower(btrim(li.category))
   and btrim(li.category) <> ''
   and li.section_id is distinct from s.id;

-- 3. A cleared category means the professional took the item out of its home.
update public.library_items
   set section_id = null, group_id = null, sort_order = 0
 where btrim(category) = ''
   and (section_id is not null or group_id is not null or sort_order <> 0);

-- 4. Prune structure nothing is in any more — the same rule the application
--    follows. Groups first, because emptying a group can be what empties the
--    section above it.
delete from public.library_groups g
 where not exists (select 1 from public.library_items li where li.group_id = g.id);

delete from public.library_sections s
 where not exists (select 1 from public.library_items li where li.section_id = s.id)
   and not exists (select 1 from public.library_groups g where g.section_id = s.id);

-- 5. Dense, stable order within every container.
--
--    sort_order LEADS the ordering, so a container that already has a hand-made
--    sequence keeps it exactly; updated_at desc, id desc only decides among
--    rows that are tied — which, on a first run, is all of them.
with ranked as (
  select id,
         (row_number() over (partition by user_id, section_id, group_id
                                 order by sort_order, updated_at desc, id desc) - 1)::int as ord
    from public.library_items
   where section_id is not null
)
update public.library_items li
   set sort_order = r.ord
  from ranked r
 where r.id = li.id and li.sort_order is distinct from r.ord;


do $v$
declare v_moved bigint; v_split bigint; v_dense bigint; v_lost bigint;
begin
  -- 1. Nothing about the item's CONTENT, its stamps, its labels, its star or
  --    the shadow itself was touched. This migration only moves things between
  --    section_id, group_id and sort_order.
  select count(*) into v_moved
    from public.library_items li join zz_0041_before b on b.id = li.id
   where li.revision    is distinct from b.revision
      or li.updated_at  is distinct from b.updated_at
      or li.category    is distinct from b.category
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
    raise exception '0041: % item(s) had content, stamps, labels, favorite or the shadow changed', v_moved;
  end if;

  -- 2. No row appeared or vanished.
  select count(*) into v_lost from (
    (select id from zz_0041_before except select id from public.library_items)
    union all
    (select id from public.library_items except select id from zz_0041_before)
  ) d;
  if v_lost <> 0 then
    raise exception '0041: the library item set changed during a reconciliation (% row(s))', v_lost;
  end if;

  -- 3. Every item describes ONE home: a blank shadow means no section, and a
  --    nonblank one means the section of that name.
  select count(*) into v_split from public.library_items li
    left join public.library_sections s on s.id = li.section_id
   where lower(coalesce(s.name, '')) is distinct from lower(btrim(li.category));
  if v_split <> 0 then
    raise exception '0041: % item(s) still describe two different homes', v_split;
  end if;

  -- 4. Positions are dense from 0 in every container, so first and last mean
  --    what the Move controls assume. Expressed as min/max/distinct because an
  --    aggregate cannot be passed to a set-returning function in FROM.
  select count(*) into v_dense from (
    select 1 from public.library_items
     where section_id is not null
     group by user_id, section_id, group_id
    having min(sort_order) <> 0
        or max(sort_order) <> count(*) - 1
        or count(distinct sort_order) <> count(*)
  ) t;
  if v_dense <> 0 then
    raise exception '0041: % container(s) do not have dense positions', v_dense;
  end if;

  -- 5. No empty structure survived.
  if exists (select 1 from public.library_groups g
              where not exists (select 1 from public.library_items li where li.group_id = g.id)) then
    raise exception '0041: an empty group survived reconciliation';
  end if;
  if exists (select 1 from public.library_sections s
              where not exists (select 1 from public.library_items li where li.section_id = s.id)
                and not exists (select 1 from public.library_groups g where g.section_id = s.id)) then
    raise exception '0041: an empty section survived reconciliation';
  end if;
end;
$v$;

commit;
