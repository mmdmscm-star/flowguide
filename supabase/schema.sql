-- FlowGuide V1 Database Schema
-- Run this in the Supabase SQL Editor to set up all tables.

-- ============================================================
-- USERS
-- ============================================================
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- SESSIONS
-- ============================================================
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_sessions_token on public.sessions(token);

-- ============================================================
-- MAGIC LINKS
-- ============================================================
create table public.magic_links (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token text unique not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_magic_links_token on public.magic_links(token);

-- ============================================================
-- PROFESSIONAL PROFILES
-- ============================================================
create table public.professional_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references public.users(id) on delete cascade,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  business_name text not null default '',
  logo_url text not null default '',
  headshot_url text not null default '',
  footer_label text not null default 'Your Advisor',
  website_url text not null default '',
  links jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- PACKETS
-- ============================================================
create table public.packets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  slug text unique not null,
  title text not null default '',
  client_name text not null default '',
  personal_note text not null default '',
  packet_type text not null default 'general',
  map_url text not null default '',
  raw_input text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published')),
  viewed boolean not null default false,
  professional_snapshot jsonb,
  identity_mode text not null default 'default' check (identity_mode in ('default', 'none', 'custom')),
  custom_identity jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_packets_slug on public.packets(slug);
create index idx_packets_user_id on public.packets(user_id);

-- ============================================================
-- SECTIONS
-- ============================================================
create table public.sections (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references public.packets(id) on delete cascade,
  title text not null default '',
  description text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sections_packet_id on public.sections(packet_id);

-- ============================================================
-- ITEMS
-- ============================================================
create table public.items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.sections(id) on delete cascade,
  title text not null default '',
  address text not null default '',
  description text not null default '',
  notes text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_items_section_id on public.items(section_id);

-- ============================================================
-- ITEM PHOTOS
-- ============================================================
create table public.item_photos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  storage_path text not null default '',
  url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_item_photos_item_id on public.item_photos(item_id);

-- ============================================================
-- ITEM LINKS
-- ============================================================
create table public.item_links (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  url text not null,
  label text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_item_links_item_id on public.item_links(item_id);

-- ============================================================
-- ITEM DETAILS (key-value pairs)
-- ============================================================
create table public.item_details (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  label text not null default '',
  value text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_item_details_item_id on public.item_details(item_id);

-- ============================================================
-- ITEM CONTACTS
-- ============================================================
create table public.item_contacts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  name text not null default '',
  role text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_item_contacts_item_id on public.item_contacts(item_id);
create index idx_item_contacts_item_sort on public.item_contacts(item_id, sort_order);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on all tables
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.magic_links enable row level security;
alter table public.professional_profiles enable row level security;
alter table public.packets enable row level security;
alter table public.sections enable row level security;
alter table public.items enable row level security;
alter table public.item_photos enable row level security;
alter table public.item_links enable row level security;
alter table public.item_details enable row level security;
alter table public.item_contacts enable row level security;

-- For V1, we use the service role key server-side, so we need
-- policies that allow the service role to do everything.
-- Recipient packet views are public reads filtered by status.
-- All creator operations go through server-side API routes
-- that verify the session before querying.

-- Public read access for published packets (recipient view)
create policy "Public can view published packets"
  on public.packets for select
  using (status = 'published');

create policy "Public can view sections of published packets"
  on public.sections for select
  using (
    exists (
      select 1 from public.packets
      where packets.id = sections.packet_id
      and packets.status = 'published'
    )
  );

create policy "Public can view items of published packets"
  on public.items for select
  using (
    exists (
      select 1 from public.sections
      join public.packets on packets.id = sections.packet_id
      where sections.id = items.section_id
      and packets.status = 'published'
    )
  );

create policy "Public can view photos of published packets"
  on public.item_photos for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_photos.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view links of published packets"
  on public.item_links for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_links.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view details of published packets"
  on public.item_details for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_details.item_id
      and packets.status = 'published'
    )
  );

create policy "Public can view contacts of published packets"
  on public.item_contacts for select
  using (
    exists (
      select 1 from public.items
      join public.sections on sections.id = items.section_id
      join public.packets on packets.id = sections.packet_id
      where items.id = item_contacts.item_id
      and packets.status = 'published'
    )
  );

-- Public can update the viewed flag on published packets
create policy "Public can mark packets as viewed"
  on public.packets for update
  using (status = 'published')
  with check (status = 'published');

-- Service role bypasses RLS, so all creator operations
-- (via API routes using the service role key) work without
-- additional policies. When we add JWT-based auth later,
-- we'll add user-scoped policies.

-- ============================================================
-- STORAGE BUCKET
-- ============================================================
-- Run this separately if needed:
-- insert into storage.buckets (id, name, public)
-- values ('packet-photos', 'packet-photos', true);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_packets_updated_at
  before update on public.packets
  for each row execute function public.update_updated_at();

create trigger update_sections_updated_at
  before update on public.sections
  for each row execute function public.update_updated_at();

create trigger update_items_updated_at
  before update on public.items
  for each row execute function public.update_updated_at();

create trigger update_professional_profiles_updated_at
  before update on public.professional_profiles
  for each row execute function public.update_updated_at();

-- ============================================================
-- ADD ITEMS TO AN EXISTING SECTION — TRANSACTIONAL APPEND
-- Mirrors migrations/0006_insert_items_into_section.sql (schema documentation
-- parity). Appends AI-structured items into an existing section in one
-- transaction: validates the section belongs to the packet, computes sort_order
-- internally, appends the source text to raw_input, all-or-nothing. SECURITY
-- INVOKER, fixed empty search_path; EXECUTE revoked from public/anon/
-- authenticated and granted only to service_role.
-- ============================================================
create or replace function public.insert_items_into_section(
  p_packet_id uuid,
  p_section_id uuid,
  p_items jsonb,
  p_raw_append text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_packet_id uuid;
  v_base int;
  it jsonb;
  d jsonb;
  l jsonb;
  ph text;
  c jsonb;
  ii int := 0;
  di int;
  li int;
  pi int;
  ci int;
  new_item_id uuid;
begin
  -- Validate + lock the target section (also serializes concurrent adds).
  select packet_id into v_packet_id
    from public.sections
    where id = p_section_id
    for update;

  if v_packet_id is null then
    raise exception 'section % not found', p_section_id;
  end if;
  if v_packet_id <> p_packet_id then
    raise exception 'section % does not belong to packet %', p_section_id, p_packet_id;
  end if;

  -- Next sort_order within this section, computed inside the transaction.
  select coalesce(max(sort_order), -1) + 1 into v_base
    from public.items
    where section_id = p_section_id;

  for it in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.items (section_id, title, address, description, notes, sort_order)
    values (
      p_section_id,
      coalesce(nullif(it->>'title', ''), 'Item ' || (ii + 1)),
      coalesce(it->>'address', ''),
      coalesce(it->>'description', ''),
      coalesce(it->>'notes', ''),
      v_base + ii
    )
    returning id into new_item_id;

    di := 0;
    for d in select value from jsonb_array_elements(coalesce(it->'details', '[]'::jsonb))
    loop
      insert into public.item_details (item_id, label, value, sort_order)
      values (new_item_id, coalesce(d->>'label', ''), coalesce(d->>'value', ''), di);
      di := di + 1;
    end loop;

    li := 0;
    for l in select value from jsonb_array_elements(coalesce(it->'links', '[]'::jsonb))
    loop
      if coalesce(l->>'url', '') like 'http%' then
        insert into public.item_links (item_id, url, label, sort_order)
        values (new_item_id, l->>'url', coalesce(l->>'label', ''), li);
        li := li + 1;
      end if;
    end loop;

    pi := 0;
    for ph in select value from jsonb_array_elements_text(coalesce(it->'photos', '[]'::jsonb))
    loop
      if ph like 'http%' then
        insert into public.item_photos (item_id, url, storage_path, sort_order)
        values (new_item_id, ph, '', pi);
        pi := pi + 1;
      end if;
    end loop;

    -- Ordered contacts: prefer `contacts` array; fall back to a legacy singular
    -- `contact` object. Every supplied person is preserved; blanks are skipped.
    ci := 0;
    for c in select value from jsonb_array_elements(
      coalesce(
        it->'contacts',
        case when jsonb_typeof(it->'contact') = 'object' then jsonb_build_array(it->'contact') else '[]'::jsonb end
      )
    )
    loop
      if jsonb_typeof(c) = 'object' and (
        coalesce(c->>'name', '') <> '' or
        coalesce(c->>'phone', '') <> '' or
        coalesce(c->>'email', '') <> '' or
        coalesce(c->>'website', '') <> ''
      ) then
        insert into public.item_contacts (item_id, name, role, phone, email, website, sort_order)
        values (
          new_item_id,
          coalesce(c->>'name', ''),
          coalesce(c->>'role', ''),
          coalesce(c->>'phone', ''),
          coalesce(c->>'email', ''),
          coalesce(c->>'website', ''),
          ci
        );
        ci := ci + 1;
      end if;
    end loop;

    ii := ii + 1;
  end loop;

  -- Append to Original Input in the same transaction; coalesce guards NULL.
  update public.packets
    set raw_input = coalesce(raw_input, '') || p_raw_append
    where id = p_packet_id;
end;
$$;

revoke execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) to service_role;

-- ============================================================
-- R1A — ORDERED-BLOCK COMPOSITION SUBSTRATE
-- Mirrors migrations/0007_packet_blocks_r1a.sql (schema documentation parity).
-- Additive and inert: every existing packet stays composition_mode='legacy'.
-- ============================================================
-- ------------------------------------------------------------
-- 1. Composition mode on packets (default legacy; opt-in per packet).
-- ------------------------------------------------------------
alter table public.packets
  add column composition_mode text not null default 'legacy'
    check (composition_mode in ('legacy', 'blocks'));

-- ------------------------------------------------------------
-- 2. packet_blocks — one ordered sequence of independent blocks per packet.
--    Heading/Subheading/Label are visual-only; Item blocks reference an existing
--    item row (content is never duplicated). Positions are >= 0, unique, dense.
--    Label blocks carry no subtext (settled prototype behavior).
-- ------------------------------------------------------------
create table public.packet_blocks (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references public.packets(id) on delete cascade,
  position int not null,
  block_type text not null check (block_type in ('heading', 'subheading', 'label', 'item')),
  item_id uuid references public.items(id) on delete cascade,
  heading_text text,
  heading_subtext text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_blocks_position_nonneg check (position >= 0),
  constraint packet_blocks_shape check (
    (block_type = 'item'
       and item_id is not null
       and heading_text is null
       and heading_subtext is null)
    or
    (block_type in ('heading', 'subheading')
       and item_id is null
       and heading_text is not null
       and btrim(heading_text) <> '')
    or
    (block_type = 'label'
       and item_id is null
       and heading_text is not null
       and btrim(heading_text) <> ''
       and heading_subtext is null)
  ),
  constraint packet_blocks_position_unique unique (packet_id, position)
    deferrable initially deferred
);

create unique index packet_blocks_one_item_per_packet
  on public.packet_blocks (packet_id, item_id)
  where block_type = 'item';

create index idx_packet_blocks_packet_position
  on public.packet_blocks (packet_id, position);

create trigger update_packet_blocks_updated_at
  before update on public.packet_blocks
  for each row execute function public.update_updated_at();

-- ------------------------------------------------------------
-- 3. RLS — public may SELECT blocks of PUBLISHED packets (mirrors item policies).
--    All writes go through the SECURITY DEFINER RPCs below, never directly.
-- ------------------------------------------------------------
alter table public.packet_blocks enable row level security;

create policy "Public can view blocks of published packets"
  on public.packet_blocks for select
  using (
    exists (
      select 1 from public.packets
      where packets.id = packet_blocks.packet_id
        and packets.status = 'published'
    )
  );

-- ------------------------------------------------------------
-- 4. Table privileges — start from nothing (defeat Supabase default grants),
--    then grant ONLY RLS-gated SELECT. INSERT/UPDATE/DELETE stay revoked for
--    every API role, including service_role.
-- ------------------------------------------------------------
revoke all on public.packet_blocks from public, anon, authenticated, service_role;
grant select on public.packet_blocks to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Locking helper — lock the given packet rows FOR KEY SHARE in deterministic
--    ascending id order (dedup, skip nulls) and report whether any is in block
--    mode. FOR KEY SHARE waits behind a conversion's FOR UPDATE (so a structural
--    write blocks until conversion commits and then observes the FINAL mode),
--    yet does NOT conflict with ordinary FOR NO KEY UPDATE packet updates — e.g.
--    the legacy insert_items_into_section RPC, which inserts item rows (this
--    trigger) and then updates non-key packet content (raw_input). Using FOR
--    SHARE here would deadlock two concurrent such appends. A missing packet row
--    (mid-cascade teardown) contributes nothing -> allowed.
-- ------------------------------------------------------------
create or replace function public.packets_in_block_mode(p_ids uuid[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_mode text;
  v_blocks boolean := false;
begin
  for v_id in
    select distinct x from unnest(p_ids) as t(x) where x is not null order by x
  loop
    v_mode := null;
    select composition_mode into v_mode from public.packets where id = v_id for key share;
    if v_mode = 'blocks' then
      v_blocks := true;
    end if;
  end loop;
  return v_blocks;
end;
$$;

-- ------------------------------------------------------------
-- 6. Cross-packet item-ownership guard — immediate, non-deferrable.
--    Rejects any item block whose item belongs to a different packet, on both
--    INSERT and UPDATE, regardless of writer.
-- ------------------------------------------------------------
create or replace function public.assert_block_item_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.block_type = 'item' then
    select s.packet_id into v_owner
      from public.items i
      join public.sections s on s.id = i.section_id
      where i.id = new.item_id;
    if v_owner is null then
      raise exception 'packet_blocks: item % not found', new.item_id;
    end if;
    if v_owner <> new.packet_id then
      raise exception 'packet_blocks: item % belongs to packet %, not %', new.item_id, v_owner, new.packet_id;
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger trg_block_item_ownership
  after insert or update on public.packet_blocks
  not deferrable
  for each row
  execute function public.assert_block_item_ownership();

-- ------------------------------------------------------------
-- 7. Complete structural freeze of SECTIONS while their packet is in block mode:
--    reject INSERT, DELETE, and every UPDATE (title/description included).
--    UPDATE checks BOTH old and new packet ownership (covers a packet_id change),
--    locking both in deterministic order. Cascade-safe (packet gone -> allowed).
-- ------------------------------------------------------------
create or replace function public.freeze_sections_in_block_mode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.packets_in_block_mode(array[new.packet_id]) then
      raise exception 'sections are frozen: cannot INSERT a section into a block-mode packet';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if public.packets_in_block_mode(array[old.packet_id]) then
      raise exception 'sections are frozen: cannot DELETE a section of a block-mode packet';
    end if;
    return old;
  else -- UPDATE (any column, including title/description; also a packet_id change)
    if public.packets_in_block_mode(array[old.packet_id, new.packet_id]) then
      raise exception 'sections are frozen: cannot UPDATE a section of a block-mode packet';
    end if;
    return new;
  end if;
end;
$$;

create trigger trg_freeze_sections
  before insert or update or delete on public.sections
  for each row execute function public.freeze_sections_in_block_mode();

-- ------------------------------------------------------------
-- 8. Legacy ITEM freeze while their packet is in block mode: reject INSERT,
--    DELETE, section_id changes and sort_order changes. Ordinary CONTENT edits
--    (title/address/description/notes) remain allowed. A section_id change is
--    structural and checks BOTH the source and destination packets. Cascade-safe.
-- ------------------------------------------------------------
create or replace function public.freeze_items_in_block_mode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src uuid;
  v_dst uuid;
begin
  if tg_op = 'INSERT' then
    select s.packet_id into v_dst from public.sections s where s.id = new.section_id;
    if public.packets_in_block_mode(array[v_dst]) then
      raise exception 'items are frozen: cannot INSERT an item into a block-mode packet';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select s.packet_id into v_src from public.sections s where s.id = old.section_id;
    if public.packets_in_block_mode(array[v_src]) then
      raise exception 'items are frozen: cannot DELETE an item of a block-mode packet';
    end if;
    return old;
  else -- UPDATE
    if new.section_id is distinct from old.section_id then
      select s.packet_id into v_src from public.sections s where s.id = old.section_id;
      select s.packet_id into v_dst from public.sections s where s.id = new.section_id;
      if public.packets_in_block_mode(array[v_src, v_dst]) then
        raise exception 'items are frozen: section_id cannot change for a block-mode packet';
      end if;
    elsif new.sort_order is distinct from old.sort_order then
      select s.packet_id into v_src from public.sections s where s.id = old.section_id;
      if public.packets_in_block_mode(array[v_src]) then
        raise exception 'items are frozen: sort_order cannot change for a block-mode packet';
      end if;
    end if;
    -- content-only edits (title/address/description/notes) are allowed
    return new;
  end if;
end;
$$;

create trigger trg_freeze_items
  before insert or update or delete on public.items
  for each row execute function public.freeze_items_in_block_mode();

-- ------------------------------------------------------------
-- 9. Consistency assertion — bijection between a block-mode packet's items and
--    its item blocks, plus positions EXACTLY {0 .. n-1} (dense), including the
--    zero-block case (empty is vacuously dense). Raises on any violation.
-- ------------------------------------------------------------
create or replace function public.assert_packet_block_consistency(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_blocks int;
  v_items int;
  v_count int;
  v_min int;
  v_max int;
begin
  select count(*) into v_item_blocks
    from public.packet_blocks where packet_id = p_packet_id and block_type = 'item';
  select count(*) into v_items
    from public.items i join public.sections s on s.id = i.section_id
    where s.packet_id = p_packet_id;
  if v_item_blocks <> v_items then
    raise exception 'consistency: packet % has % items but % item blocks', p_packet_id, v_items, v_item_blocks;
  end if;

  -- every packet item is referenced by a block (with equal counts + the
  -- one-item-per-packet unique index, this is a bijection)
  if exists (
    select 1 from public.items i join public.sections s on s.id = i.section_id
    where s.packet_id = p_packet_id
      and not exists (
        select 1 from public.packet_blocks b
        where b.packet_id = p_packet_id and b.block_type = 'item' and b.item_id = i.id
      )
  ) then
    raise exception 'consistency: packet % has an item with no block', p_packet_id;
  end if;

  -- positions must be EXACTLY {0 .. n-1}. With CHECK(position>=0) and
  -- UNIQUE(packet_id,position), min=0 and max=n-1 imply exactly 0..n-1.
  select count(*), min(position), max(position)
    into v_count, v_min, v_max
    from public.packet_blocks where packet_id = p_packet_id;
  if v_count = 0 then
    return; -- no blocks: vacuously dense
  end if;
  if v_min <> 0 or v_max <> v_count - 1 then
    raise exception 'consistency: packet % positions not dense 0..% (min %, max %, count %)',
      p_packet_id, v_count - 1, v_min, v_max, v_count;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 10. Composition-mode transition guard (DB-level; applies to ANY writer).
--     - new packets must be created in legacy mode;
--     - a mode change is REJECTED unless it is authorized by the controlled RPC
--       for THIS packet (see the transaction-local GUC below), so a direct
--       service-role UPDATE of composition_mode always fails, even if the rows
--       happen to look consistent;
--     - legacy -> blocks only for a draft packet with a complete, consistent
--       block representation;
--     - blocks -> legacy only for a draft packet after block rows are removed;
--     - any other transition/value is rejected.
--     Ordinary legacy edits (no mode change) never invoke this (WHEN clauses).
--
--     RPC-only authorization: convert/revert call set_config(
--       'app.block_transition_authorized_packet', <packet id>, is_local => true)
--     immediately before their mode UPDATE and clear it immediately after.
--     is_local scopes it to the current transaction. Ordinary application writes
--     go through PostgREST as a single `UPDATE packets ...` statement in their
--     own transaction with no preceding set_config, so the GUC is unset (null)
--     and the transition is rejected. Only a SECURITY DEFINER function that
--     explicitly sets the GUC can authorize the flip — normal table updates
--     cannot reproduce it.
-- ------------------------------------------------------------
create or replace function public.enforce_packet_mode_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block_count int;
begin
  if tg_op = 'INSERT' then
    -- WHEN clause guarantees new.composition_mode <> 'legacy'
    raise exception 'packets must be created in legacy mode (got %)', new.composition_mode;
  end if;

  -- UPDATE with an actual mode change (guaranteed by WHEN clause).
  -- Reject unless the controlled RPC authorized a transition for THIS packet.
  if current_setting('app.block_transition_authorized_packet', true) is distinct from new.id::text then
    raise exception 'composition_mode may only be changed via convert_packet_to_blocks / revert_packet_to_legacy';
  end if;

  if old.composition_mode = 'legacy' and new.composition_mode = 'blocks' then
    if new.status <> 'draft' then
      raise exception 'composition_mode legacy->blocks requires a draft packet (status=%)', new.status;
    end if;
    perform public.assert_packet_block_consistency(new.id);
  elsif old.composition_mode = 'blocks' and new.composition_mode = 'legacy' then
    if new.status <> 'draft' then
      raise exception 'composition_mode blocks->legacy requires a draft packet (status=%)', new.status;
    end if;
    select count(*) into v_block_count from public.packet_blocks where packet_id = new.id;
    if v_block_count <> 0 then
      raise exception 'composition_mode blocks->legacy requires block rows removed first (found %)', v_block_count;
    end if;
  else
    raise exception 'invalid composition_mode transition % -> %', old.composition_mode, new.composition_mode;
  end if;
  return null;
end;
$$;

create constraint trigger trg_packet_mode_insert
  after insert on public.packets
  not deferrable
  for each row
  when (new.composition_mode <> 'legacy')
  execute function public.enforce_packet_mode_transition();

create constraint trigger trg_packet_mode_update
  after update on public.packets
  not deferrable
  for each row
  when (old.composition_mode is distinct from new.composition_mode)
  execute function public.enforce_packet_mode_transition();

-- ------------------------------------------------------------
-- 11. Block-publish consistency gate (R1C-B). A block-mode packet may transition
--     INTO 'published' only when its block composition is valid and consistent:
--     assert_packet_block_consistency passes, there is at least one item block,
--     and every referenced item has a nonblank title. Replaces the temporary
--     R1A draft-only rule. Legacy publishing is unaffected (gated on
--     composition_mode='blocks'). See migration 0008 for full design notes.
-- ------------------------------------------------------------
create or replace function public.enforce_block_publish_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_blocks int;
begin
  -- WHEN clause guarantees: new.composition_mode='blocks', new.status='published',
  -- and this UPDATE is the transition INTO published.

  -- (a) bijection + dense positions
  perform public.assert_packet_block_consistency(new.id);

  -- (b) at least one item block
  select count(*) into v_item_blocks
    from public.packet_blocks
    where packet_id = new.id and block_type = 'item';
  if v_item_blocks = 0 then
    raise exception 'block publish: packet % has no item blocks; add at least one item before publishing', new.id;
  end if;

  -- (c) every referenced item has a nonblank title
  if exists (
    select 1
    from public.packet_blocks b
    join public.items i on i.id = b.item_id
    where b.packet_id = new.id
      and b.block_type = 'item'
      and btrim(coalesce(i.title, '')) = ''
  ) then
    raise exception 'block publish: packet % has an item block whose item has a blank title', new.id;
  end if;

  return null;
end;
$$;

create constraint trigger trg_block_publish_consistency
  after update on public.packets
  not deferrable
  for each row
  when (
    new.composition_mode = 'blocks'
    and new.status = 'published'
    and old.status is distinct from 'published'
  )
  execute function public.enforce_block_publish_consistency();

-- ------------------------------------------------------------
-- 12. convert_packet_to_blocks — legacy -> blocks, concurrency-safe & atomic.
--     Locks the packet row FOR UPDATE first, so any concurrent structural write
--     (whose freeze trigger takes FOR SHARE) blocks until this commits and then
--     observes composition_mode='blocks' and is rejected. The item set is thus
--     fixed under the lock: every item gets exactly one block (no missing item
--     blocks). Refuses non-draft/non-legacy/pre-existing-blocks. Section title ->
--     Heading (+ description as optional subtext); items follow in a
--     deterministic (sort_order, id) order. Blank title + blank description ->
--     no heading (matches the renderer). Blank title + non-empty description
--     (description-only) is ambiguous -> raise.
-- ------------------------------------------------------------
create or replace function public.convert_packet_to_blocks(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_existing int;
  v_pos int := 0;
  sec record;
  it record;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'convert: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'convert: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'legacy' then raise exception 'convert: packet % is not in legacy mode (mode=%)', p_packet_id, v_mode; end if;

  select count(*) into v_existing from public.packet_blocks where packet_id = p_packet_id;
  if v_existing <> 0 then raise exception 'convert: packet % unexpectedly already has % block rows', p_packet_id, v_existing; end if;

  for sec in
    select id, title, description from public.sections where packet_id = p_packet_id order by sort_order, id
  loop
    if btrim(coalesce(sec.title, '')) <> '' then
      insert into public.packet_blocks (packet_id, position, block_type, heading_text, heading_subtext)
      values (p_packet_id, v_pos, 'heading', sec.title, nullif(btrim(coalesce(sec.description, '')), ''));
      v_pos := v_pos + 1;
    elsif btrim(coalesce(sec.description, '')) <> '' then
      raise exception 'convert: packet % has a description-only section % (blank title, non-empty description); ambiguous — refusing', p_packet_id, sec.id;
    end if;
    -- blank title AND blank description -> omit the heading block (renderer shows no header)

    for it in
      select id from public.items where section_id = sec.id order by sort_order, id
    loop
      insert into public.packet_blocks (packet_id, position, block_type, item_id)
      values (p_packet_id, v_pos, 'item', it.id);
      v_pos := v_pos + 1;
    end loop;
  end loop;

  -- Authorize exactly this mode flip (transaction-local), flip, then clear the
  -- authorization. The transition guard (10) re-validates the draft requirement
  -- and completeness/consistency, and rejects any unauthorized change.
  perform set_config('app.block_transition_authorized_packet', p_packet_id::text, true);
  update public.packets set composition_mode = 'blocks' where id = p_packet_id;
  perform set_config('app.block_transition_authorized_packet', '', true);
end;
$$;

-- ------------------------------------------------------------
-- 13. revert_packet_to_legacy — blocks -> legacy, concurrency-safe & atomic.
--     Locks the packet FOR UPDATE, refuses non-draft/non-block, deletes all
--     block rows, then flips mode. The legacy sections/items were frozen
--     throughout block mode, so the packet renders as an identical legacy
--     composition (block-only headings and block order are discarded;
--     item-content edits persist because content lives in the item rows).
-- ------------------------------------------------------------
create or replace function public.revert_packet_to_legacy(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'revert: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'revert: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'revert: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  delete from public.packet_blocks where packet_id = p_packet_id;
  -- Authorize exactly this mode flip (transaction-local), flip, then clear it.
  perform set_config('app.block_transition_authorized_packet', p_packet_id::text, true);
  update public.packets set composition_mode = 'legacy' where id = p_packet_id;
  perform set_config('app.block_transition_authorized_packet', '', true);
end;
$$;

-- ------------------------------------------------------------
-- 14. Function privileges — no default PUBLIC execute; grant only what's needed.
--     Trigger/helper functions are invoked internally (no direct execute grant);
--     triggers still fire regardless of execute grants.
-- ------------------------------------------------------------
revoke all on function public.packets_in_block_mode(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.assert_block_item_ownership() from public, anon, authenticated, service_role;
revoke all on function public.freeze_sections_in_block_mode() from public, anon, authenticated, service_role;
revoke all on function public.freeze_items_in_block_mode() from public, anon, authenticated, service_role;
revoke all on function public.enforce_packet_mode_transition() from public, anon, authenticated, service_role;
revoke all on function public.enforce_block_publish_consistency() from public, anon, authenticated, service_role;
revoke all on function public.assert_packet_block_consistency(uuid) from public, anon, authenticated, service_role;
revoke all on function public.convert_packet_to_blocks(uuid) from public, anon, authenticated, service_role;
revoke all on function public.revert_packet_to_legacy(uuid) from public, anon, authenticated, service_role;

grant execute on function public.convert_packet_to_blocks(uuid) to service_role;
grant execute on function public.revert_packet_to_legacy(uuid) to service_role;
grant execute on function public.assert_packet_block_consistency(uuid) to service_role;

-- ------------------------------------------------------------
-- 15. Block-composition editing RPCs (R2-A) — controlled writes for the block
--     editor: reorder the whole ordered block list and add / edit / delete
--     heading-like blocks only. Item blocks reorder but are never inserted,
--     edited, or deleted here; item content is never touched. Each requires a
--     draft block-mode packet, locks the packet FOR UPDATE, and preserves dense
--     positions + the item/block consistency invariant. See migration 0009.
-- ------------------------------------------------------------
create or replace function public.reorder_packet_blocks(p_packet_id uuid, p_block_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_count int;
  v_provided int;
  v_i int;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'reorder: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'reorder: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'reorder: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  select count(*) into v_count from public.packet_blocks where packet_id = p_packet_id;
  v_provided := coalesce(array_length(p_block_ids, 1), 0);
  if v_provided <> v_count then
    raise exception 'reorder: provided % ids but packet % has % blocks', v_provided, p_packet_id, v_count;
  end if;
  if (select count(distinct x) from unnest(p_block_ids) as t(x)) <> v_provided then
    raise exception 'reorder: duplicate ids in the new order';
  end if;
  if exists (
    select 1 from unnest(p_block_ids) as t(x)
    where not exists (select 1 from public.packet_blocks b where b.id = t.x and b.packet_id = p_packet_id)
  ) then
    raise exception 'reorder: an id does not belong to packet %', p_packet_id;
  end if;

  for v_i in 1 .. v_provided loop
    update public.packet_blocks set position = v_i - 1
      where id = p_block_ids[v_i] and packet_id = p_packet_id;
  end loop;

  perform public.assert_packet_block_consistency(p_packet_id);
end;
$$;

create or replace function public.add_heading_block(
  p_packet_id uuid,
  p_position int,
  p_block_type text,
  p_text text,
  p_subtext text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_count int;
  v_sub text;
  v_id uuid;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'add block: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'add block: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'add block: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;
  if p_block_type not in ('heading', 'subheading', 'label') then
    raise exception 'add block: block_type % must be heading, subheading, or label', p_block_type;
  end if;
  if btrim(coalesce(p_text, '')) = '' then
    raise exception 'add block: heading text must be non-blank';
  end if;

  select count(*) into v_count from public.packet_blocks where packet_id = p_packet_id;
  if p_position < 0 or p_position > v_count then
    raise exception 'add block: position % out of range 0..%', p_position, v_count;
  end if;

  -- labels carry no subtext; heading/subheading keep a nonblank subtext or null
  v_sub := case when p_block_type = 'label' then null else nullif(btrim(coalesce(p_subtext, '')), '') end;

  update public.packet_blocks set position = position + 1
    where packet_id = p_packet_id and position >= p_position;

  insert into public.packet_blocks (packet_id, position, block_type, heading_text, heading_subtext)
    values (p_packet_id, p_position, p_block_type, btrim(p_text), v_sub)
    returning id into v_id;

  perform public.assert_packet_block_consistency(p_packet_id);
  return v_id;
end;
$$;

create or replace function public.update_heading_block(p_packet_id uuid, p_block_id uuid, p_text text, p_subtext text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_type text;
  v_sub text;
begin
  -- Lock the URL packet and require draft + block mode.
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'edit block: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'edit block: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'edit block: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  -- Bind the block to THIS packet under the lock.
  select block_type into v_type
    from public.packet_blocks where id = p_block_id and packet_id = p_packet_id;
  if v_type is null then raise exception 'edit block: block % does not belong to packet %', p_block_id, p_packet_id; end if;
  if v_type = 'item' then raise exception 'edit block: block % is an item block and cannot be edited here', p_block_id; end if;
  if btrim(coalesce(p_text, '')) = '' then raise exception 'edit block: heading text must be non-blank'; end if;

  v_sub := case when v_type = 'label' then null else nullif(btrim(coalesce(p_subtext, '')), '') end;
  update public.packet_blocks
    set heading_text = btrim(p_text), heading_subtext = v_sub
    where id = p_block_id and packet_id = p_packet_id;

  perform public.assert_packet_block_consistency(p_packet_id);
end;
$$;

create or replace function public.delete_heading_block(p_packet_id uuid, p_block_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_type text;
  v_pos int;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'delete block: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'delete block: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'delete block: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  -- Bind the block to THIS packet under the lock.
  select block_type, position into v_type, v_pos
    from public.packet_blocks where id = p_block_id and packet_id = p_packet_id;
  if v_type is null then raise exception 'delete block: block % does not belong to packet %', p_block_id, p_packet_id; end if;
  if v_type = 'item' then raise exception 'delete block: block % is an item block and cannot be deleted here', p_block_id; end if;

  delete from public.packet_blocks where id = p_block_id and packet_id = p_packet_id;
  update public.packet_blocks set position = position - 1
    where packet_id = p_packet_id and position > v_pos;

  perform public.assert_packet_block_consistency(p_packet_id);
end;
$$;

revoke all on function public.reorder_packet_blocks(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.add_heading_block(uuid, int, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.update_heading_block(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_heading_block(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.reorder_packet_blocks(uuid, uuid[]) to service_role;
grant execute on function public.add_heading_block(uuid, int, text, text, text) to service_role;
grant execute on function public.update_heading_block(uuid, uuid, text, text) to service_role;
grant execute on function public.delete_heading_block(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 16. Atomic block-mode item-content save (R2-B). One SECURITY DEFINER RPC that
--     saves an item's core fields + replaces details/links/photos/contact inside
--     a single transaction (any failure rolls back everything). Verifies owner /
--     draft / block mode / item-belongs-to-packet; never touches section_id,
--     item/block ordering, or block membership. See migration 0010.
-- ------------------------------------------------------------
create or replace function public.update_block_item_content(
  p_packet_id uuid,
  p_item_id uuid,
  p_owner_id uuid,
  p_title text,
  p_description text,
  p_notes text,
  p_address text,
  p_details jsonb,
  p_links jsonb,
  p_photos jsonb,
  p_contact jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_status text;
  v_mode text;
  v_item_packet uuid;
  r jsonb;
  i int;
begin
  -- Lock the packet row and read its owner/status/mode.
  select user_id, status, composition_mode into v_user, v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'item content: packet % not found', p_packet_id; end if;
  if v_user <> p_owner_id then raise exception 'item content: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'item content: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'item content: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  -- The item must belong to THIS packet (item -> section -> packet_id).
  select s.packet_id into v_item_packet
    from public.items it
    join public.sections s on s.id = it.section_id
    where it.id = p_item_id;
  if v_item_packet is null then raise exception 'item content: item % not found', p_item_id; end if;
  if v_item_packet <> p_packet_id then
    raise exception 'item content: item % does not belong to packet %', p_item_id, p_packet_id;
  end if;

  -- Core content fields only (never section_id / sort_order).
  update public.items
    set title = coalesce(p_title, ''),
        description = coalesce(p_description, ''),
        notes = coalesce(p_notes, ''),
        address = coalesce(p_address, '')
    where id = p_item_id;

  -- Replace details.
  delete from public.item_details where item_id = p_item_id;
  if p_details is not null then
    if jsonb_typeof(p_details) <> 'array' then raise exception 'item content: details must be a JSON array'; end if;
    i := 0;
    for r in select value from jsonb_array_elements(p_details) loop
      insert into public.item_details (item_id, label, value, sort_order)
        values (p_item_id, coalesce(r->>'label', ''), coalesce(r->>'value', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace links.
  delete from public.item_links where item_id = p_item_id;
  if p_links is not null then
    if jsonb_typeof(p_links) <> 'array' then raise exception 'item content: links must be a JSON array'; end if;
    i := 0;
    for r in select value from jsonb_array_elements(p_links) loop
      insert into public.item_links (item_id, url, label, sort_order)
        values (p_item_id, coalesce(r->>'url', ''), coalesce(r->>'label', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace photos (only http(s) URLs are stored, mirroring the app).
  delete from public.item_photos where item_id = p_item_id;
  if p_photos is not null then
    if jsonb_typeof(p_photos) <> 'array' then raise exception 'item content: photos must be a JSON array'; end if;
    i := 0;
    for r in select value from jsonb_array_elements(p_photos) loop
      if coalesce(r->>'url', '') like 'http%' then
        insert into public.item_photos (item_id, url, sort_order)
          values (p_item_id, r->>'url', i);
        i := i + 1;
      end if;
    end loop;
  end if;

  -- Replace contact (one row per item; empty/absent clears it).
  delete from public.item_contacts where item_id = p_item_id;
  if p_contact is not null and jsonb_typeof(p_contact) = 'object'
     and ( coalesce(p_contact->>'name', '') <> ''
        or coalesce(p_contact->>'phone', '') <> ''
        or coalesce(p_contact->>'email', '') <> ''
        or coalesce(p_contact->>'website', '') <> '' ) then
    insert into public.item_contacts (item_id, name, phone, email, website)
      values (
        p_item_id,
        coalesce(p_contact->>'name', ''),
        coalesce(p_contact->>'phone', ''),
        coalesce(p_contact->>'email', ''),
        coalesce(p_contact->>'website', '')
      );
  end if;
end;
$$;

revoke all on function public.update_block_item_content(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_block_item_content(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------
-- update_item_content — THE canonical atomic item-content writer for BOTH the
--   legacy and block editors (migration 0011). One transaction: core fields +
--   all four child sets, all-or-nothing. PRESENCE-AWARE — a NULL text param
--   leaves that column unchanged and a NULL jsonb child leaves that set
--   untouched, so the legacy editor's partial autosaves and the block editor's
--   full save both go through this one implementation. Guards under a packet-row
--   lock: item exists; optional packet cross-check; caller owns packet; packet
--   is draft; optional mode match ('blocks' | 'legacy'). Malformed child arrays
--   raise, rolling back the whole save. update_block_item_content above is the
--   superseded 0010 writer, kept only for the migrate->deploy compatibility
--   window and no longer called by the app.
-- ------------------------------------------------------------
create or replace function public.update_item_content(
  p_item_id uuid,
  p_owner_id uuid,
  p_packet_id uuid,
  p_require_mode text,
  p_title text,
  p_description text,
  p_notes text,
  p_address text,
  p_details jsonb,
  p_links jsonb,
  p_photos jsonb,
  p_contacts jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet_id uuid;
  v_user uuid;
  v_status text;
  v_mode text;
  r jsonb;
  i int;
begin
  -- Resolve the item's packet (item -> section -> packet).
  select s.packet_id into v_packet_id
    from public.items it
    join public.sections s on s.id = it.section_id
    where it.id = p_item_id;
  if v_packet_id is null then raise exception 'item content: item % not found', p_item_id; end if;

  -- Optional cross-check: the item must belong to the packet the caller named.
  if p_packet_id is not null and v_packet_id <> p_packet_id then
    raise exception 'item content: item % does not belong to packet %', p_item_id, p_packet_id;
  end if;

  -- Lock the packet row and read owner/status/mode.
  select user_id, status, composition_mode into v_user, v_status, v_mode
    from public.packets where id = v_packet_id for update;
  if v_user is null then raise exception 'item content: packet % not found', v_packet_id; end if;
  if v_user <> p_owner_id then raise exception 'item content: caller does not own packet %', v_packet_id; end if;
  if v_status <> 'draft' then raise exception 'item content: packet % is not draft (status=%)', v_packet_id, v_status; end if;
  if p_require_mode is not null and v_mode <> p_require_mode then
    raise exception 'item content: packet % is not in % mode (mode=%)', v_packet_id, p_require_mode, v_mode;
  end if;

  -- Core content fields (never section_id / sort_order). NULL = leave unchanged.
  update public.items
    set title = coalesce(p_title, title),
        description = coalesce(p_description, description),
        notes = coalesce(p_notes, notes),
        address = coalesce(p_address, address)
    where id = p_item_id;

  -- Replace details when provided.
  if p_details is not null then
    if jsonb_typeof(p_details) <> 'array' then raise exception 'item content: details must be a JSON array'; end if;
    delete from public.item_details where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_details) loop
      insert into public.item_details (item_id, label, value, sort_order)
        values (p_item_id, coalesce(r->>'label', ''), coalesce(r->>'value', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace links when provided.
  if p_links is not null then
    if jsonb_typeof(p_links) <> 'array' then raise exception 'item content: links must be a JSON array'; end if;
    delete from public.item_links where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_links) loop
      insert into public.item_links (item_id, url, label, sort_order)
        values (p_item_id, coalesce(r->>'url', ''), coalesce(r->>'label', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace photos when provided (only http(s) URLs are stored, mirroring the app).
  if p_photos is not null then
    if jsonb_typeof(p_photos) <> 'array' then raise exception 'item content: photos must be a JSON array'; end if;
    delete from public.item_photos where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_photos) loop
      if coalesce(r->>'url', '') like 'http%' then
        insert into public.item_photos (item_id, url, storage_path, sort_order)
          values (p_item_id, r->>'url', '', i);
        i := i + 1;
      end if;
    end loop;
  end if;

  -- Replace contacts when provided (ordered; blank rows dropped; malformed -> rollback).
  if p_contacts is not null then
    if jsonb_typeof(p_contacts) <> 'array' then raise exception 'item content: contacts must be a JSON array'; end if;
    delete from public.item_contacts where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_contacts) loop
      if coalesce(r->>'name', '') <> ''
         or coalesce(r->>'phone', '') <> ''
         or coalesce(r->>'email', '') <> ''
         or coalesce(r->>'website', '') <> '' then
        insert into public.item_contacts (item_id, name, role, phone, email, website, sort_order)
          values (
            p_item_id,
            coalesce(r->>'name', ''),
            coalesce(r->>'role', ''),
            coalesce(r->>'phone', ''),
            coalesce(r->>'email', ''),
            coalesce(r->>'website', ''),
            i
          );
        i := i + 1;
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;


-- ============================================================
-- RESILIENT AI INGESTION (migration 0012) — ingestion_runs / ingestion_chunks
-- Transient staging for chunked AI ingestion. Mirrors 0012 (no begin/commit);
-- see migration 0012 and docs/investigations/resilient-ai-ingestion.md.
-- ============================================================
-- ----------------------------------------------------------------------------
-- 1. Packet columns: content revision + origin marker
-- ----------------------------------------------------------------------------
alter table public.packets add column if not exists content_rev bigint not null default 0;
alter table public.packets add column if not exists origin_ingestion_run_id uuid;

-- ----------------------------------------------------------------------------
-- 2. Tables
-- ----------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  packet_id uuid not null references public.packets(id) on delete cascade,
  entry_point text not null check (entry_point in ('organize','append','section_append')),
  target_section_id uuid references public.sections(id) on delete cascade,
  source_text text,                 -- resumable source; cleared on finalize/discard
  source_hash text not null,
  source_len int not null default 0, -- JS UTF-16 code-unit length (matches offsets)
  segmenter_version text not null,
  status text not null default 'active'
    check (status in ('active','finalizing','finalized','discarded','error')),
  total_chunks int not null default 0,      -- number of LEAF chunks (real work total)
  completed_chunks int not null default 0,
  baseline_section_count int not null default 0,  -- supplementary content assertions
  baseline_item_count int not null default 0,
  baseline_content_rev bigint not null default 0, -- authoritative change detector
  derived_title text not null default '',   -- source-derived; cleared on finalize/discard
  derived_client_name text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index if not exists idx_ingestion_runs_packet on public.ingestion_runs(packet_id);
create index if not exists idx_ingestion_runs_user on public.ingestion_runs(user_id);
-- At most ONE active/finalizing run per packet — blocks a conflicting second run
-- at the database level (not just the UI).
create unique index if not exists idx_ingestion_runs_one_active
  on public.ingestion_runs(packet_id) where status in ('active','finalizing');

create table if not exists public.ingestion_chunks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingestion_runs(id) on delete cascade,
  ordinal int not null,             -- STABLE identity within the run (never reused)
  source_start int not null,        -- ORDER key; leaf ranges tile [0, source_len)
  source_end int not null,
  segment_text text,                -- cleared on finalize/discard
  segment_hash text not null,
  section_hint text not null default '',  -- source-derived; cleared on finalize/discard
  is_continuation boolean not null default false, -- spillover of the previous chunk's heading group
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','split')),
  attempt_count int not null default 0,
  split_depth int not null default 0,
  result jsonb,                     -- staged structured result; cleared on finalize/discard
  error text not null default '',   -- may hold model text; cleared on finalize/discard
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, ordinal)
);
create index if not exists idx_ingestion_chunks_run on public.ingestion_chunks(run_id, source_start);

alter table public.ingestion_runs enable row level security;
alter table public.ingestion_chunks enable row level security;
-- No anon/authenticated policies: reachable only via the service role.

-- ----------------------------------------------------------------------------
-- 3. content_rev bump triggers — every canonical content/composition mutation
--    bumps packets.content_rev (via an update that needs the packet-row lock).
--    Cascade-safe: a bump targeting an already-deleted packet updates 0 rows.
-- ----------------------------------------------------------------------------
create or replace function public.ingest_bump_by_packet() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  pid := case when tg_op = 'DELETE' then old.packet_id else new.packet_id end;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_section() returns trigger
language plpgsql security definer set search_path = '' as $$
declare sid uuid; pid uuid;
begin
  sid := case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  select packet_id into pid from public.sections where id = sid;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare iid uuid; pid uuid;
begin
  iid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  select s.packet_id into pid from public.items i join public.sections s on s.id = i.section_id where i.id = iid;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

-- Direct packet content/composition edits (title, client name, note, map,
-- identity, composition mode). A content_rev-only update (from a child trigger)
-- leaves these unchanged, so it does not double-count.
create or replace function public.ingest_bump_packet_self() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.title, new.client_name, new.personal_note, new.map_url, new.identity_mode, new.custom_identity, new.composition_mode)
     is distinct from
     (old.title, old.client_name, old.personal_note, old.map_url, old.identity_mode, old.custom_identity, old.composition_mode) then
    new.content_rev := old.content_rev + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ingest_rev_sections on public.sections;
create trigger trg_ingest_rev_sections after insert or update or delete on public.sections for each row execute function public.ingest_bump_by_packet();
drop trigger if exists trg_ingest_rev_blocks on public.packet_blocks;
create trigger trg_ingest_rev_blocks after insert or update or delete on public.packet_blocks for each row execute function public.ingest_bump_by_packet();
drop trigger if exists trg_ingest_rev_items on public.items;
create trigger trg_ingest_rev_items after insert or update or delete on public.items for each row execute function public.ingest_bump_by_section();
drop trigger if exists trg_ingest_rev_details on public.item_details;
create trigger trg_ingest_rev_details after insert or update or delete on public.item_details for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_links on public.item_links;
create trigger trg_ingest_rev_links after insert or update or delete on public.item_links for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_photos on public.item_photos;
create trigger trg_ingest_rev_photos after insert or update or delete on public.item_photos for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_contacts on public.item_contacts;
create trigger trg_ingest_rev_contacts after insert or update or delete on public.item_contacts for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_packet_self on public.packets;
create trigger trg_ingest_rev_packet_self before update on public.packets for each row execute function public.ingest_bump_packet_self();

-- ----------------------------------------------------------------------------
-- 4. Publish guard trigger — a packet cannot be published while a run is active.
-- ----------------------------------------------------------------------------
create or replace function public.block_publish_during_ingest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if exists (select 1 from public.ingestion_runs where packet_id = new.id and status in ('active','finalizing')) then
      raise exception 'cannot publish while an import is in progress';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_publish_during_ingest on public.packets;
create trigger trg_block_publish_during_ingest before update on public.packets
  for each row execute function public.block_publish_during_ingest();

-- Trigger functions must NOT be directly executable by anyone; the triggers
-- invoke them regardless of execute privilege.
revoke all on function public.ingest_bump_by_packet() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_by_section() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_by_item() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_packet_self() from public, anon, authenticated, service_role;
revoke all on function public.block_publish_during_ingest() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. create_ingestion_run — append / section_append (packet already exists).
--    p_chunks: { ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation }
-- ----------------------------------------------------------------------------
create or replace function public.create_ingestion_run(
  p_owner uuid,
  p_packet_id uuid,
  p_entry_point text,
  p_target_section_id uuid,
  p_source_text text,
  p_source_hash text,
  p_source_len int,
  p_segmenter_version text,
  p_chunks jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid; v_status text; v_mode text; v_rev bigint;
  v_sec_packet uuid; v_run_id uuid; v_base_sections int; v_base_items int; c jsonb; n int;
begin
  if p_entry_point not in ('append','section_append') then
    raise exception 'ingestion: create_ingestion_run is for append/section_append (got %)', p_entry_point;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  select user_id, status, composition_mode, content_rev into v_user, v_status, v_mode, v_rev
    from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'ingestion: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'ingestion: packet % is not draft', p_packet_id; end if;
  if p_entry_point = 'append' and v_mode <> 'legacy' then
    raise exception 'ingestion: append requires legacy composition mode';
  end if;

  if p_entry_point = 'section_append' then
    if p_target_section_id is null then raise exception 'ingestion: section_append needs a target section'; end if;
    select packet_id into v_sec_packet from public.sections where id = p_target_section_id;
    if v_sec_packet is null or v_sec_packet <> p_packet_id then
      raise exception 'ingestion: target section does not belong to packet';
    end if;
  end if;

  select count(*) into v_base_sections from public.sections where packet_id = p_packet_id;
  select count(*) into v_base_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = p_packet_id;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, target_section_id, source_text, source_hash, source_len,
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev
  ) values (
    p_owner, p_packet_id, p_entry_point,
    case when p_entry_point = 'section_append' then p_target_section_id else null end,
    p_source_text, p_source_hash, p_source_len, p_segmenter_version, 'active', n, 0, v_base_sections, v_base_items, v_rev
  ) returning id into v_run_id;

  for c in select value from jsonb_array_elements(p_chunks) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
    values (v_run_id, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
            c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
            coalesce((c->>'is_continuation')::boolean, false), 'pending');
  end loop;

  return v_run_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. create_organize_run — Organize: create the draft packet + run + plan +
--    origin marker in ONE transaction (no orphan draft on partial failure).
-- ----------------------------------------------------------------------------
create or replace function public.create_organize_run(
  p_owner uuid,
  p_packet_type text,
  p_slug text,
  p_source_text text,
  p_source_hash text,
  p_source_len int,
  p_segmenter_version text,
  p_chunks jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_packet uuid; v_run uuid; c jsonb; n int;
begin
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  insert into public.packets (user_id, slug, packet_type, status)
    values (p_owner, p_slug, coalesce(nullif(p_packet_type,''),'general'), 'draft')
    returning id into v_packet;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, source_text, source_hash, source_len,
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev
  ) values (
    p_owner, v_packet, 'organize', p_source_text, p_source_hash, p_source_len,
    p_segmenter_version, 'active', n, 0, 0, 0, 0
  ) returning id into v_run;

  for c in select value from jsonb_array_elements(p_chunks) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
    values (v_run, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
            c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
            coalesce((c->>'is_continuation')::boolean, false), 'pending');
  end loop;

  update public.packets set origin_ingestion_run_id = v_run where id = v_packet;

  return jsonb_build_object('packet_id', v_packet, 'run_id', v_run);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. claim_chunk — ATOMIC claim so two requests can't both invoke the model.
--    Locks run + chunk; moves pending / retryable-failed / lease-expired
--    processing to 'processing' and increments attempt exactly once. A live
--    'processing'/'completed'/'split' chunk returns claimed=false.
-- ----------------------------------------------------------------------------
create or replace function public.claim_chunk(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_lease_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_rstatus text; v_chunk record;
begin
  select user_id, status into v_user, v_rstatus from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_rstatus <> 'active' then raise exception 'ingestion: run is % (not active)', v_rstatus; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal for update;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;

  if v_chunk.status = 'completed' then return jsonb_build_object('claimed', false, 'status', 'completed'); end if;
  if v_chunk.status = 'split' then return jsonb_build_object('claimed', false, 'status', 'split'); end if;
  if v_chunk.status = 'processing'
     and v_chunk.updated_at + make_interval(secs => p_lease_seconds) > now() then
    return jsonb_build_object('claimed', false, 'status', 'processing');
  end if;

  update public.ingestion_chunks
    set status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
    where id = v_chunk.id;

  return jsonb_build_object(
    'claimed', true, 'status', 'processing', 'ordinal', v_chunk.ordinal,
    'segment_text', v_chunk.segment_text, 'segment_hash', v_chunk.segment_hash,
    'section_hint', v_chunk.section_hint, 'is_continuation', v_chunk.is_continuation,
    'source_start', v_chunk.source_start, 'source_end', v_chunk.source_end,
    'split_depth', v_chunk.split_depth
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. stage_chunk_result — idempotent staging (attempt is counted at claim).
-- ----------------------------------------------------------------------------
create or replace function public.stage_chunk_result(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_segment_hash text, p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_status text; v_chunk record;
begin
  select user_id, status into v_user, v_status from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_status <> 'active' then raise exception 'ingestion: run is % (not active)', v_status; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;
  if v_chunk.segment_hash <> p_segment_hash then
    raise exception 'ingestion: segment hash mismatch for chunk % (plan changed)', p_ordinal;
  end if;
  if v_chunk.status = 'split' then raise exception 'ingestion: chunk % was subdivided; refresh the plan', p_ordinal; end if;
  if v_chunk.status = 'completed' then
    return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',true);
  end if;
  if jsonb_typeof(p_result) <> 'object' then raise exception 'ingestion: chunk result must be an object'; end if;

  update public.ingestion_chunks
    set result = p_result, status = 'completed', error = '', updated_at = now()
    where id = v_chunk.id;
  update public.ingestion_runs set completed_chunks = completed_chunks + 1, updated_at = now() where id = p_run_id;

  return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. mark_chunk_failed — record a failure (attempt already counted at claim).
-- ----------------------------------------------------------------------------
create or replace function public.mark_chunk_failed(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_error text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid;
begin
  select user_id into v_user from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  update public.ingestion_chunks
    set status = 'failed', error = coalesce(p_error,''), updated_at = now()
    where run_id = p_run_id and ordinal = p_ordinal and status <> 'completed';
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. split_chunk — adaptive subdivision (idempotent if already split).
--     p_children: { source_start, source_end, segment_text, segment_hash, is_continuation }
-- ----------------------------------------------------------------------------
create or replace function public.split_chunk(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_children jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_status text; v_chunk record; v_next int; ch jsonb; v_added int := 0; v_hint text;
begin
  select user_id, status into v_user, v_status from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_status <> 'active' then raise exception 'ingestion: run is % (not active)', v_status; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal for update;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;
  if v_chunk.status = 'completed' then raise exception 'ingestion: chunk % already completed', p_ordinal; end if;
  if v_chunk.status = 'split' then return jsonb_build_object('added', 0, 'alreadySplit', true); end if;
  if v_chunk.split_depth >= 4 then raise exception 'ingestion: chunk % too small to subdivide further', p_ordinal; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) < 2 then
    raise exception 'ingestion: split needs >= 2 children';
  end if;

  v_hint := v_chunk.section_hint;
  update public.ingestion_chunks set status = 'split', updated_at = now() where id = v_chunk.id;

  select coalesce(max(ordinal),0) + 1 into v_next from public.ingestion_chunks where run_id = p_run_id;
  for ch in select value from jsonb_array_elements(p_children) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status, split_depth)
    values (p_run_id, v_next, (ch->>'source_start')::int, (ch->>'source_end')::int,
            ch->>'segment_text', coalesce(ch->>'segment_hash',''), v_hint,
            coalesce((ch->>'is_continuation')::boolean, false), 'pending', v_chunk.split_depth + 1);
    v_next := v_next + 1; v_added := v_added + 1;
  end loop;

  update public.ingestion_runs set total_chunks = total_chunks + (v_added - 1), updated_at = now() where id = p_run_id;
  return jsonb_build_object('added', v_added);
end;
$$;

-- ----------------------------------------------------------------------------
-- 11. finalize_ingestion_run — apply staged result to the canonical packet in
--     ONE transaction; refuse if content_rev changed; recombine by continuation
--     flag; then clear ALL source-derived staged material.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_puser uuid; v_cur_rev bigint; v_sec_packet uuid;
  v_prev int := 0; leaf record; v_cur_sections int; v_cur_items int;
  v_base_sort int; v_item_base int; v_target_section uuid;
  v_last_section uuid := null; v_first_sec boolean;
  sec jsonb; it jsonb; d jsonb; l jsonb; ph text; ct jsonb;
  v_new_section uuid; v_new_item uuid; di int; li int; pi int; ci int;
  v_sections int := 0; v_items int := 0;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.status = 'finalized' then return jsonb_build_object('status','finalized','reused',true); end if;
  if v_run.status <> 'active' then raise exception 'ingestion: run is % (cannot finalize)', v_run.status; end if;

  select status, user_id, content_rev into v_pstatus, v_puser, v_cur_rev from public.packets where id = v_run.packet_id for update;
  if v_puser is null then raise exception 'ingestion: packet not found'; end if;
  if v_puser <> p_owner then raise exception 'ingestion: caller does not own packet'; end if;
  if v_pstatus <> 'draft' then raise exception 'ingestion: packet is not draft (cannot finalize)'; end if;

  -- Authoritative change detection: the content revision must exactly match the
  -- value captured when the run began (any edit/reorder/child change bumped it).
  if v_cur_rev <> v_run.baseline_content_rev then
    raise exception 'ingestion: packet changed since the import began (content_rev % <> %)', v_cur_rev, v_run.baseline_content_rev;
  end if;
  -- Supplementary count assertions.
  select count(*) into v_cur_sections from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_cur_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  if v_cur_sections <> v_run.baseline_section_count or v_cur_items <> v_run.baseline_item_count then
    raise exception 'ingestion: packet content changed since the import began (counts % / %)', v_cur_sections, v_cur_items;
  end if;

  -- Coverage/completeness over LEAF chunks, in JS UTF-16 code-unit offsets.
  for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
    if leaf.status <> 'completed' then raise exception 'ingestion: chunk % not completed', leaf.ordinal; end if;
    if leaf.source_start <> v_prev then raise exception 'ingestion: coverage gap/overlap at %', leaf.source_start; end if;
    v_prev := leaf.source_end;
  end loop;
  if v_prev <> v_run.source_len then raise exception 'ingestion: chunks do not cover the whole source (% of %)', v_prev, v_run.source_len; end if;

  -- ---- Apply to the canonical packet ----
  if v_run.entry_point in ('organize','append') then
    select coalesce(max(sort_order),-1)+1 into v_base_sort from public.sections where packet_id = v_run.packet_id;
    for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
      v_first_sec := true;
      for sec in select value from jsonb_array_elements(coalesce(leaf.result->'sections','[]'::jsonb)) loop
        if v_first_sec and leaf.is_continuation and v_last_section is not null then
          v_new_section := v_last_section;  -- continuation spillover joins previous group (never by title)
        else
          insert into public.sections (packet_id, title, description, sort_order)
            values (v_run.packet_id, coalesce(nullif(sec->>'title',''),'Section'), coalesce(sec->>'description',''), v_base_sort)
            returning id into v_new_section;
          v_base_sort := v_base_sort + 1; v_sections := v_sections + 1;
        end if;
        v_last_section := v_new_section; v_first_sec := false;

        select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_new_section;
        for it in select value from jsonb_array_elements(coalesce(sec->'items','[]'::jsonb)) loop
          insert into public.items (section_id, title, address, description, notes, sort_order)
            values (v_new_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                    coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base)
            returning id into v_new_item;
          v_item_base := v_item_base + 1; v_items := v_items + 1;
          di := 0;
          for d in select value from jsonb_array_elements(coalesce(it->'details','[]'::jsonb)) loop
            insert into public.item_details (item_id,label,value,sort_order) values (v_new_item, coalesce(d->>'label',''), coalesce(d->>'value',''), di); di := di+1;
          end loop;
          li := 0;
          for l in select value from jsonb_array_elements(coalesce(it->'links','[]'::jsonb)) loop
            if coalesce(l->>'url','') like 'http%' then
              insert into public.item_links (item_id,url,label,sort_order) values (v_new_item, l->>'url', coalesce(l->>'label',''), li); li := li+1;
            end if;
          end loop;
          pi := 0;
          for ph in select value from jsonb_array_elements_text(coalesce(it->'photos','[]'::jsonb)) loop
            if ph like 'http%' then insert into public.item_photos (item_id,url,storage_path,sort_order) values (v_new_item, ph, '', pi); pi := pi+1; end if;
          end loop;
          ci := 0;
          for ct in select value from jsonb_array_elements(
            coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)) loop
            if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
              insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
                values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''), coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
            end if;
          end loop;
        end loop;
      end loop;
    end loop;

    if v_run.entry_point = 'organize' then
      update public.packets set
        title = case when v_run.derived_title <> '' then v_run.derived_title else title end,
        client_name = case when v_run.derived_client_name <> '' then v_run.derived_client_name else client_name end,
        raw_input = coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    else
      update public.packets set raw_input = coalesce(raw_input,'') || E'\n\n--- Added ---\n\n' || coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    end if;

  else  -- section_append: items only, into the named section
    v_target_section := v_run.target_section_id;
    select packet_id into v_sec_packet from public.sections where id = v_target_section;
    if v_sec_packet is null or v_sec_packet <> v_run.packet_id then raise exception 'ingestion: target section no longer valid'; end if;
    select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_target_section;
    for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
      for it in select value from jsonb_array_elements(coalesce(leaf.result->'items','[]'::jsonb)) loop
        insert into public.items (section_id, title, address, description, notes, sort_order)
          values (v_target_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                  coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base)
          returning id into v_new_item;
        v_item_base := v_item_base + 1; v_items := v_items + 1;
        di := 0;
        for d in select value from jsonb_array_elements(coalesce(it->'details','[]'::jsonb)) loop
          insert into public.item_details (item_id,label,value,sort_order) values (v_new_item, coalesce(d->>'label',''), coalesce(d->>'value',''), di); di := di+1;
        end loop;
        li := 0;
        for l in select value from jsonb_array_elements(coalesce(it->'links','[]'::jsonb)) loop
          if coalesce(l->>'url','') like 'http%' then insert into public.item_links (item_id,url,label,sort_order) values (v_new_item, l->>'url', coalesce(l->>'label',''), li); li := li+1; end if;
        end loop;
        pi := 0;
        for ph in select value from jsonb_array_elements_text(coalesce(it->'photos','[]'::jsonb)) loop
          if ph like 'http%' then insert into public.item_photos (item_id,url,storage_path,sort_order) values (v_new_item, ph, '', pi); pi := pi+1; end if;
        end loop;
        ci := 0;
        for ct in select value from jsonb_array_elements(
          coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)) loop
          if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
            insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
              values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''), coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
          end if;
        end loop;
      end loop;
    end loop;
    update public.packets set raw_input = coalesce(raw_input,'') || E'\n\n--- Added ---\n\n' || coalesce(v_run.source_text,'')
      where id = v_run.packet_id;
  end if;

  -- Finalize + privacy cleanup (same transaction): drop ALL source-derived fields.
  update public.ingestion_runs
    set status = 'finalized', finalized_at = now(), completed_chunks = total_chunks,
        source_text = null, derived_title = '', derived_client_name = '', error = '', updated_at = now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
    where run_id = p_run_id;

  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ----------------------------------------------------------------------------
-- 12. discard_ingestion_run — abandon; clear ALL source-derived material; delete
--     the packet ONLY under strict explicit conditions.
-- ----------------------------------------------------------------------------
create or replace function public.discard_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run record; v_pstatus text; v_origin uuid; v_secs int; v_items int; v_blocks int; v_deleted boolean := false;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.status = 'finalized' then raise exception 'ingestion: run already finalized'; end if;

  update public.ingestion_runs
    set status='discarded', source_text=null, derived_title='', derived_client_name='', error='', updated_at=now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result=null, segment_text=null, section_hint='', error='', updated_at=now()
    where run_id = p_run_id;

  select status, origin_ingestion_run_id into v_pstatus, v_origin from public.packets where id = v_run.packet_id for update;
  select count(*) into v_secs from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  select count(*) into v_blocks from public.packet_blocks where packet_id = v_run.packet_id;

  if v_run.entry_point = 'organize' and v_origin = p_run_id and v_pstatus = 'draft'
     and v_secs = 0 and v_items = 0 and v_blocks = 0 then
    delete from public.packets where id = v_run.packet_id;
    v_deleted := true;
  end if;

  return jsonb_build_object('status','discarded','deletedPacket',v_deleted);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: callable RPCs are service-role only. (Trigger functions are revoked
-- above and never granted.)
-- ----------------------------------------------------------------------------
revoke all on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) to service_role;
revoke all on function public.create_organize_run(uuid, text, text, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_organize_run(uuid, text, text, text, text, int, text, jsonb) to service_role;
revoke all on function public.claim_chunk(uuid, uuid, int, int) from public, anon, authenticated, service_role;
grant execute on function public.claim_chunk(uuid, uuid, int, int) to service_role;
revoke all on function public.stage_chunk_result(uuid, uuid, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.stage_chunk_result(uuid, uuid, int, text, jsonb) to service_role;
revoke all on function public.mark_chunk_failed(uuid, uuid, int, text) from public, anon, authenticated, service_role;
grant execute on function public.mark_chunk_failed(uuid, uuid, int, text) to service_role;
revoke all on function public.split_chunk(uuid, uuid, int, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.split_chunk(uuid, uuid, int, jsonb) to service_role;
revoke all on function public.finalize_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ingestion_run(uuid, uuid) to service_role;
revoke all on function public.discard_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.discard_ingestion_run(uuid, uuid) to service_role;
