-- ============================================================================
-- 0036 — library_copy_into_section calls the CURRENT update_item_content.
--
-- THE DEFECT. 0033 dropped the 12-argument update_item_content and created a
-- 13-argument one, inserting p_highlight between p_notes and p_address. It
-- updated every TypeScript caller. It did not update the SQL caller inside
-- public.library_copy_into_section (0023), which still issued the 12-argument
-- call:
--
--   update_item_content(uuid, uuid, uuid, unknown, text, text, text, text,
--                       jsonb, jsonb, jsonb, jsonb)   <- no such function
--
-- (`unknown` is the untyped 'legacy' literal.)
--
-- WHY IT STAYED HIDDEN. PostgreSQL resolves a call inside a plpgsql body when
-- the body RUNS, not when it is created. 0033 applied cleanly and the break sat
-- there until someone used the feature. The tests over this path assert on the
-- TEXT of the route and the migration, so a mismatch between two database
-- functions was structurally invisible to them.
--
-- BOTH Library entry points were broken, not just the reported one:
--   POST /api/packets/from-library            (create a FlowGuide from Library)
--   POST /api/packets/[id]/items/from-library (add Library items to one)
-- Both reach this same function.
--
-- THE FIX is one line of the call plus its argument list. Nothing else about
-- this function changes: same identity, same all-or-nothing refusal, same
-- selection order, same absence of ingestion provenance.
--
-- p_highlight IS ''. A highlight is written for ONE client ("because you
-- asked"), which is exactly why 0033 refused to add the column to
-- library_items: reused Library material must never carry one family's
-- personalisation into another's FlowGuide. A Library copy therefore starts
-- with no highlight, and this migration does not change what is copied.
--
-- ON GRANTS. The revoke/grant below is a RESTATEMENT, not a repair.
-- CREATE OR REPLACE FUNCTION on the same identity — same name, same argument
-- types — updates the existing pg_proc row in place, so the OID, the owner and
-- the ACL all survive; the grants from 0023 remain exactly as they were. What
-- discards an ACL is DROP + CREATE, or a signature change, which is a NEW
-- function that gets the default EXECUTE to PUBLIC. That is what happened in
-- 0031 (fixed by 0032) and what 0033 correctly guarded against, because both
-- CHANGED a signature. This migration does not. The statements are repeated
-- only so the intended posture is legible in one place.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

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
    --
    -- NO HIGHLIGHT EITHER, for the same kind of reason: a highlight belongs to
    -- one client, and this material is reused across clients.
    perform public.update_item_content(
      v_item, p_owner, p_packet_id, 'legacy',
      coalesce(src.title, ''), coalesce(src.description, ''),
      coalesce(src.notes, ''), '', coalesce(src.address, ''),
      coalesce(src.details, '[]'::jsonb), coalesce(src.links, '[]'::jsonb),
      public.library_canonical_photos(src.photos), coalesce(src.contacts, '[]'::jsonb));

    v_ids := v_ids || v_item;
  end loop;

  return v_ids;
end;
$lcs$;

comment on function public.library_copy_into_section(uuid, uuid, uuid, uuid[]) is
  'Copy chosen Library entries into a section, all or nothing, in the order chosen. Writes content through update_item_content with an empty highlight: Library material is reused across clients and must never carry one client''s Highlight for Client text.';

-- Restatement, not repair — see the note at the top of this file. The identity
-- is unchanged, so the 0023 grants are still in force; these lines make the
-- intended posture explicit rather than implied.
revoke all on function public.library_copy_into_section(uuid, uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.library_copy_into_section(uuid, uuid, uuid, uuid[]) to service_role;

commit;
