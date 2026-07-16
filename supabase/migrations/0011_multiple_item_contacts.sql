-- ============================================================================
-- 0011 — Multiple contacts per item (+ one atomic item-content writer)
--
-- Root fix for a source-fidelity defect: an item could store only ONE contact
-- (item_contacts had a column-level UNIQUE(item_id)), so a second supplied
-- person was silently dropped. FlowGuide may reorganize supplied info but must
-- never discard it. This migration lets an item hold an ORDERED list of contacts.
--
-- Smallest safe architecture: REUSE the existing item_contacts table (every
-- existing contact row + id is preserved). Additive only:
--   * add role (optional) and sort_order columns;
--   * drop the one-row-per-item UNIQUE(item_id) — by DISCOVERY, not by assumed
--     name (a column-level UNIQUE is named item_contacts_item_id_key by default,
--     but we drop whatever unique constraint/index covers exactly (item_id));
--   * add an (item_id, sort_order) index for deterministic ordered loading.
-- Existing single-contact items become one-entry lists (sort_order 0, role '')
-- with no visible change.
--
-- ATOMICITY FIX (folded in deliberately): before this change the LEGACY editor
-- persisted item content through applyItemContentUpdate — a sequence of
-- INDEPENDENT PostgREST calls (items.update; then delete+insert per child
-- table). Each call was its own transaction, so a contacts delete could commit
-- and its insert fail, wiping a contact list; and a multi-field save could
-- leave item fields changed while a later child write failed. The block editor
-- was already atomic (update_block_item_content, 0010). This migration adds ONE
-- canonical atomic writer, update_item_content, used by BOTH editors so there is
-- a single item-content persistence implementation and every save is
-- all-or-nothing.
--
-- COMPATIBILITY WINDOW: update_block_item_content (0010) is intentionally left
-- untouched. The currently-deployed app calls it (with a singular p_contact);
-- after this migration but before the new code deploys, those single-contact
-- saves keep working (role/sort_order default; the unique is gone). The new code
-- calls update_item_content instead; update_block_item_content is then orphaned
-- and can be dropped in a later cleanup migration. (We do NOT rename its
-- parameter here — CREATE OR REPLACE FUNCTION cannot rename an input parameter,
-- and renaming would break the deployed caller during the window.)
--
-- Runs as a single explicit transaction (begin/commit below) — all-or-nothing.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Additive columns + ordered index.
-- ----------------------------------------------------------------------------
alter table public.item_contacts add column if not exists role text not null default '';
alter table public.item_contacts add column if not exists sort_order int not null default 0;
create index if not exists idx_item_contacts_item_sort on public.item_contacts (item_id, sort_order);

-- ----------------------------------------------------------------------------
-- 2. Drop the one-contact-per-item uniqueness by DISCOVERY (name-agnostic).
--    Drops any UNIQUE constraint whose columns are exactly (item_id), then any
--    leftover unique index on exactly (item_id) not backing a constraint.
-- ----------------------------------------------------------------------------
do $$
declare
  v_item_id_attnum smallint;
  v_name text;
begin
  select attnum into v_item_id_attnum
    from pg_attribute
    where attrelid = 'public.item_contacts'::regclass and attname = 'item_id';

  -- UNIQUE constraints on exactly (item_id).
  for v_name in
    select con.conname
      from pg_constraint con
      where con.conrelid = 'public.item_contacts'::regclass
        and con.contype = 'u'
        and con.conkey = array[v_item_id_attnum]
  loop
    execute format('alter table public.item_contacts drop constraint %I', v_name);
  end loop;

  -- Any remaining UNIQUE index on exactly (item_id) not owned by a constraint.
  for v_name in
    select ix.indexrelid::regclass::text
      from pg_index ix
      where ix.indrelid = 'public.item_contacts'::regclass
        and ix.indisunique
        and ix.indnkeyatts = 1
        and ix.indkey[0] = v_item_id_attnum
        and not exists (select 1 from pg_constraint c where c.conindid = ix.indexrelid)
  loop
    execute format('drop index if exists %s', v_name);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. insert_items_into_section — parse an ordered `contacts` array per item
--    (falls back to a legacy singular `contact` object). Blank rows dropped.
--    Signature unchanged (p_packet_id, p_section_id, p_items, p_raw_append), so
--    CREATE OR REPLACE is safe and grants persist.
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
-- 4. update_item_content — THE canonical atomic item-content writer for BOTH
--    editors. One transaction: core fields + all four child sets, all-or-nothing.
--
--    PRESENCE-AWARE (supports the legacy editor's partial saves): a NULL text
--    param leaves that column unchanged; a NULL jsonb child leaves that child
--    set untouched. A provided jsonb child (even '[]') REPLACES that set. So the
--    block editor (sends everything) does a full replace, and the legacy editor
--    (autosaves one field group at a time) touches only what it sent — while any
--    single request is still atomic.
--
--    Guards under a packet-row lock: item exists; if p_packet_id is given it must
--    match the item's packet (block-route cross-check); caller owns the packet;
--    packet is draft; if p_require_mode is given the packet is in that mode
--    (block route -> 'blocks', legacy route -> 'legacy'). A malformed child
--    array raises, rolling back the entire save (no exception handler).
-- ----------------------------------------------------------------------------
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

-- Same hardened grant posture as the other content RPCs: reachable only by the
-- service role (routes call it after their own auth checks).
revoke all on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;

commit;
