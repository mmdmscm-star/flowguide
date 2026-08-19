-- 0023 — creating a FlowGuide from saved Library material, in ONE transaction.
--
-- WHY. The application did this as three writes with compensating cleanup: on a
-- failure it deleted the draft it had just created. That is not atomicity. If
-- the process, connection or instance dies between the packet insert and the
-- cleanup, the cleanup never runs and an orphan or partial draft survives —
-- exactly the "a conceptual single action must not depend on cleanup executing
-- after a partial write" rule this codebase applies everywhere else.
--
-- A plpgsql body is one transaction, so every failure below — including a raised
-- exception from update_item_content deep inside the loop — rolls back the
-- packet, the section and every item together. There is nothing to clean up
-- because nothing was committed.
--
-- REUSE, NOT A SECOND INTERPRETATION.
--   * Content is written by update_item_content (0011), the canonical atomic
--     writer both editors already use, so a copied item is indistinguishable
--     from a hand-made one.
--   * Photo coercion lives in ONE function, library_canonical_photos, which the
--     forthcoming at-rest cleanup migration reuses rather than restating.
--   * library_copy_into_section is shared by BOTH entry points — adding to a
--     FlowGuide you are editing, and creating a new one — so the two cannot
--     drift on lineage or on content.

begin;

-- ---------------------------------------------------------------------------
-- 1. The one place photo shape is interpreted in SQL.
--
--    The model's contract for an extracted item is photos: string[]
--    (ingest-validate.ts); the canonical payload shape is {url}[]. Entries
--    imported before the normaliser existed still hold bare strings, and reading
--    those as objects yields {url: null} — which is what made Library editing
--    impossible until it was fixed at the application boundary.
-- ---------------------------------------------------------------------------
create or replace function public.library_canonical_photos(p_photos jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_agg(x order by ord)
       from (
         select case
                  when jsonb_typeof(e.value) = 'string' then jsonb_build_object('url', e.value #>> '{}')
                  when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value->'url') = 'string'
                    then jsonb_build_object('url', e.value->>'url')
                  else null
                end as x,
                e.ord
           from jsonb_array_elements(
                  case when jsonb_typeof(p_photos) = 'array' then p_photos else '[]'::jsonb end
                ) with ordinality as e(value, ord)
       ) t
      where x is not null
        and coalesce(btrim(x->>'url'), '') <> ''),
    '[]'::jsonb);
$$;

comment on function public.library_canonical_photos(jsonb) is
  'Coerce a Library photos value to the canonical [{url}] shape, tolerating the bare string[] an AI import used to store. The single SQL interpretation of that shape.';

-- ---------------------------------------------------------------------------
-- 2. Copy Library entries into an existing section.
--
--    ALL OR NOTHING, and deliberately stricter than the application was: if any
--    chosen entry is missing or is not the caller's, the whole call fails rather
--    than quietly producing a partial subset. A professional who picked four
--    things must get four or an error, never three and no explanation.
-- ---------------------------------------------------------------------------
create or replace function public.library_copy_into_section(
  p_owner uuid, p_packet_id uuid, p_section_id uuid, p_library_item_ids uuid[]
) returns uuid[]
language plpgsql
security definer
set search_path = ''
as $lcs$
declare
  v_found int; v_sec_packet uuid; v_next int; v_item uuid; v_ids uuid[] := '{}';
  src record;
begin
  if p_library_item_ids is null or array_length(p_library_item_ids, 1) is null then
    raise exception 'library: choose at least one saved item';
  end if;

  select packet_id into v_sec_packet from public.sections where id = p_section_id;
  if v_sec_packet is null or v_sec_packet <> p_packet_id then
    raise exception 'library: section does not belong to this FlowGuide';
  end if;

  -- Every chosen entry must exist AND be this professional's.
  select count(*) into v_found from public.library_items
   where id = any(p_library_item_ids) and user_id = p_owner;
  if v_found <> array_length(p_library_item_ids, 1) then
    raise exception 'library: % of % chosen entries are missing or not yours',
      array_length(p_library_item_ids, 1) - v_found, array_length(p_library_item_ids, 1);
  end if;

  select coalesce(max(sort_order), -1) + 1 into v_next
    from public.items where section_id = p_section_id;

  -- IN THE ORDER CHOSEN. `with ordinality` over the array preserves the
  -- professional's selection order; a plain `= any(...)` join would not.
  for src in
    select li.*, k.ord
      from unnest(p_library_item_ids) with ordinality as k(id, ord)
      join public.library_items li on li.id = k.id and li.user_id = p_owner
     order by k.ord
  loop
    insert into public.items (section_id, title, sort_order, library_item_id, library_item_revision)
    values (p_section_id, coalesce(src.title, ''), v_next, src.id, src.revision)
    returning id into v_item;
    v_next := v_next + 1;

    -- The canonical writer. Any failure here raises, and the whole call —
    -- including the packet, when this is reached from create_packet_from_library
    -- — rolls back.
    --
    -- NO INGESTION PROVENANCE IS WRITTEN. A Library copy has no ingestion
    -- origin, so ownership recomputation must decline for it rather than guess;
    -- inventing a run/chunk/emit index would fabricate a source claim.
    perform public.update_item_content(
      v_item, p_owner, p_packet_id, 'legacy',
      coalesce(src.title, ''), coalesce(src.description, ''),
      coalesce(src.notes, ''), coalesce(src.address, ''),
      coalesce(src.details, '[]'::jsonb), coalesce(src.links, '[]'::jsonb),
      public.library_canonical_photos(src.photos), coalesce(src.contacts, '[]'::jsonb));

    v_ids := v_ids || v_item;
  end loop;

  return v_ids;
end;
$lcs$;

-- ---------------------------------------------------------------------------
-- 3. The whole FlowGuide, atomically.
-- ---------------------------------------------------------------------------
create or replace function public.create_packet_from_library(
  p_owner uuid, p_slug text, p_title text, p_client_name text, p_library_item_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $cpf$
declare v_packet uuid; v_section uuid; v_ids uuid[]; v_status text; v_mode text; v_type text;
begin
  if not exists (select 1 from public.users where id = p_owner) then
    raise exception 'library: unknown owner';
  end if;

  -- THE SAME COLUMNS THE ORDINARY BLANK CREATE SETS, AND NO OTHERS.
  --
  -- status, composition_mode, packet_type, identity_mode, map_url, personal_note,
  -- raw_input, content_rev and viewed all come from column defaults here exactly
  -- as they do for a FlowGuide made with "Start blank". Restating any of them
  -- would be a second declaration of what a new FlowGuide is, free to drift from
  -- the first the next time a default changes.
  begin
    insert into public.packets (user_id, slug, title, client_name)
    values (p_owner, p_slug, coalesce(p_title, ''), coalesce(p_client_name, ''))
    returning id into v_packet;
  exception when unique_violation then
    -- Same surface as the blank path, which retries a taken slug: the caller
    -- picks another and calls again. Nothing partial exists to clean up.
    raise exception 'library: slug % is taken', p_slug using errcode = 'unique_violation';
  end;

  -- ...but this operation inserts SECTIONS AND ITEMS, which trg_freeze_items and
  -- trg_freeze_sections forbid in block mode. Relying on the default is correct;
  -- relying on it SILENTLY is not. If the default ever moves, this must fail
  -- loudly here rather than produce a FlowGuide whose items cannot be written.
  select status, composition_mode, packet_type into v_status, v_mode, v_type
    from public.packets where id = v_packet;
  if v_status <> 'draft' then
    raise exception 'library: new FlowGuide defaulted to status %, expected draft', v_status;
  end if;
  if v_mode <> 'legacy' then
    raise exception 'library: new FlowGuide defaulted to composition_mode %, which freezes items', v_mode;
  end if;
  if coalesce(v_type, '') = '' then
    raise exception 'library: new FlowGuide has no packet_type';
  end if;

  insert into public.sections (packet_id, title, sort_order)
  values (v_packet, '', 0)
  returning id into v_section;

  v_ids := public.library_copy_into_section(p_owner, v_packet, v_section, p_library_item_ids);

  if v_ids is null or array_length(v_ids, 1) is null then
    -- Unreachable given the all-or-nothing check above, and it still raises
    -- rather than returning an empty FlowGuide: a draft with nothing in it is
    -- the orphan this whole migration exists to make impossible.
    raise exception 'library: nothing was copied';
  end if;

  return jsonb_build_object(
    'packet_id', v_packet, 'section_id', v_section,
    'item_ids', to_jsonb(v_ids), 'count', array_length(v_ids, 1));
end;
$cpf$;

-- ---------------------------------------------------------------------------
-- 4. Privileges — service role only, like every other write RPC.
-- ---------------------------------------------------------------------------
revoke all on function public.library_canonical_photos(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.library_canonical_photos(jsonb) to service_role;
revoke all on function public.library_copy_into_section(uuid, uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.library_copy_into_section(uuid, uuid, uuid, uuid[]) to service_role;
revoke all on function public.create_packet_from_library(uuid, text, text, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.create_packet_from_library(uuid, text, text, text, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Structural verification.
-- ---------------------------------------------------------------------------
do $verify$
declare v_name text; v_acl text;
begin
  foreach v_name in array array['library_canonical_photos','library_copy_into_section','create_packet_from_library'] loop
    -- PINNED AND EMPTY. `like 'search_path=%'` would also accept
    -- search_path=public, which is not a pinned search path at all — it is the
    -- resolution behaviour these functions exist to avoid.
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = v_name
                      and coalesce(array_to_string(p.proconfig, ','), '')
                          in ('search_path=', 'search_path=""')) then
      raise exception '0023 verify: % is missing, or its search_path is not pinned EMPTY', v_name;
    end if;
    select coalesce(array_to_string(p.proacl, ' '), 'DEFAULT') into v_acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_acl = 'DEFAULT' or v_acl ~ '(^| )=X' or v_acl like '%anon=X%' or v_acl like '%authenticated=X%' then
      raise exception '0023 verify: % is executable beyond service_role: %', v_name, v_acl;
    end if;
  end loop;

  -- TWO THINGS THIS BLOCK GOT WRONG THE FIRST TIME, both worth stating because
  -- either alone makes an assertion lie:
  --
  --   1. prosrc INCLUDES COMMENTS. The provenance check matched the comment
  --      inside library_copy_into_section that explains it does NOT write
  --      provenance — an assertion firing on the sentence promising the thing it
  --      forbids.
  --   2. LIKE TREATS _ AS A WILDCARD. '%emit_index%' matches the words
  --      "emit index", so the pattern never needed the literal identifier to be
  --      present at all. Every check below uses a regex, where _ is literal.
  --
  -- So: match against EXECUTABLE code with comments stripped, and separately
  -- prove the stripper works and the guard comment is still there — otherwise a
  -- change to how comments are written would make this silently vacuous.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'library_copy_into_section'
                    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'update_item_content') then
    raise exception '0023 verify: library_copy_into_section does not use the canonical content writer';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('library_copy_into_section','create_packet_from_library')
                and regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                    ~ '(origin_run_id|origin_chunk_ordinal|emit_index)') then
    raise exception '0023 verify: a copy path WRITES ingestion provenance';
  end if;

  -- The stripper is load-bearing, so prove it: the guard comment must still be
  -- present in the raw source AND absent once comments are removed. If stripping
  -- ever stops working, the first half fails; if the comment is deleted, so does
  -- the explanation of why no provenance is written.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'library_copy_into_section'
                    and p.prosrc ~ 'NO INGESTION PROVENANCE IS WRITTEN'
                    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') !~ 'NO INGESTION PROVENANCE IS WRITTEN') then
    raise exception '0023 verify: the provenance guard comment is missing, or comment stripping is not working';
  end if;

  -- The coercion actually coerces.
  if public.library_canonical_photos('["https://a/1.jpg"]'::jsonb) <> '[{"url": "https://a/1.jpg"}]'::jsonb then
    raise exception '0023 verify: bare strings are not coerced';
  end if;
  if public.library_canonical_photos('[{"url":"https://a/1.jpg"}]'::jsonb) <> '[{"url": "https://a/1.jpg"}]'::jsonb then
    raise exception '0023 verify: canonical photos are not preserved';
  end if;
  if public.library_canonical_photos('[{},null,"",7]'::jsonb) <> '[]'::jsonb then
    raise exception '0023 verify: malformed photo entries are not dropped';
  end if;
  if public.library_canonical_photos(null) <> '[]'::jsonb then
    raise exception '0023 verify: a null photos value is not handled';
  end if;

  raise notice '0023 verify: OK';
end
$verify$;

commit;
