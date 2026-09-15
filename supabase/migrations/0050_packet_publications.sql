-- ============================================================================
-- 0050 — A DRAFT REVISION, AND A PLACE FOR THE FROZEN PUBLISHED COPY.
--
-- Additive only: nothing reads or writes what this creates
-- until later code ships, and no published-edit guard is loosened here.
--
-- THE PRODUCT BEHAVIOUR THIS PREPARES. A published Sendset stays live at the
-- same URL while its owner edits. The live rows (sections, items, …) become the
-- WORKING DRAFT, always. Republish freezes one recipient-safe copy into
-- packet_publications; /p/[slug], print and the email version read only that.
--
-- ---------------------------------------------------------------------------
-- WHAT THE COUNTERS ARE: CONSERVATIVE REVISIONS, FOR CONFLICT DETECTION.
--
--   If anything that could change the next published snapshot changes, a
--   revision moves. Nothing that cannot change it may move one.
--
-- They are NOT an exact "the recipient would now see something different"
-- signal. They over-count (see below), never under-count. So the only sound
-- reading is one-directional:
--
--   revisions equal to the publication's   =>  nothing that feeds the snapshot
--                                              has been written since
--   revisions differ                       =>  something MAY differ
--
-- That is exactly what optimistic concurrency needs (0051: "did anything change
-- between the checks and the write?"). It is not enough to tell a professional
-- "Changes not live yet", so 0050 deliberately exposes no staleness predicate.
-- An exact one belongs with the snapshot writer, comparing a fingerprint of the
-- serialized publication against a fresh serialization.
--
-- Two counters, because the ACCOUNT PROFILE feeds only some Sendsets:
--
--   packets.draft_rev                      this Sendset's own inputs
--   professional_profiles.identity_rev     the owner's profile
--
-- A publication records both source revisions, and says explicitly whether its
-- NEXT publication depends on the profile:
--
--   identity_dependency  'account_profile'  identity_mode 'default'. The card is
--                                           built from the profile — or omitted,
--                                           when the profile failed the
--                                           readiness rule and the owner
--                                           published anyway. The frozen identity
--                                           may be {}, but the profile still
--                                           decides the next one.
--                        'sendset'          identity_mode 'custom' or 'none'.
--                                           Nothing outside the Sendset's own
--                                           row feeds its identity, with or
--                                           without the readiness bypass.
--
-- It is a dependency, not a description of what was frozen, and it cannot drift
-- from the Sendset: identity_mode is counted by draft_rev, so changing it moves
-- that revision first.
--
-- Why not fan a profile edit out to each packet's draft_rev instead: it would
-- re-stamp packets.updated_at and reorder every dashboard — the exact harm 0037
-- went out of its way to avoid.
--
-- WHAT COUNTS (each is read by getPublishedPacket or decides the snapshot):
--
--   packets         slug, user_id, client_title, client_name, personal_note,
--                   map_url, show_quick_nav, style_treatment, composition_mode,
--                   identity_mode, custom_identity
--   sections        id, packet_id, title, description, sort_order
--   items           id, section_id, title, address, description, highlight,
--                   sort_order
--   item_photos     item_id, url, sort_order
--   item_links      item_id, url, label, sort_order
--   item_details    item_id, label, value, sort_order
--   item_contacts   item_id, name, role, phone, email, website, sort_order
--   packet_blocks   id, packet_id, position, block_type, item_id,
--                   heading_text, heading_subtext
--   professional_profiles  user_id, name, email, phone, business_name,
--                   logo_url, headshot_url, footer_label, website_url, links
--
-- Child INSERT and DELETE always count. Child UPDATE counts only when one of
-- the listed columns actually changes (a WHEN clause, so a no-op reorder or a
-- notes-only save never reaches the function).
--
-- WHAT DOES NOT COUNT, DELIBERATELY:
--
--   packets.title             internal name; 0037 — never shown to a recipient
--   packets.viewed, status, published_at, professional_snapshot (an OUTPUT of
--     publishing, not an input to the next one), raw_input,
--     origin_ingestion_run_id, packet_type, content_rev, structural_rev,
--     updated_at, created_at
--   items.notes               private; the recipient path never assembles it
--   items.library_item_id / library_item_revision / origin_*   provenance
--   item_photos.storage_path, every created_at / updated_at
--   item_media_decisions      gates publishing; changes no rendered byte
--   ingestion_*, library_*    not read by the renderer
--
-- The publication table REFUSES a snapshot carrying a top-level `title` or a
-- `notes` key at any depth. What the revision ignores, the snapshot may not
-- contain — so the rule cannot be broken by a serializer that includes them.
--
-- KNOWN OVER-COUNTS (harmless for conflict detection — at worst a spurious
-- "changed while publishing, try again"):
--   * update_item_content rewrites details/links/photos/contacts by DELETE +
--     INSERT on every save, so a save that changes nothing still counts.
--   * A reorder that renumbers rows to the same visible order still counts.
--   * identity_rev moves on any change to a listed profile field, including for
--     an owner whose card-less default Sendsets would still publish card-less.
-- There is no known UNDER-count. Finding one is a defect in this migration.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW COUNTER, NOT content_rev.
--
-- content_rev and structural_rev belong to the ingestion guard (0012, 0034).
-- 0030, 0037 and 0049 each deliberately kept presentation fields OUT of
-- ingest_bump_packet_self(), and 0049 fingerprints that function's body. The
-- draft revision needs those fields IN, and needs notes/lineage OUT. One counter
-- cannot mean both, so this migration touches none of the existing functions.
--
-- ---------------------------------------------------------------------------
-- EXISTING ROWS. Every packet starts at draft_rev = 0 and every profile at
-- identity_rev = 0 via ADD COLUMN … DEFAULT 0, which rewrites no row and fires
-- no trigger — updated_at is untouched, and that is asserted below. Like
-- structural_rev (0034), both counters are MEANINGFUL ONLY FROM 0050 FORWARD.
-- packet_publications starts empty; filling it for already-published Sendsets
-- is a separate, reviewed backfill from the application serializer.
--
-- GRANTS. packet_publications: RLS on, no policies, everything revoked from
-- public/anon/authenticated/service_role, then SELECT only to service_role.
-- Nobody can write it until the reviewed publish RPC (0051) exists. Trigger
-- functions: SECURITY DEFINER, search_path '', EXECUTE revoked from every role
-- and never granted (triggers fire regardless of EXECUTE).
-- 0050 creates no callable function.
--
-- ROLLBACK: supabase/rollbacks/0050_packet_publications_down.sql. Lossless
-- while nothing reads these objects.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. Refuse to run twice or onto a drifted shape.
-- ---------------------------------------------------------------------------
do $$
declare c text;
begin
  if to_regclass('public.packet_publications') is not null then
    raise exception 'MIGRATION 0050 ABORTED: public.packet_publications already exists.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'packets' and column_name = 'draft_rev') then
    raise exception 'MIGRATION 0050 ABORTED: packets.draft_rev already exists.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'professional_profiles' and column_name = 'identity_rev') then
    raise exception 'MIGRATION 0050 ABORTED: professional_profiles.identity_rev already exists.';
  end if;

  -- Every column the WHEN clauses and tuples name must exist. CREATE TRIGGER
  -- would fail anyway; this says which one, before anything is created.
  foreach c in array array[
    'packets.slug','packets.user_id','packets.client_title','packets.client_name',
    'packets.personal_note','packets.map_url','packets.show_quick_nav',
    'packets.style_treatment','packets.composition_mode','packets.identity_mode',
    'packets.custom_identity','packets.updated_at',
    'sections.packet_id','sections.title','sections.description','sections.sort_order',
    'items.section_id','items.title','items.address','items.description',
    'items.highlight','items.sort_order',
    'item_photos.item_id','item_photos.url','item_photos.sort_order',
    'item_links.item_id','item_links.url','item_links.label','item_links.sort_order',
    'item_details.item_id','item_details.label','item_details.value','item_details.sort_order',
    'item_contacts.item_id','item_contacts.name','item_contacts.role','item_contacts.phone',
    'item_contacts.email','item_contacts.website','item_contacts.sort_order',
    'packet_blocks.packet_id','packet_blocks.position','packet_blocks.block_type',
    'packet_blocks.item_id','packet_blocks.heading_text','packet_blocks.heading_subtext',
    'professional_profiles.user_id','professional_profiles.name','professional_profiles.email',
    'professional_profiles.phone','professional_profiles.business_name',
    'professional_profiles.logo_url','professional_profiles.headshot_url',
    'professional_profiles.footer_label','professional_profiles.website_url',
    'professional_profiles.links','professional_profiles.updated_at'
  ] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public'
                      and table_name = split_part(c, '.', 1)
                      and column_name = split_part(c, '.', 2)) then
      raise exception 'MIGRATION 0050 ABORTED: expected column public.% does not exist.', c;
    end if;
  end loop;
end $$;

-- The before-picture for "no existing row was touched". Session-private and
-- gone at COMMIT (see 0037 for why the SQL Editor's RLS warning is false here).
create temp table _0050_before on commit drop as
  select 'packet' as kind, id, updated_at from public.packets
  union all
  select 'profile', id, updated_at from public.professional_profiles;

-- ---------------------------------------------------------------------------
-- 1. THE COUNTERS.
-- ---------------------------------------------------------------------------
alter table public.packets
  add column draft_rev bigint not null default 0;

comment on column public.packets.draft_rev is
  'Draft revision (0050). Moves whenever anything that would change this Sendset''s NEXT published snapshot changes; never on views, publishing, private notes or provenance. Paired with professional_profiles.identity_rev for default-identity Sendsets. Never decreases. Meaningful only from 0050 forward.';

alter table public.professional_profiles
  add column identity_rev bigint not null default 0;

comment on column public.professional_profiles.identity_rev is
  'Identity revision (0050). Moves when any profile field a published contact card is built from changes. Never decreases. Meaningful only from 0050 forward.';

-- ---------------------------------------------------------------------------
-- 2. SELF TRIGGERS: a visible column on the row itself changed.
--
-- Only when the statement did not already move the counter, so a child-trigger
-- bump (which changes draft_rev and nothing visible) is never counted twice.
-- A decrease is refused: a counter someone can wind back is not a revision.
-- ---------------------------------------------------------------------------
create function public.draft_rev_packet_self() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.draft_rev < old.draft_rev then
    raise exception 'packets.draft_rev may not decrease (% -> %) on packet %',
      old.draft_rev, new.draft_rev, old.id;
  end if;
  if new.draft_rev = old.draft_rev
     and (new.slug, new.user_id, new.client_title, new.client_name, new.personal_note,
          new.map_url, new.show_quick_nav, new.style_treatment, new.composition_mode,
          new.identity_mode, new.custom_identity)
         is distinct from
         (old.slug, old.user_id, old.client_title, old.client_name, old.personal_note,
          old.map_url, old.show_quick_nav, old.style_treatment, old.composition_mode,
          old.identity_mode, old.custom_identity)
  then
    new.draft_rev := old.draft_rev + 1;
  end if;
  return new;
end;
$$;

create function public.identity_rev_profile_self() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.identity_rev < old.identity_rev then
    raise exception 'professional_profiles.identity_rev may not decrease (% -> %) on profile %',
      old.identity_rev, new.identity_rev, old.id;
  end if;
  if new.identity_rev = old.identity_rev
     and (new.user_id, new.name, new.email, new.phone, new.business_name, new.logo_url,
          new.headshot_url, new.footer_label, new.website_url, new.links)
         is distinct from
         (old.user_id, old.name, old.email, old.phone, old.business_name, old.logo_url,
          old.headshot_url, old.footer_label, old.website_url, old.links)
  then
    new.identity_rev := old.identity_rev + 1;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. CHILD TRIGGERS: bump the owning packet.
--
-- Both the OLD and the NEW owner are bumped, so a row that moves between
-- Sendsets changes both. `where id in (a, b)` updates each packet at most once
-- and ignores nulls. Cascade-safe: when the owner is already gone the lookup
-- finds nothing and the update touches 0 rows (the same property 0012 relies on).
-- ---------------------------------------------------------------------------
create function public.draft_rev_by_packet() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p_old uuid; p_new uuid;
begin
  if tg_op <> 'INSERT' then p_old := old.packet_id; end if;
  if tg_op <> 'DELETE' then p_new := new.packet_id; end if;
  update public.packets set draft_rev = draft_rev + 1 where id in (p_old, p_new);
  return null;
end;
$$;

create function public.draft_rev_by_section() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p_old uuid; p_new uuid;
begin
  if tg_op <> 'INSERT' then
    select s.packet_id into p_old from public.sections s where s.id = old.section_id;
  end if;
  if tg_op <> 'DELETE' then
    select s.packet_id into p_new from public.sections s where s.id = new.section_id;
  end if;
  update public.packets set draft_rev = draft_rev + 1 where id in (p_old, p_new);
  return null;
end;
$$;

create function public.draft_rev_by_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p_old uuid; p_new uuid;
begin
  if tg_op <> 'INSERT' then
    select s.packet_id into p_old
      from public.items i join public.sections s on s.id = i.section_id
     where i.id = old.item_id;
  end if;
  if tg_op <> 'DELETE' then
    select s.packet_id into p_new
      from public.items i join public.sections s on s.id = i.section_id
     where i.id = new.item_id;
  end if;
  update public.packets set draft_rev = draft_rev + 1 where id in (p_old, p_new);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. TRIGGERS.
-- ---------------------------------------------------------------------------
create trigger trg_draft_rev_packet_self
  before update on public.packets
  for each row execute function public.draft_rev_packet_self();

create trigger trg_identity_rev_profile_self
  before update on public.professional_profiles
  for each row execute function public.identity_rev_profile_self();

create trigger trg_draft_rev_sections_insdel
  after insert or delete on public.sections
  for each row execute function public.draft_rev_by_packet();
create trigger trg_draft_rev_sections_upd
  after update on public.sections
  for each row
  when ((old.id, old.packet_id, old.title, old.description, old.sort_order)
        is distinct from
        (new.id, new.packet_id, new.title, new.description, new.sort_order))
  execute function public.draft_rev_by_packet();

create trigger trg_draft_rev_blocks_insdel
  after insert or delete on public.packet_blocks
  for each row execute function public.draft_rev_by_packet();
create trigger trg_draft_rev_blocks_upd
  after update on public.packet_blocks
  for each row
  when ((old.id, old.packet_id, old.position, old.block_type, old.item_id, old.heading_text, old.heading_subtext)
        is distinct from
        (new.id, new.packet_id, new.position, new.block_type, new.item_id, new.heading_text, new.heading_subtext))
  execute function public.draft_rev_by_packet();

create trigger trg_draft_rev_items_insdel
  after insert or delete on public.items
  for each row execute function public.draft_rev_by_section();
create trigger trg_draft_rev_items_upd
  after update on public.items
  for each row
  when ((old.id, old.section_id, old.title, old.address, old.description, old.highlight, old.sort_order)
        is distinct from
        (new.id, new.section_id, new.title, new.address, new.description, new.highlight, new.sort_order))
  execute function public.draft_rev_by_section();

create trigger trg_draft_rev_photos_insdel
  after insert or delete on public.item_photos
  for each row execute function public.draft_rev_by_item();
create trigger trg_draft_rev_photos_upd
  after update on public.item_photos
  for each row
  when ((old.item_id, old.url, old.sort_order) is distinct from (new.item_id, new.url, new.sort_order))
  execute function public.draft_rev_by_item();

create trigger trg_draft_rev_links_insdel
  after insert or delete on public.item_links
  for each row execute function public.draft_rev_by_item();
create trigger trg_draft_rev_links_upd
  after update on public.item_links
  for each row
  when ((old.item_id, old.url, old.label, old.sort_order) is distinct from (new.item_id, new.url, new.label, new.sort_order))
  execute function public.draft_rev_by_item();

create trigger trg_draft_rev_details_insdel
  after insert or delete on public.item_details
  for each row execute function public.draft_rev_by_item();
create trigger trg_draft_rev_details_upd
  after update on public.item_details
  for each row
  when ((old.item_id, old.label, old.value, old.sort_order) is distinct from (new.item_id, new.label, new.value, new.sort_order))
  execute function public.draft_rev_by_item();

create trigger trg_draft_rev_contacts_insdel
  after insert or delete on public.item_contacts
  for each row execute function public.draft_rev_by_item();
create trigger trg_draft_rev_contacts_upd
  after update on public.item_contacts
  for each row
  when ((old.item_id, old.name, old.role, old.phone, old.email, old.website, old.sort_order)
        is distinct from
        (new.item_id, new.name, new.role, new.phone, new.email, new.website, new.sort_order))
  execute function public.draft_rev_by_item();

revoke all on function public.draft_rev_packet_self()     from public, anon, authenticated, service_role;
revoke all on function public.identity_rev_profile_self() from public, anon, authenticated, service_role;
revoke all on function public.draft_rev_by_packet()       from public, anon, authenticated, service_role;
revoke all on function public.draft_rev_by_section()      from public, anon, authenticated, service_role;
revoke all on function public.draft_rev_by_item()         from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE PUBLICATION TABLE. One frozen copy per Sendset, or none.
--
-- ON DELETE CASCADE: deleting a Sendset deletes its published copy (the copy
-- holds the client's name and personal note; it must not outlive the Sendset).
-- Unpublish will delete the row too, in 0051.
--
-- source_identity_rev is the owner's identity_rev at publish when
-- identity_dependency = 'account_profile', and NULL otherwise. It is also NULL
-- for an 'account_profile' publication made when the owner had no profile row;
-- a comparison must use IS DISTINCT FROM, so a profile created later is a change.
-- ---------------------------------------------------------------------------
create table public.packet_publications (
  packet_id           uuid primary key references public.packets(id) on delete cascade,
  format_version      smallint    not null,
  content             jsonb       not null,
  source_draft_rev    bigint      not null,
  identity_dependency text        not null,
  source_identity_rev bigint,
  published_at        timestamptz not null default now(),
  constraint packet_publications_format_version_positive check (format_version >= 1),
  constraint packet_publications_source_draft_rev_nonneg check (source_draft_rev >= 0),
  constraint packet_publications_identity_dependency_known check (identity_dependency in ('account_profile', 'sendset')),
  constraint packet_publications_identity_rev_only_from_profile check (identity_dependency = 'account_profile' or source_identity_rev is null),
  constraint packet_publications_source_identity_rev_nonneg check (source_identity_rev is null or source_identity_rev >= 0),
  constraint packet_publications_content_is_object check (jsonb_typeof(content) = 'object'),
  constraint packet_publications_no_internal_title check (not (content ? 'title')),
  constraint packet_publications_no_private_notes check (not jsonb_path_exists(content, 'lax $.**.notes'))
);

comment on table public.packet_publications is
  'The frozen, recipient-safe copy of a published Sendset (0050). Written only by the publish RPC; read by the public renderers. Never edited in place — regenerated from the working rows on Republish. Deleted on unpublish and with its Sendset.';

alter table public.packet_publications enable row level security;

revoke all on public.packet_publications from public, anon, authenticated, service_role;
grant select on public.packet_publications to service_role;

-- ---------------------------------------------------------------------------
-- 6. CATALOG ASSERTIONS. A violation rolls the whole migration back.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  fn text;
  priv text;
  role_name text;
  n int;
begin
  -- Existing rows: counters at zero, and not one updated_at moved.
  if exists (select 1 from public.packets where draft_rev <> 0) then
    raise exception 'MIGRATION 0050 ABORTED: an existing packet does not start at draft_rev 0.';
  end if;
  if exists (select 1 from public.professional_profiles where identity_rev <> 0) then
    raise exception 'MIGRATION 0050 ABORTED: an existing profile does not start at identity_rev 0.';
  end if;
  select count(*) into n
    from _0050_before b
    left join public.packets p on b.kind = 'packet' and p.id = b.id
    left join public.professional_profiles f on b.kind = 'profile' and f.id = b.id
   where coalesce(p.updated_at, f.updated_at) is distinct from b.updated_at;
  if n <> 0 then
    raise exception 'MIGRATION 0050 ABORTED: % existing row(s) had updated_at changed.', n;
  end if;
  if (select count(*) from public.packet_publications) <> 0 then
    raise exception 'MIGRATION 0050 ABORTED: packet_publications is not empty.';
  end if;

  -- Trigger functions: definer, pinned search_path, and executable by NOBODY.
  -- A NULL proacl means the default ACL, which is EXECUTE to PUBLIC.
  foreach fn in array array['draft_rev_packet_self','identity_rev_profile_self',
                            'draft_rev_by_packet','draft_rev_by_section','draft_rev_by_item'] loop
    select p.prosecdef, p.proconfig, p.proacl, p.proowner into r
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = fn;
    if not found then raise exception 'MIGRATION 0050 ABORTED: function % missing.', fn; end if;
    if not r.prosecdef then raise exception 'MIGRATION 0050 ABORTED: % is not SECURITY DEFINER.', fn; end if;
    if r.proconfig is null or not ('search_path=""' = any(r.proconfig)) then
      raise exception 'MIGRATION 0050 ABORTED: % does not pin search_path.', fn;
    end if;
    if r.proacl is null then
      raise exception 'MIGRATION 0050 ABORTED: % has the default ACL (EXECUTE to PUBLIC).', fn;
    end if;
    if exists (select 1 from aclexplode(r.proacl) a where a.grantee <> r.proowner) then
      raise exception 'MIGRATION 0050 ABORTED: % is executable by a role other than its owner.', fn;
    end if;
  end loop;

  -- Exactly the 16 triggers, each enabled, each on the table it names.
  select count(*) into n
    from pg_trigger t
   where not t.tgisinternal and t.tgenabled = 'O'
     and (t.tgrelid::regclass::text, t.tgname) in (
       ('packets','trg_draft_rev_packet_self'),
       ('professional_profiles','trg_identity_rev_profile_self'),
       ('sections','trg_draft_rev_sections_insdel'),   ('sections','trg_draft_rev_sections_upd'),
       ('packet_blocks','trg_draft_rev_blocks_insdel'), ('packet_blocks','trg_draft_rev_blocks_upd'),
       ('items','trg_draft_rev_items_insdel'),         ('items','trg_draft_rev_items_upd'),
       ('item_photos','trg_draft_rev_photos_insdel'),  ('item_photos','trg_draft_rev_photos_upd'),
       ('item_links','trg_draft_rev_links_insdel'),    ('item_links','trg_draft_rev_links_upd'),
       ('item_details','trg_draft_rev_details_insdel'),('item_details','trg_draft_rev_details_upd'),
       ('item_contacts','trg_draft_rev_contacts_insdel'),('item_contacts','trg_draft_rev_contacts_upd'));
  if n <> 16 then
    raise exception 'MIGRATION 0050 ABORTED: expected 16 enabled draft-revision triggers, found %.', n;
  end if;

  -- The publication table: RLS on, no policies, cascade from packets.
  if not (select relrowsecurity from pg_class where oid = 'public.packet_publications'::regclass) then
    raise exception 'MIGRATION 0050 ABORTED: RLS is not enabled on packet_publications.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'packet_publications') then
    raise exception 'MIGRATION 0050 ABORTED: packet_publications has a policy.';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.packet_publications'::regclass and contype = 'f'
                    and confrelid = 'public.packets'::regclass and confdeltype = 'c') then
    raise exception 'MIGRATION 0050 ABORTED: packet_publications.packet_id does not cascade from packets.';
  end if;

  -- Privileges, ONE role and ONE privilege per call (a comma list means ANY).
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach priv in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege(role_name, 'public.packet_publications', priv) then
        raise exception 'MIGRATION 0050 ABORTED: % holds % on packet_publications.', role_name, priv;
      end if;
    end loop;
  end loop;
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name, 'public.packet_publications', 'SELECT') then
      raise exception 'MIGRATION 0050 ABORTED: % can SELECT packet_publications.', role_name;
    end if;
  end loop;
  -- Positive control: the check above can say yes, or its "no" means nothing.
  if not has_table_privilege('service_role', 'public.packet_publications', 'SELECT') then
    raise exception 'MIGRATION 0050 ABORTED: service_role cannot SELECT packet_publications (control failed).';
  end if;

  raise notice '0050 catalog: counters at 0, updated_at untouched, 5 locked trigger functions, 16 triggers, publication table RLS-on / policy-free / cascade / select-only to service_role.';
end $$;

-- ---------------------------------------------------------------------------
-- 7. BEHAVIOURAL PROOF on throwaway rows, thrown away with ROLLBACK TO
--    SAVEPOINT. Every counted mutation must move the revision; every ignored
--    one must not. Each step first proves its write took effect.
-- ---------------------------------------------------------------------------
savepoint draft_rev_probe;

do $$
declare
  u uuid; pk uuid; pk2 uuid; pkc uuid; sec uuid; sec2 uuid; it uuid; it2 uuid; ph uuid; blk uuid;
  r0 bigint; r1 bigint; q0 bigint; q1 bigint; i0 bigint; i1 bigint;
  probe_email text := 'migration-0050-probe-' || gen_random_uuid() || '@invalid.example';
begin
  insert into public.users (email) values (probe_email) returning id into u;
  insert into public.professional_profiles (user_id, name) values (u, 'Probe') ;
  insert into public.packets (user_id, slug, title) values (u, 'mig0050probe' || substr(md5(random()::text), 1, 12), 'probe')
    returning id into pk;
  insert into public.packets (user_id, slug, title) values (u, 'mig0050probe' || substr(md5(random()::text), 1, 12), 'probe 2')
    returning id into pk2;

  -- ---- COUNTED --------------------------------------------------------------
  r0 := (select draft_rev from public.packets where id = pk);
  insert into public.sections (packet_id, title, sort_order) values (pk, 'S', 0) returning id into sec;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: section insert did not move draft_rev'; end if;

  r0 := r1; update public.sections set title = 'S2' where id = sec;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: section title did not move draft_rev'; end if;

  insert into public.sections (packet_id, title, sort_order) values (pk, 'T', 1) returning id into sec2;
  r0 := (select draft_rev from public.packets where id = pk);
  insert into public.items (section_id, title, sort_order) values (sec, 'I', 0) returning id into it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: item insert did not move draft_rev'; end if;

  r0 := r1; update public.items set highlight = 'Best' where id = it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: item highlight did not move draft_rev'; end if;

  r0 := r1; update public.items set section_id = sec2 where id = it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: item move between sections did not move draft_rev'; end if;

  r0 := r1; insert into public.item_photos (item_id, url) values (it, 'https://probe.invalid/a.jpg') returning id into ph;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: photo insert did not move draft_rev'; end if;

  r0 := r1; update public.item_photos set sort_order = 3 where id = ph;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: photo reorder did not move draft_rev'; end if;

  r0 := r1; insert into public.item_links (item_id, url) values (it, 'https://probe.invalid');
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: link insert did not move draft_rev'; end if;

  r0 := r1; insert into public.item_details (item_id, label, value) values (it, 'L', 'V');
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: detail insert did not move draft_rev'; end if;

  r0 := r1; update public.item_details set value = 'V2' where item_id = it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: detail value did not move draft_rev'; end if;

  r0 := r1; insert into public.item_contacts (item_id, name) values (it, 'C');
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: contact insert did not move draft_rev'; end if;

  r0 := r1; update public.item_contacts set phone = '555-0100' where item_id = it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: contact phone did not move draft_rev'; end if;

  r0 := r1; delete from public.item_links where item_id = it;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: link delete did not move draft_rev'; end if;

  r0 := r1; update public.packets set client_title = 'For you' where id = pk;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <> r0 + 1 then raise exception '0050 PROOF: client_title moved draft_rev by %, expected 1', r1 - r0; end if;

  r0 := r1; update public.packets set show_quick_nav = false where id = pk;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: show_quick_nav did not move draft_rev'; end if;

  r0 := r1; update public.packets set style_treatment = 'warm' where id = pk;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: style_treatment did not move draft_rev'; end if;

  r0 := r1; update public.packets set identity_mode = 'none' where id = pk;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <= r0 then raise exception '0050 PROOF: identity_mode did not move draft_rev'; end if;

  -- A photo moved to another Sendset's item moves BOTH Sendsets.
  insert into public.sections (packet_id, title) values (pk2, 'X') returning id into sec;
  insert into public.items (section_id, title) values (sec, 'Y') returning id into it2;
  r0 := (select draft_rev from public.packets where id = pk);
  q0 := (select draft_rev from public.packets where id = pk2);
  update public.item_photos set item_id = it2 where id = ph;
  r1 := (select draft_rev from public.packets where id = pk);
  q1 := (select draft_rev from public.packets where id = pk2);
  if r1 <= r0 or q1 <= q0 then
    raise exception '0050 PROOF: a cross-Sendset photo move did not move both revisions (% -> %, % -> %)', r0, r1, q0, q1;
  end if;

  -- Block composition: conversion, and a heading's text.
  insert into public.packets (user_id, slug, title) values (u, 'mig0050probe' || substr(md5(random()::text), 1, 12), 'probe 3')
    returning id into pk2;
  insert into public.sections (packet_id, title) values (pk2, 'B') returning id into sec;
  insert into public.items (section_id, title) values (sec, 'Z');
  q0 := (select draft_rev from public.packets where id = pk2);
  perform public.convert_packet_to_blocks(pk2);
  q1 := (select draft_rev from public.packets where id = pk2);
  if q1 <= q0 then raise exception '0050 PROOF: converting to blocks did not move draft_rev'; end if;
  insert into public.packet_blocks (packet_id, position, block_type, heading_text)
    values (pk2, (select count(*) from public.packet_blocks where packet_id = pk2), 'heading', 'H')
    returning id into blk;
  q0 := (select draft_rev from public.packets where id = pk2);
  update public.packet_blocks set heading_text = 'H2' where id = blk;
  q1 := (select draft_rev from public.packets where id = pk2);
  if q1 <= q0 then raise exception '0050 PROOF: heading text did not move draft_rev'; end if;
  update public.packet_blocks set updated_at = now() where id = blk;
  if (select draft_rev from public.packets where id = pk2) <> q1 then
    raise exception '0050 PROOF: a block updated_at-only write moved draft_rev';
  end if;

  i0 := (select identity_rev from public.professional_profiles where user_id = u);
  update public.professional_profiles set phone = '555-0101' where user_id = u;
  i1 := (select identity_rev from public.professional_profiles where user_id = u);
  if i1 <> i0 + 1 then raise exception '0050 PROOF: profile phone moved identity_rev by %, expected 1', i1 - i0; end if;

  -- ---- NOT COUNTED ---------------------------------------------------------
  r0 := (select draft_rev from public.packets where id = pk);
  update public.items set notes = 'private' where id = it;
  if (select notes from public.items where id = it) <> 'private' then raise exception '0050 PROOF: notes probe write did not take'; end if;
  update public.items set title = title, sort_order = sort_order where id = it;           -- a no-op save
  -- status/published_at are not in the tuple either; they are left out of the
  -- probe only because ownership-route.test forbids any migration from
  -- assigning status = 'published'.
  update public.packets set viewed = true, title = 'renamed internally', raw_input = 'x',
                            professional_snapshot = '{"name":"x"}' where id = pk;
  if (select title from public.packets where id = pk) <> 'renamed internally' then raise exception '0050 PROOF: packet probe write did not take'; end if;
  update public.item_photos set storage_path = 'ignored' where id = ph;
  r1 := (select draft_rev from public.packets where id = pk);
  if r1 <> r0 then
    raise exception '0050 PROOF: a non-content write moved draft_rev % -> %', r0, r1;
  end if;

  i0 := (select identity_rev from public.professional_profiles where user_id = u);
  update public.professional_profiles set updated_at = now() where user_id = u;
  if (select identity_rev from public.professional_profiles where user_id = u) <> i0 then
    raise exception '0050 PROOF: a non-identity profile write moved identity_rev';
  end if;

  -- ---- REFUSED -------------------------------------------------------------
  begin
    update public.packets set draft_rev = 0 where id = pk;
    raise exception '0050 PROOF: draft_rev was allowed to decrease';
  exception when raise_exception then
    if sqlerrm not like 'packets.draft_rev may not decrease%' then raise; end if;
  end;

  begin
    insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency)
      values (pk, 1, '{"sections":[{"items":[{"notes":"leak"}]}]}', 1, 'sendset');
    raise exception '0050 PROOF: a snapshot carrying a private note was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency)
      values (pk, 1, '{"title":"internal"}', 1, 'sendset');
    raise exception '0050 PROOF: a snapshot carrying the internal title was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency, source_identity_rev)
      values (pk, 1, '{"sections":[]}', 1, 'sendset', 0);
    raise exception '0050 PROOF: a Sendset-only publication was allowed to record an identity revision';
  exception when check_violation then null;
  end;
  begin
    insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency)
      values (pk, 1, '{"sections":[]}', 1, 'profile');
    raise exception '0050 PROOF: an unknown identity_dependency was accepted';
  exception when check_violation then null;
  end;

  -- ---- IDENTITY REVISION vs. THE SENDSET'S OWN REVISION ----------------------
  -- A profile edit moves identity_rev and no packet's draft_rev (no fan-out, so
  -- no updated_at re-stamp); a custom identity edit moves draft_rev only.
  insert into public.packets (user_id, slug, title, identity_mode, custom_identity)
    values (u, 'mig0050probe' || substr(md5(random()::text), 1, 12), 'custom id', 'custom', '{"name":"Custom","phone":"555-0102"}')
    returning id into pkc;
  r0 := (select draft_rev from public.packets where id = pkc);
  i0 := (select identity_rev from public.professional_profiles where user_id = u);
  update public.professional_profiles set name = 'Probe Renamed' where user_id = u;
  if (select identity_rev from public.professional_profiles where user_id = u) <= i0 then
    raise exception '0050 PROOF: a profile name edit did not move identity_rev';
  end if;
  if (select draft_rev from public.packets where id = pkc) <> r0 then
    raise exception '0050 PROOF: a profile edit moved a Sendset''s draft_rev';
  end if;
  i0 := (select identity_rev from public.professional_profiles where user_id = u);
  update public.packets set custom_identity = '{"name":"Custom 2","phone":"555-0102"}' where id = pkc;
  if (select draft_rev from public.packets where id = pkc) <= r0 then
    raise exception '0050 PROOF: a custom identity edit did not move draft_rev';
  end if;
  if (select identity_rev from public.professional_profiles where user_id = u) <> i0 then
    raise exception '0050 PROOF: a custom identity edit moved identity_rev';
  end if;

  insert into public.packet_publications (packet_id, format_version, content, source_draft_rev, identity_dependency)
    select pk, 1, '{"sections":[]}', draft_rev, 'sendset' from public.packets where id = pk;

  -- ---- CASCADE -------------------------------------------------------------
  delete from public.packets where id = pk;
  if exists (select 1 from public.packet_publications where packet_id = pk) then
    raise exception '0050 PROOF: deleting a Sendset left its publication behind';
  end if;

  raise notice '0050 proof: every counted mutation moved the revision, every ignored one did not, decreases and unsafe snapshots were refused, profile and Sendset identity revisions stayed separate, delete cascaded.';
end $$;

rollback to savepoint draft_rev_probe;
release savepoint draft_rev_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0050-probe-%@invalid.example') then
    raise exception 'MIGRATION 0050 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
