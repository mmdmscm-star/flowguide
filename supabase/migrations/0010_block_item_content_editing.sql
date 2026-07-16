-- ============================================================================
-- 0010 — Atomic block-mode item-content save (R2-B correction)
--
-- The block editor previously saved item content through several independent
-- statements (item update + delete/insert per child table). If one child write
-- failed, earlier writes had already committed and the UI rollback could not
-- undo them. This migration adds ONE SECURITY DEFINER RPC that performs the
-- whole save inside a single function invocation — i.e. a single transaction, so
-- any validation failure or write error rolls back EVERYTHING and the item's
-- content is preserved exactly.
--
-- The RPC receives the packet id, item id, and the server-resolved owner id
-- explicitly. It locks the packet row, then verifies: the owner id matches
-- packets.user_id; the packet is draft; the packet is in block mode; and the
-- item belongs to that exact packet. It updates only the item's core content
-- fields and replaces details/links/photos/contact. It NEVER touches
-- items.section_id, items.sort_order, packet_blocks, or any composition/ordering.
--
-- Direct DML on the item tables is unchanged; this RPC is an additional,
-- narrowly-scoped write path granted to service_role only. No other DB object,
-- trigger, RLS policy, or the legacy /api/items path is modified.
--
-- Runs safely as a single transaction.
-- ============================================================================

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

-- No direct execute for public/anon/authenticated; grant only to service_role.
revoke all on function public.update_block_item_content(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.update_block_item_content(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;
