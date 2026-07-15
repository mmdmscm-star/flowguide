-- Insert an AI-structured payload (sections -> items -> details/links/photos/
-- contacts) in ONE transaction. Called via RPC from the structure and append
-- routes. Replaces row-by-row hydration from the app server: a single
-- round-trip, and a failure anywhere rolls back everything — no partial
-- structure can ever persist.
--
-- Field semantics mirror the previous TypeScript hydration exactly:
--   - blank/missing section/item titles get positional fallbacks
--   - links and photos are kept only when the URL starts with http
--   - contact rows are created only when at least one field has a value
--
-- Runs with invoker rights; the app calls it with the service-role key.
-- Anonymous callers gain nothing: table RLS still applies to them.

create or replace function public.insert_structured_sections(
  p_packet_id uuid,
  p_sections jsonb,
  p_sort_offset int
) returns void
language plpgsql
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
