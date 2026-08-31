-- 0044 — ONE ATOMIC MOVE FOR THE LIBRARY'S STRUCTURE.
--
-- Direct manipulation needs a placement the professional can trust: they drop a
-- row between two others and that is where it is, or nothing happened. Today
-- every ordering write is a LOOP of separate statements — `moveItem` sends two,
-- `placeItems` sends one per item — and a failure part-way through leaves an
-- order nobody chose. Two writes is a small window. A precise drop renumbers a
-- whole container, so the window would grow with the container, and it would
-- grow exactly where the professional is moving fastest.
--
-- So the move becomes one statement's worth of work: one function, one
-- transaction, all of it or none of it.
--
-- DENSE RENUMBERING, NOT FRACTIONAL RANKS. The affected container is rewritten
-- 0..n-1 on every move. That is deliberately the dumbest thing that works: the
-- Library's containers are small (the largest holds 17 items today), and a
-- dense rewrite ESTABLISHES the ordering property every time instead of
-- maintaining it. Fractional ranking would buy fewer row writes at the price of
-- a new invariant to preserve forever, plus rebalancing, plus a second kind of
-- ordering bug to reason about. The existing tie-tolerance in `swapForMove`
-- becomes belt-and-braces rather than load-bearing.
--
-- WHAT IT WILL NOT DO:
--   * it never touches `revision` or `updated_at`. Moving an item is not a
--     change to what it says, and a Library copy's descendants must not be told
--     their ancestor moved on because somebody dragged a row.
--   * it never invents or matches a destination by NAME. Dropping onto a
--     Section puts the item loose in that Section and CLEARS its old group;
--     there is no search for a same-named group in the destination.
--   * it will not move a Group between Sections, and it will not accept a
--     neighbour from a different container than the destination. Those are not
--     conservative refusals of a hard case — they are the two ways a drop can
--     mean something the professional did not see on screen.
--
-- THE NEIGHBOUR IS RESOLVED AGAINST STORAGE, NOT AGAINST WHAT WAS RENDERED.
-- The Library pages each container, so the browser routinely holds six rows of
-- a sixteen-row section. The client says "put this immediately before that one"
-- and the server reads the whole container to work out what that means. This is
-- also why a future hidden-Section feature stays safe here: siblings are read
-- from the table, so a Section omitted from the view is still counted when
-- Sections are renumbered.

begin;

create or replace function public.library_move(
  p_owner    uuid,
  p_kind     text,     -- 'item' | 'section' | 'group'
  p_id       uuid,
  p_section  uuid,     -- destination section  (items only)
  p_group    uuid,     -- destination group, null = loose in the section (items only)
  p_before   uuid,     -- place immediately BEFORE this sibling
  p_after    uuid      -- place immediately AFTER this sibling
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_from_section uuid;
  v_from_group   uuid;
  v_section      uuid;
  v_ids          uuid[];
  v_pos          int;
begin
  if p_owner is null or p_id is null then
    raise exception 'library_move: owner and id are required';
  end if;
  if p_before is not null and p_after is not null then
    raise exception 'library_move: give a neighbour to go before OR after, not both';
  end if;
  if p_id in (p_before, p_after) then
    raise exception 'library_move: a thing cannot be placed relative to itself';
  end if;

  -- ONE OWNER'S MOVES HAPPEN ONE AT A TIME.
  --
  -- Every branch below reads a container's current order and then rewrites it.
  -- Those reads take no locks of their own, so two calls could both read the
  -- pre-move state and the second would write an order computed without the
  -- first — a LOST UPDATE. Nothing would be malformed, because each writes a
  -- complete dense sequence; the earlier move would simply be undone, silently,
  -- which under drag reads as "it jumped back".
  --
  -- A transaction-scoped advisory lock on the OWNER is the simplest thing that
  -- closes it. Locking the affected rows instead would mean taking several row
  -- sets — source and destination — in a consistent order, and would still have
  -- nothing to lock when a destination container is empty. There is no such
  -- thing as an empty owner.
  --
  -- This serializes calls to library_move FOR THAT OWNER, and nothing else. It
  -- does not touch the legacy Move Up / Move Down / Move To implementation,
  -- which still writes through its own statements and is unchanged by this
  -- migration. One professional gains nothing from moving two things at once.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));

  -- =======================================================================
  -- ITEM — reorder within a container, or move into another one.
  -- =======================================================================
  if p_kind = 'item' then
    select section_id, group_id into v_from_section, v_from_group
      from public.library_items where id = p_id and user_id = p_owner;
    if not found then
      raise exception 'library_move: no such item for this owner';
    end if;

    -- THE DESTINATION MUST EXIST AND BE THEIRS. Phase 1 drags only into
    -- organized containers; the unorganized remainder is newest-first and has
    -- no sequence to drop into.
    if p_section is null then
      raise exception 'library_move: an item must land in a section';
    end if;
    if not exists (select 1 from public.library_sections
                    where id = p_section and user_id = p_owner) then
      raise exception 'library_move: no such section for this owner';
    end if;
    -- A group is only a destination inside the section it belongs to. This is
    -- the check that stops a group id from another section silently relocating
    -- the item somewhere the professional never dropped it.
    if p_group is not null and not exists (
      select 1 from public.library_groups
       where id = p_group and section_id = p_section and user_id = p_owner) then
      raise exception 'library_move: that group is not in that section';
    end if;

    -- THE NEIGHBOUR MUST ALREADY BE IN THE DESTINATION. A neighbour from
    -- somewhere else describes a position that does not exist.
    if coalesce(p_before, p_after) is not null then
      if not exists (
        select 1 from public.library_items
         where id = coalesce(p_before, p_after)
           and user_id = p_owner
           and section_id = p_section
           and group_id is not distinct from p_group) then
        raise exception 'library_move: that neighbour is not in the destination container';
      end if;
    end if;

    -- PLACEMENT FIRST. `group_id` takes the destination's value, so dropping on
    -- a Section (p_group null) clears whatever group the item was in.
    update public.library_items
       set section_id = p_section, group_id = p_group
     where id = p_id and user_id = p_owner;

    -- The destination container, in its stored order, with the mover removed.
    select coalesce(array_agg(id order by sort_order, id), '{}')
      into v_ids
      from public.library_items
     where user_id = p_owner and section_id = p_section
       and group_id is not distinct from p_group
       and id <> p_id;

    -- Where the mover goes. No neighbour means the actual end of the container,
    -- which is not the same as the end of whatever had been loaded.
    if p_before is not null then
      v_pos := array_position(v_ids, p_before);
    elsif p_after is not null then
      v_pos := array_position(v_ids, p_after) + 1;
    else
      -- array_length of an empty array is NULL, not 0 — so an append into a
      -- container with nothing in it would compute a NULL position, slice to
      -- NULL, and unnest nothing: the item would land in the container and keep
      -- whatever sort_order it arrived with.
      v_pos := coalesce(array_length(v_ids, 1), 0) + 1;
    end if;
    v_ids := v_ids[1:v_pos - 1] || p_id || v_ids[v_pos:];

    update public.library_items i
       set sort_order = x.ord - 1
      from unnest(v_ids) with ordinality as x(id, ord)
     where i.id = x.id and i.user_id = p_owner;

    -- The container it LEFT is also affected: closing the gap keeps the
    -- sequence dense so the next neighbour lookup reads cleanly.
    if v_from_section is not null
       and (v_from_section, v_from_group) is distinct from (p_section, p_group) then
      update public.library_items i
         set sort_order = x.ord - 1
        from (select id, row_number() over (order by sort_order, id) as ord
                from public.library_items
               where user_id = p_owner and section_id = v_from_section
                 and group_id is not distinct from v_from_group) as x
       where i.id = x.id and i.user_id = p_owner;
    end if;

  -- =======================================================================
  -- SECTION — reorder among the owner's sections.
  -- =======================================================================
  elsif p_kind = 'section' then
    if not exists (select 1 from public.library_sections
                    where id = p_id and user_id = p_owner) then
      raise exception 'library_move: no such section for this owner';
    end if;
    if coalesce(p_before, p_after) is not null
       and not exists (select 1 from public.library_sections
                        where id = coalesce(p_before, p_after) and user_id = p_owner) then
      raise exception 'library_move: that neighbour is not one of your sections';
    end if;

    select coalesce(array_agg(id order by sort_order, id), '{}')
      into v_ids
      from public.library_sections
     where user_id = p_owner and id <> p_id;

    if p_before is not null then v_pos := array_position(v_ids, p_before);
    elsif p_after is not null then v_pos := array_position(v_ids, p_after) + 1;
    else v_pos := coalesce(array_length(v_ids, 1), 0) + 1;
    end if;
    v_ids := v_ids[1:v_pos - 1] || p_id || v_ids[v_pos:];

    update public.library_sections s
       set sort_order = x.ord - 1
      from unnest(v_ids) with ordinality as x(id, ord)
     where s.id = x.id and s.user_id = p_owner;

  -- =======================================================================
  -- GROUP — reorder within its OWN section, and only there.
  -- =======================================================================
  elsif p_kind = 'group' then
    select section_id into v_section
      from public.library_groups where id = p_id and user_id = p_owner;
    if not found then
      raise exception 'library_move: no such group for this owner';
    end if;
    -- A destination section may be sent for symmetry with items, but it can
    -- only be the one the group already lives in. Moving a group between
    -- sections would move everything inside it, which is not a drag gesture
    -- anyone aimed at.
    if p_section is not null and p_section <> v_section then
      raise exception 'library_move: a group cannot move between sections';
    end if;
    if coalesce(p_before, p_after) is not null
       and not exists (select 1 from public.library_groups
                        where id = coalesce(p_before, p_after)
                          and section_id = v_section and user_id = p_owner) then
      raise exception 'library_move: that neighbour is not in the same section';
    end if;

    select coalesce(array_agg(id order by sort_order, id), '{}')
      into v_ids
      from public.library_groups
     where user_id = p_owner and section_id = v_section and id <> p_id;

    if p_before is not null then v_pos := array_position(v_ids, p_before);
    elsif p_after is not null then v_pos := array_position(v_ids, p_after) + 1;
    else v_pos := coalesce(array_length(v_ids, 1), 0) + 1;
    end if;
    v_ids := v_ids[1:v_pos - 1] || p_id || v_ids[v_pos:];

    update public.library_groups g
       set sort_order = x.ord - 1
      from unnest(v_ids) with ordinality as x(id, ord)
     where g.id = x.id and g.user_id = p_owner;

  else
    raise exception 'library_move: unknown kind %', p_kind;
  end if;
end;
$fn$;

comment on function public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid) is
  'Moves one Library item, section or group to a position relative to a named sibling, or to the end of a container when no sibling is given. Renumbers the affected container densely, in one transaction. Writes only placement and sort_order — never revision or updated_at, and never a name.';

-- SECURITY DEFINER DEFAULTS TO PUBLIC EXECUTE. Every caller reaches this
-- through the application's service-role client, which resolves the owner from
-- the session; anon and authenticated must not be able to pass their own
-- p_owner.
revoke all on function public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid) from anon, authenticated;
grant execute on function public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid) to service_role;

do $v$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'library_move') <> 1 then
    raise exception '0044: more than one library_move exists — an old overload survives';
  end if;
  -- The ARGUMENT TYPES are the identity; pg_get_function_identity_arguments
  -- also carries the parameter names, which are not part of it.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'library_move'
                    and oidvectortypes(p.proargtypes) = 'uuid, text, uuid, uuid, uuid, uuid, uuid') then
    raise exception '0044: the function identity is not the one the application will call';
  end if;
  if has_function_privilege('anon', 'public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid)', 'EXECUTE') then
    raise exception '0044: anon or authenticated can execute a SECURITY DEFINER function';
  end if;
  if not has_function_privilege('service_role', 'public.library_move(uuid, text, uuid, uuid, uuid, uuid, uuid)', 'EXECUTE') then
    raise exception '0044: service_role cannot execute the function the application calls';
  end if;
end;
$v$;

commit;
