-- ============================================================================
-- 0040 — CUTOVER. The legacy `category` becomes real Section structure.
--
-- Applied IMMEDIATELY BEFORE the structured runtime deploys, which is the whole
-- reason 0039 carried no backfill. For the entire window since 0039, `category`
-- has been the SOLE description of where an item lives and section_id has been
-- uniformly null — so nothing could drift, because nothing was duplicated.
-- This migration is where the second description is created, moments before the
-- runtime that owns it goes live.
--
-- WHAT IT WILL ACTUALLY DO IN PRODUCTION. Not a hypothetical: at the time of
-- writing, three items carry `Large Community - Petaluma` and the other
-- sixty-two carry nothing. So this creates ONE section of that name and places
-- those three in it, newest first, and leaves sixty-two items unorganized.
-- Assuming production categories are blank would be wrong — they were blank
-- when 0039 was drafted and stopped being blank while it waited.
--
-- ---------------------------------------------------------------------------
-- CATEGORY IS THE AUTHORITY HERE, AND ONLY HERE.
--
-- Until the new runtime is live, `category` is the only thing anything writes,
-- so reconciling TOWARD it is lossless. Afterwards the runtime keeps it equal
-- to the section's name — it becomes the rollback shadow — which is what keeps
-- this same logic safe to run again rather than destructive.
--
-- ---------------------------------------------------------------------------
-- THIS LOGIC IS MEANT TO BE COPIED, NOT RE-RUN.
--
-- An applied migration is immutable. If a category write slips through in the
-- minutes between this running and the runtime going live, the fix is a NEW
-- 0041 containing the block between the two CATCH-UP markers below, verbatim —
-- never re-running this file. The block is written to be self-contained and
-- idempotent for exactly that reason: it reads only `category` and the current
-- structure, holds no state from this migration, and reaching a settled state
-- twice changes nothing the second time.
--
-- ---------------------------------------------------------------------------
-- NEITHER revision NOR updated_at NOR category MOVES. revision is the save-back
-- comparator and updated_at is the Library's ordering; bumping either would
-- report every descendant FlowGuide as diverged, or reshuffle the list into
-- migration order. `category` is asserted unchanged too — this migration reads
-- it and must never edit it, or the shadow would stop being a faithful record
-- of what the previous runtime believed.
-- ============================================================================

begin;

create temp table zz_0040_before on commit drop as
  select id, revision, updated_at, category from public.library_items;

-- ===================== CATCH-UP BLOCK BEGINS ================================
-- Everything between these markers is what a later 0041 would contain.

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

-- ===================== CATCH-UP BLOCK ENDS ==================================

do $v$
declare v_moved bigint; v_split bigint; v_dense bigint;
begin
  -- Read-only with respect to content, the shadow included.
  select count(*) into v_moved
    from public.library_items li join zz_0040_before b on b.id = li.id
   where li.revision is distinct from b.revision
      or li.updated_at is distinct from b.updated_at
      or li.category  is distinct from b.category;
  if v_moved <> 0 then
    raise exception '0040: % item(s) had revision, updated_at or category changed by a read-only reconciliation', v_moved;
  end if;

  -- Every item describes ONE home. A blank category must mean no section, and a
  -- nonblank one must mean the section of that name — anything else is the two
  -- representations disagreeing, which is the entire thing this prevents.
  select count(*) into v_split from public.library_items li
    left join public.library_sections s on s.id = li.section_id
   where lower(coalesce(s.name, '')) is distinct from lower(btrim(li.category));
  if v_split <> 0 then
    raise exception '0040: % item(s) still describe two different homes', v_split;
  end if;

  -- Positions are dense from 0 in every container, so "first" and "last" mean
  -- what the Move controls assume they mean.
  --   min 0, max n-1, and no repeats is exactly the set 0..n-1. Expressed this
  --   way rather than by building the series: an aggregate cannot be passed to
  --   a set-returning function in FROM, which is a syntax error rather than a
  --   wrong answer, so the tidier-looking version simply does not run.
  select count(*) into v_dense from (
    select 1 from public.library_items
     where section_id is not null
     group by user_id, section_id, group_id
    having min(sort_order) <> 0
        or max(sort_order) <> count(*) - 1
        or count(distinct sort_order) <> count(*)
  ) t;
  if v_dense <> 0 then
    raise exception '0040: % container(s) do not have dense positions', v_dense;
  end if;

  -- No group can exist without items, and none was invented from a category.
  if exists (select 1 from public.library_groups g
              where not exists (select 1 from public.library_items li where li.group_id = g.id)) then
    raise exception '0040: an empty group survived reconciliation';
  end if;
end;
$v$;

commit;
