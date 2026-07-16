-- ============================================================================
-- 0009 — Block-composition editing RPCs (R2-A)
--
-- Adds the controlled write path for the persistent block editor. Four
-- SECURITY DEFINER RPCs let the app reorder the whole ordered block list and
-- add / edit / delete HEADING-LIKE blocks (heading, subheading, label) only.
-- Item blocks may be reordered but are never inserted, edited, or deleted here,
-- and item CONTENT (the item rows) is never touched.
--
-- Every RPC:
--   * requires a DRAFT, block-mode packet;
--   * locks the packet row FOR UPDATE while it changes composition (serializing
--     against convert/revert and other block edits);
--   * preserves dense positions 0..n-1 and the item-block/item consistency
--     invariant (verified with assert_packet_block_consistency before returning);
--   * relies on the deferrable unique(packet_id, position) constraint to reorder
--     positions freely within the transaction.
--
-- Direct DML on packet_blocks stays revoked for every API role — these RPCs,
-- owned by the definer, are the only write path. Execute is granted only to
-- service_role (the app's server client); the app additionally authorizes
-- ownership before calling. Nothing here changes composition_mode, so the
-- mode-transition guard, ownership trigger, structural freeze, RLS, and the
-- block-publish gate are all untouched.
--
-- Runs safely as a single transaction.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. reorder_packet_blocks — set the complete ordered block list. p_block_ids
--    must be EXACTLY the packet's current block ids (a permutation): same count,
--    all belonging to the packet, no duplicates. Assigns positions 0..n-1 in the
--    given order. Item blocks move with the sequence but are neither added nor
--    removed, so the consistency invariant is preserved.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 2. add_heading_block — insert a heading-like block at p_position (0..n). Shifts
--    existing blocks at/after that position up by one. block_type must be
--    heading-like; item blocks are never created here. Labels carry no subtext.
--    Returns the new block id.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 3. update_heading_block — edit a heading-like block's text and optional
--    subtext. Rejects item blocks. Positions and the item set are untouched.
-- ----------------------------------------------------------------------------
create or replace function public.update_heading_block(p_block_id uuid, p_text text, p_subtext text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet uuid;
  v_type text;
  v_status text;
  v_mode text;
  v_sub text;
begin
  select packet_id into v_packet from public.packet_blocks where id = p_block_id;
  if v_packet is null then raise exception 'edit block: block % not found', p_block_id; end if;

  select status, composition_mode into v_status, v_mode
    from public.packets where id = v_packet for update;
  if v_status <> 'draft' then raise exception 'edit block: packet % is not draft (status=%)', v_packet, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'edit block: packet % is not in block mode (mode=%)', v_packet, v_mode; end if;

  -- re-read the block type under the packet lock
  select block_type into v_type from public.packet_blocks where id = p_block_id;
  if v_type is null then raise exception 'edit block: block % not found', p_block_id; end if;
  if v_type = 'item' then raise exception 'edit block: block % is an item block and cannot be edited here', p_block_id; end if;
  if btrim(coalesce(p_text, '')) = '' then raise exception 'edit block: heading text must be non-blank'; end if;

  v_sub := case when v_type = 'label' then null else nullif(btrim(coalesce(p_subtext, '')), '') end;
  update public.packet_blocks
    set heading_text = btrim(p_text), heading_subtext = v_sub
    where id = p_block_id;

  perform public.assert_packet_block_consistency(v_packet);
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. delete_heading_block — delete a heading-like block only, then re-densify
--    positions. Item blocks cannot be deleted here, and NO item content is
--    touched: only the single heading row is removed. Adjacent items keep their
--    relative order and simply close the gap.
-- ----------------------------------------------------------------------------
create or replace function public.delete_heading_block(p_block_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet uuid;
  v_type text;
  v_pos int;
  v_status text;
  v_mode text;
begin
  select packet_id into v_packet from public.packet_blocks where id = p_block_id;
  if v_packet is null then raise exception 'delete block: block % not found', p_block_id; end if;

  select status, composition_mode into v_status, v_mode
    from public.packets where id = v_packet for update;
  if v_status <> 'draft' then raise exception 'delete block: packet % is not draft (status=%)', v_packet, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'delete block: packet % is not in block mode (mode=%)', v_packet, v_mode; end if;

  select block_type, position into v_type, v_pos from public.packet_blocks where id = p_block_id;
  if v_type is null then raise exception 'delete block: block % not found', p_block_id; end if;
  if v_type = 'item' then raise exception 'delete block: block % is an item block and cannot be deleted here', p_block_id; end if;

  delete from public.packet_blocks where id = p_block_id;
  update public.packet_blocks set position = position - 1
    where packet_id = v_packet and position > v_pos;

  perform public.assert_packet_block_consistency(v_packet);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Function privileges — no direct execute for public/anon/authenticated;
--    grant execute only to service_role (the app's server client). Direct DML on
--    packet_blocks remains revoked, so these RPCs are the only write path.
-- ----------------------------------------------------------------------------
revoke all on function public.reorder_packet_blocks(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.add_heading_block(uuid, int, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.update_heading_block(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_heading_block(uuid) from public, anon, authenticated, service_role;

grant execute on function public.reorder_packet_blocks(uuid, uuid[]) to service_role;
grant execute on function public.add_heading_block(uuid, int, text, text, text) to service_role;
grant execute on function public.update_heading_block(uuid, text, text) to service_role;
grant execute on function public.delete_heading_block(uuid) to service_role;
