-- ============================================================================
-- 0039 — SECTION -> optional GROUP -> ITEM, plus persistent manual order.
--
-- EXPAND ONLY, AND DELIBERATELY EMPTY. This migration adds structure and writes
-- NO DATA AT ALL. Every existing row keeps section_id null, group_id null and
-- sort_order 0 — which is exactly what "not placed" already meant.
--
-- WHY THERE IS NO BACKFILL HERE, THOUGH THE OBVIOUS PLACE FOR ONE IS HERE.
--
-- Deployment applies migrations BEFORE runtime, so between this migration and
-- the structured runtime going live, production at 348a614 keeps writing
-- library_items.category — through the Organize panel's Set and Clear, and
-- through the Library item editor. Those are the only two paths that can change
-- it, and neither knows section_id exists.
--
-- So a backfill placed HERE would create a second description of where each
-- item lives, and then sit there going stale for the whole length of that
-- window. Set a category in production the next day and the item's category and
-- its section_id disagree; clear one and section_id points at a home the
-- professional has already abandoned.
--
-- Moving the backfill to the migration that runs immediately before the new
-- runtime does not merely shrink that window — it removes it. For as long as
-- only 348a614 is live, category is the SOLE description of an item's home,
-- section_id is uniformly null, and there is no second copy that can drift.
-- Nothing has to be synchronised because nothing is duplicated.
--
-- The consequence for this file is that it writes nothing, which makes it the
-- safest possible thing to apply early: no UPDATE means no question about
-- whether revision or updated_at moved.
--
-- category, its CHECK and its indexes all stay exactly as 0038 left them. The
-- contract migration that removes category comes later, only once the
-- replacement runtime is live and verified.
--
-- ---------------------------------------------------------------------------
-- WHY SECTIONS AND GROUPS ARE ROWS AND CATEGORY WAS A STRING.
--
-- A category is a word repeated on every item that happens to share it. That is
-- enough to filter by and nothing else. A Section has to carry a POSITION, be
-- renamed without rewriting every item that mentions it, and scope the Groups
-- inside it — so "Santa Rosa" under Communities and "Santa Rosa" under Services
-- are different groups even though the words match. None of that fits in a
-- string repeated across rows.
--
-- Still no taxonomy administration. Sections and Groups are created inline at
-- the moment items are placed into them, and removed when the last item leaves.
-- There is no screen for managing them and no way to build an empty one ahead
-- of time. They exist because material is in them.
--
-- ---------------------------------------------------------------------------
-- ONE STRUCTURAL HOME. Two nullable columns and no join table, so an item
-- appearing in several places at once is not merely discouraged — it cannot be
-- written. Alternate dimensions are labels, which already cut across freely.
--
-- ---------------------------------------------------------------------------
-- DELETING STRUCTURE MUST NOT RE-HOME ANYTHING.
--
-- `on delete set null` was the obvious choice and it is the wrong one: deleting
-- a Section would silently empty its items back into the unorganized pile as a
-- database side effect, and the professional would find their filing undone by
-- something they never asked for. Both item-side foreign keys are NO ACTION, so
-- a container that still holds items cannot be deleted at all. Moving items out
-- is an explicit act, performed by the application, before the container can go.
--
-- NO ACTION rather than RESTRICT, for one specific reason. Both refuse the
-- delete; RESTRICT is checked immediately and cannot be deferred, NO ACTION at
-- end of statement. Deleting a user cascades to library_items AND to
-- library_sections within a single statement, and RESTRICT could fire midway
-- through that cascade depending on the order rows are processed. NO ACTION
-- sees the finished statement, where both sides are already gone. Account
-- deletion keeps working; structural deletion still cannot orphan an item.
--
-- ---------------------------------------------------------------------------
-- COMPOSITE FOREIGN KEYS, BECAUSE THE WRONG PLACEMENT SHOULD BE UNWRITABLE.
--
--   (section_id, user_id) -> library_sections (id, user_id)
--       an item can only be placed in its OWN owner's section.
--   (group_id, section_id) -> library_groups (id, section_id)
--       an item can only be in a group belonging to the section it is in.
--
-- Both are MATCH SIMPLE, so a null in either column satisfies them trivially.
-- That is correct for section_id null (an unorganized item) and for group_id
-- null (a loose item in a section) — but it also lets group_id be set while
-- section_id is null, which is the one nonsensical combination the pair cannot
-- catch. The CHECK below closes it, so a group without a section is
-- unrepresentable rather than merely unlikely.
--
-- ---------------------------------------------------------------------------
-- ORDER.
--
-- sort_order is scoped to a container: sections within a user, groups within a
-- section, items within their (section_id, group_id) pair. It is meaningful
-- only where a professional has actually expressed structure — the unorganized
-- remainder stays newest-first and is not hand-ordered, which is why the
-- default of 0 on 65 existing rows changes nothing.
--
-- ---------------------------------------------------------------------------
-- NEITHER revision NOR updated_at MOVES. This is the load-bearing invariant and
-- it is verified, not assumed.
--
-- revision is the save-back comparator: a copied item records the revision it
-- came from, and a mismatch means "the base moved on". updated_at is the
-- Library's ordering. If filing bumped either, tidying a 65-item Library would
-- report 65 diverged FlowGuides, or silently reshuffle the list into migration
-- order.
--
-- library_items carries exactly ONE trigger, trg_library_clear_lineage, which
-- is BEFORE DELETE and cannot fire on an update. Nothing else stamps either
-- column; both are advanced only by explicit SQL naming them, in
-- updateLibraryItem and library_update_from_item. The backfill below names
-- neither — and then proves it, row by row, against a snapshot taken first.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- The invariant, captured BEFORE anything is written.
-- ---------------------------------------------------------------------------
create temp table zz_0039_before on commit drop as
  select id, revision, updated_at from public.library_items;


-- ---------------------------------------------------------------------------
-- SECTIONS. One per name per professional, case-insensitively: "Communities"
-- and "communities" are one idea typed twice, and two sections would be a bug
-- either way.
-- ---------------------------------------------------------------------------
create table if not exists public.library_sections (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  name       text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),

  constraint library_sections_name_clean check (name = btrim(name) and name <> ''),
  -- FK target for the composite key on library_items. id is already unique;
  -- this exists so a placement can be checked against the OWNER too.
  constraint library_sections_id_user_key unique (id, user_id)
);

comment on table public.library_sections is
  'One optional top-level grouping in a professional''s Library, named by them. Created inline when items are placed into it and removed when the last item leaves; there is no management screen and no empty-container workflow. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

create unique index if not exists library_sections_user_name_key
  on public.library_sections (user_id, lower(name));

create index if not exists library_sections_user_order_idx
  on public.library_sections (user_id, sort_order, id);


-- ---------------------------------------------------------------------------
-- GROUPS. Scoped to their section, which is the whole point: a group named
-- "Santa Rosa" under Communities and one under Services are structurally
-- separate, and the unique below is per-section rather than per-user so both
-- can exist at once.
--
-- user_id is carried here so every group write can name its owner explicitly,
-- the way every other write in this layer does. The composite foreign key makes
-- that copy incapable of drifting from the section's owner.
-- ---------------------------------------------------------------------------
create table if not exists public.library_groups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  section_id uuid not null,
  name       text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),

  constraint library_groups_name_clean check (name = btrim(name) and name <> ''),
  constraint library_groups_id_section_key unique (id, section_id),
  constraint library_groups_section_fk
    foreign key (section_id, user_id) references public.library_sections (id, user_id)
    on delete cascade
);

comment on table public.library_groups is
  'An optional second level inside one Library section, named by the professional. Scoped to its section, so identically named groups under different sections are different groups. Created inline while placing items and removed when the last item leaves. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

create unique index if not exists library_groups_section_name_key
  on public.library_groups (section_id, lower(name));

create index if not exists library_groups_section_order_idx
  on public.library_groups (section_id, sort_order, id);


-- ---------------------------------------------------------------------------
-- PRIVILEGE BOUNDARY — exactly the posture 0017 gave library_items.
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting ALL on new tables in public
-- to anon and authenticated. So a CREATE TABLE that says nothing about
-- privileges does not create a closed table; it creates one readable and
-- writable by the anon key, which ships in the browser bundle. Silence is a
-- decision here, and the wrong one.
--
-- TWO LAYERS, because they fail independently — 0015's finding, applied to the
-- two tables it could not have known about.
--
--   Policy layer: RLS enabled with ZERO policies. No policy means no permissive
--   path, so anon and authenticated are denied SELECT, INSERT, UPDATE and
--   DELETE. service_role bypasses RLS entirely, which is why the application
--   keeps working and why ownership is the service layer's job.
--
--   Privilege layer: the grants themselves. This is the layer that actually
--   answers today — a live anon probe against library_items returns 42501
--   insufficient_privilege, refused before RLS is ever consulted. It is also
--   the ONLY gate on TRUNCATE and REFERENCES, which no policy could ever
--   constrain.
--
-- ZERO POLICIES IS THE DESIGN, NOT AN OMISSION. FlowGuide does not use Supabase
-- Auth: sessions are a flowguide_session cookie against public.sessions, so no
-- browser ever holds a JWT and nothing ever assumes the authenticated role.
-- createPublicClient exists but every function in queries.ts uses
-- createServerClient, so even recipient pages render server-side. A policy here
-- would be a permission granted to a role that never arrives.
-- ---------------------------------------------------------------------------
alter table public.library_sections enable row level security;
alter table public.library_groups   enable row level security;

revoke all on table public.library_sections from public;
revoke all on table public.library_sections from anon, authenticated;
revoke all on table public.library_groups   from public;
revoke all on table public.library_groups   from anon, authenticated;

grant select, insert, update, delete on table public.library_sections to service_role;
grant select, insert, update, delete on table public.library_groups   to service_role;


-- ---------------------------------------------------------------------------
-- THE ITEM'S ONE HOME, AND ITS PLACE IN IT.
--
-- `add column ... default` is metadata-only in modern postgres: no table
-- rewrite, no UPDATE, no row trigger, nothing stamped. Existing rows become
-- "not placed", which is what they already are.
-- ---------------------------------------------------------------------------
alter table public.library_items
  add column if not exists section_id uuid,
  add column if not exists group_id   uuid,
  add column if not exists sort_order int not null default 0;

comment on column public.library_items.section_id is
  'The one section this item lives in, or null for unorganized. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

comment on column public.library_items.group_id is
  'The optional group within that section, or null for an item sitting loose in the section. Library organization only.';

comment on column public.library_items.sort_order is
  'Position within this item''s container — the (section_id, group_id) pair. Meaningful only for a placed item; the unorganized remainder is ordered newest-first and is not hand-ordered. Library organization only.';

alter table public.library_items
  -- An item can only be placed in its own owner's section.
  add constraint library_items_section_fk
    foreign key (section_id, user_id) references public.library_sections (id, user_id)
    on delete no action,
  -- An item can only be in a group belonging to the section it is in.
  add constraint library_items_group_fk
    foreign key (group_id, section_id) references public.library_groups (id, section_id)
    on delete no action,
  -- Closes the MATCH SIMPLE hole above: a group without a section.
  add constraint library_items_group_needs_section
    check (group_id is null or section_id is not null);

-- Paging WITHIN a container: `user_id = ? and section_id = ? and group_id is ?`
-- ordered by (sort_order, id). Matches column for column, so a page is a range
-- scan. Also serves the child-side lookup when a section is deleted.
create index if not exists library_items_container_idx
  on public.library_items (user_id, section_id, group_id, sort_order, id);

-- The DEFAULT VIEW: everything not placed, newest-first, exactly as today.
-- Partial because it is the one query every professional runs every visit, and
-- because a Library that is entirely organized should not pay to index it.
create index if not exists library_items_unorganized_idx
  on public.library_items (user_id, updated_at desc, id desc)
  where section_id is null;

-- The child side of library_items_group_fk. Deleting a group must find the
-- items referencing it; without this that check is a sequential scan.
create index if not exists library_items_group_idx
  on public.library_items (group_id)
  where group_id is not null;


-- ---------------------------------------------------------------------------
-- PROOF, not assertion by comment.
-- ---------------------------------------------------------------------------
do $v$
declare
  v_moved   bigint;
  v_lost    bigint;
  v_placed    bigint;
  v_structure bigint;
begin
  -- 1. NOTHING was stamped. Row by row against the snapshot taken first.
  --    `add column ... default` is metadata-only in modern postgres, so this
  --    should be impossible — which is the reason to check it rather than the
  --    reason to skip it.
  select count(*) into v_moved
    from public.library_items li
    join zz_0039_before b on b.id = li.id
   where li.revision is distinct from b.revision
      or li.updated_at is distinct from b.updated_at;
  if v_moved <> 0 then
    raise exception '0039: % library item(s) had revision or updated_at changed by a structure-only migration', v_moved;
  end if;

  -- 2. No row appeared or vanished.
  select count(*) into v_lost from (
    (select id from zz_0039_before except select id from public.library_items)
    union all
    (select id from public.library_items except select id from zz_0039_before)
  ) d;
  if v_lost <> 0 then
    raise exception '0039: the library item set changed during an additive migration (% row(s))', v_lost;
  end if;

  -- 3. NOTHING WAS PLACED. This is the whole point of deferring the backfill:
  --    while production still writes category, section_id must describe
  --    nothing at all, so there is no second home that can go stale.
  select count(*) into v_placed from public.library_items
   where section_id is not null or group_id is not null or sort_order <> 0;
  if v_placed <> 0 then
    raise exception '0039: % item(s) were placed by a migration that must place none', v_placed;
  end if;

  -- 4. And no structure was invented to place them into.
  select count(*) into v_structure from public.library_sections;
  if v_structure <> 0 then
    raise exception '0039: % section(s) were created by a structure-only migration', v_structure;
  end if;
  select count(*) into v_structure from public.library_groups;
  if v_structure <> 0 then
    raise exception '0039: % group(s) were created by a structure-only migration', v_structure;
  end if;

  -- 6. EXPAND ONLY. The runtime in production still needs every one of these.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'library_items'
                    and column_name = 'category') then
    raise exception '0039: library_items.category was removed by an expand-only migration';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.library_items'::regclass
                    and conname = 'library_items_category_trimmed') then
    raise exception '0039: the 0038 category CHECK was removed by an expand-only migration';
  end if;
  if to_regclass('public.library_items_category_page_idx') is null then
    raise exception '0039: the 0038 category index was removed by an expand-only migration';
  end if;
  if to_regclass('public.library_items_page_idx') is null then
    raise exception '0039: the 0038 paging index is missing';
  end if;

  -- 7. Deleting structure cannot re-home an item. 'a' is NO ACTION; 'n' would
  --    be SET NULL, which is precisely the silent relocation this forbids.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.library_items'::regclass
                    and conname = 'library_items_section_fk' and confdeltype = 'a') then
    raise exception '0039: the section foreign key is missing or does not refuse deletion';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.library_items'::regclass
                    and conname = 'library_items_group_fk' and confdeltype = 'a') then
    raise exception '0039: the group foreign key is missing or does not refuse deletion';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.library_items'::regclass
                    and conname = 'library_items_group_needs_section') then
    raise exception '0039: a group without a section is representable';
  end if;

  -- 8. THE NEW TABLES ARE CLOSED, at both layers, verified rather than assumed.
  if not (select relrowsecurity from pg_class where oid = 'public.library_sections'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.library_groups'::regclass) then
    raise exception '0039: row level security is not enabled on the new tables';
  end if;

  select count(*) into v_structure from pg_policies
   where schemaname = 'public' and tablename in ('library_sections', 'library_groups');
  if v_structure <> 0 then
    raise exception '0039: % policy/policies exist where the design is zero', v_structure;
  end if;

  -- The privilege layer, which is what actually answers a request and is the
  -- only gate on TRUNCATE and REFERENCES.
  select count(*) into v_structure from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('library_sections', 'library_groups')
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_structure <> 0 then
    raise exception '0039: % grant(s) to anon/authenticated/PUBLIC survive on the new tables', v_structure;
  end if;

  -- ...and service_role can still do its job, or the application is bricked.
  -- Each privilege separately: has_table_privilege with a comma-separated list
  -- is true when ANY of them is held, which would pass on SELECT alone.
  if exists (
    select 1 from unnest(array['library_sections','library_groups']) t,
                unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
     where not has_table_privilege('service_role', 'public.' || t, p)
  ) then
    raise exception '0039: service_role cannot fully reach the new tables';
  end if;

  -- 9. library_items still carries exactly one trigger, and it is BEFORE DELETE.
  --    This is what makes "an organizational write stamps nothing" structural
  --    rather than a habit the next migration could break.
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.library_items'::regclass and not t.tgisinternal) <> 1 then
    raise exception '0039: library_items no longer carries exactly one trigger';
  end if;
end;
$v$;

commit;
