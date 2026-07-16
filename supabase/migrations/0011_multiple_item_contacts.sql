-- ============================================================================
-- 0011 — Multiple contacts per item
--
-- Root fix for a source-fidelity defect: an item could store only ONE contact
-- (item_contacts had a UNIQUE(item_id) constraint), so a second supplied person
-- was silently dropped. FlowGuide may reorganize supplied info but must never
-- discard it. This migration lets an item hold an ORDERED list of contacts.
--
-- Smallest safe architecture: REUSE the existing item_contacts table (every
-- existing contact row + id is preserved). Additive only:
--   * add role (optional) and sort_order columns;
--   * drop the one-row-per-item UNIQUE(item_id) constraint;
--   * add an (item_id, sort_order) index for deterministic ordered loading.
-- Existing single-contact items become one-entry lists (sort_order 0, role '')
-- with no visible change. Reversible where practical: the column adds drop
-- cleanly; the unique can be re-added while data still has <= 1 contact per item.
--
-- Two write RPCs are updated to accept an ordered contacts ARRAY (with a legacy
-- singular-object fallback so any older caller/AI payload still works). Blank
-- contact rows are never written. Signatures are unchanged, so grants are too.
--
-- Runs safely as a single transaction.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Additive columns + drop the one-row-per-item constraint + ordered index.
-- ----------------------------------------------------------------------------
alter table public.item_contacts add column if not exists role text not null default '';
alter table public.item_contacts add column if not exists sort_order int not null default 0;
alter table public.item_contacts drop constraint if exists item_contacts_item_id_key;
create index if not exists idx_item_contacts_item_sort on public.item_contacts (item_id, sort_order);

-- ----------------------------------------------------------------------------
-- 2. insert_items_into_section — parse an ordered `contacts` array per item
--    (falls back to a legacy singular `contact` object). Blank rows dropped.
-- ----------------------------------------------------------------------------
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

  update public.packets
    set raw_input = coalesce(raw_input, '') || p_raw_append
    where id = p_packet_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. update_block_item_content — replace the item's contacts with an ordered
--    array (p_contacts). Blank rows dropped; a malformed array raises so the
--    whole atomic save rolls back. Same signature as 0010 (last param jsonb).
-- ----------------------------------------------------------------------------
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
  p_contacts jsonb
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

  -- Replace contacts (ordered; blank rows dropped; malformed -> rollback).
  delete from public.item_contacts where item_id = p_item_id;
  if p_contacts is not null then
    if jsonb_typeof(p_contacts) <> 'array' then raise exception 'item content: contacts must be a JSON array'; end if;
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
