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
  item_id uuid unique not null references public.items(id) on delete cascade,
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  created_at timestamptz not null default now()
);

create index idx_item_contacts_item_id on public.item_contacts(item_id);

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
-- AI STRUCTURING — TRANSACTIONAL INSERT
-- Inserts an AI-structured payload (sections -> items -> details/links/
-- photos/contacts) in one transaction; any failure rolls back everything.
-- Called via RPC by the structure/append routes with the service-role key.
-- Mirrors migrations/0005_insert_structured_sections.sql.
-- ============================================================
create or replace function public.insert_structured_sections(
  p_packet_id uuid,
  p_sections jsonb,
  p_sort_offset int
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  s jsonb;
  it jsonb;
  d jsonb;
  l jsonb;
  ph text;
  c jsonb;
  si int := 0;
  ii int;
  di int;
  li int;
  pi int;
  new_section_id uuid;
  new_item_id uuid;
begin
  for s in select value from jsonb_array_elements(coalesce(p_sections, '[]'::jsonb))
  loop
    insert into public.sections (packet_id, title, description, sort_order)
    values (
      p_packet_id,
      coalesce(nullif(s->>'title', ''), 'Section ' || (p_sort_offset + si + 1)),
      coalesce(s->>'description', ''),
      p_sort_offset + si
    )
    returning id into new_section_id;

    ii := 0;
    for it in select value from jsonb_array_elements(coalesce(s->'items', '[]'::jsonb))
    loop
      insert into public.items (section_id, title, address, description, notes, sort_order)
      values (
        new_section_id,
        coalesce(nullif(it->>'title', ''), 'Item ' || (ii + 1)),
        coalesce(it->>'address', ''),
        coalesce(it->>'description', ''),
        coalesce(it->>'notes', ''),
        ii
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

      c := it->'contact';
      if c is not null and jsonb_typeof(c) = 'object' and (
        coalesce(c->>'name', '') <> '' or
        coalesce(c->>'phone', '') <> '' or
        coalesce(c->>'email', '') <> '' or
        coalesce(c->>'website', '') <> ''
      ) then
        insert into public.item_contacts (item_id, name, phone, email, website)
        values (
          new_item_id,
          coalesce(c->>'name', ''),
          coalesce(c->>'phone', ''),
          coalesce(c->>'email', ''),
          coalesce(c->>'website', '')
        );
      end if;

      ii := ii + 1;
    end loop;

    si := si + 1;
  end loop;
end;
$$;

revoke execute on function public.insert_structured_sections(uuid, jsonb, int) from public;
grant execute on function public.insert_structured_sections(uuid, jsonb, int) to service_role;

-- ============================================================
-- ADD ITEMS TO AN EXISTING SECTION — TRANSACTIONAL APPEND
-- Backs the per-section "Add items with AI" operation (migration 0006).
-- Validates the section belongs to the packet, determines sort_order inside the
-- transaction (locking the section row against concurrent adds), inserts items
-- + child rows, and appends the source text to raw_input — all or nothing.
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
  new_item_id uuid;
begin
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

    c := it->'contact';
    if c is not null and jsonb_typeof(c) = 'object' and (
      coalesce(c->>'name', '') <> '' or
      coalesce(c->>'phone', '') <> '' or
      coalesce(c->>'email', '') <> '' or
      coalesce(c->>'website', '') <> ''
    ) then
      insert into public.item_contacts (item_id, name, phone, email, website)
      values (
        new_item_id,
        coalesce(c->>'name', ''),
        coalesce(c->>'phone', ''),
        coalesce(c->>'email', ''),
        coalesce(c->>'website', '')
      );
    end if;

    ii := ii + 1;
  end loop;

  update public.packets
    set raw_input = coalesce(raw_input, '') || p_raw_append
    where id = p_packet_id;
end;
$$;

revoke execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) from public;
grant execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) to service_role;
