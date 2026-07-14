-- Append AI-structured ITEMS into an EXISTING section, in one transaction.
-- Backs the per-section "Add items with AI" operation. Unlike
-- insert_structured_sections (which creates sections), this targets a section
-- the professional already chose and never creates sections.
--
-- Atomicity & concurrency:
--   - Validates the section belongs to p_packet_id (defense in depth; the route
--     already checked ownership) and RAISEs on mismatch, rolling everything back.
--   - Locks the section row (FOR UPDATE) so simultaneous additions to the same
--     section serialize and cannot compute the same sort_order.
--   - Determines the next sort_order INSIDE the transaction (the API route does
--     not pass an offset).
--   - Appends the source text to packets.raw_input in the same transaction,
--     using coalesce(raw_input, '') so a NULL current value cannot swallow it.
--   - Any failure rolls back items, child rows, and the raw_input change together.
--
-- Security: SECURITY INVOKER (runs as the caller — the app's service-role key,
-- which bypasses RLS; an anon/authenticated caller would hit RLS and be blocked
-- from writing). Fixed empty search_path with fully-qualified identifiers.
-- EXECUTE is revoked from PUBLIC *and* the anon/authenticated roles (Supabase's
-- default privileges grant EXECUTE on new public functions directly to anon and
-- authenticated, so revoking PUBLIC alone is not enough), and granted only to
-- service_role, so the function is not callable by the anon/authenticated API
-- roles.

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

  -- Append to Original Input in the same transaction; coalesce guards NULL.
  update public.packets
    set raw_input = coalesce(raw_input, '') || p_raw_append
    where id = p_packet_id;
end;
$$;

revoke execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.insert_items_into_section(uuid, uuid, jsonb, text) to service_role;
