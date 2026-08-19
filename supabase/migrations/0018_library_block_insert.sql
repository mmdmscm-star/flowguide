-- 0018 — SUPERSEDED. APPLIED 2026-08-18, THEN FOUND UNREACHABLE. DO NOT USE.
--
-- This function is correct in every respect except that it can never succeed.
--
-- WHAT WAS MISSED. The design traced where packet_blocks item rows are created
-- (convert_packet_to_blocks, 0007) and concluded the only gap was a missing
-- block row. It did not check whether an ITEM row may be created in block mode
-- at all. It may not: trg_freeze_items (0007) rejects INSERT, DELETE, section_id
-- and sort_order changes for any item whose packet is in block mode, and
-- trg_freeze_sections does the same for sections. In block mode composition is
-- owned by packet_blocks and the items/sections substrate is deliberately
-- FROZEN — only content edits are allowed.
--
-- So the very first statement in this function raises:
--   "items are frozen: cannot INSERT an item into a block-mode packet"
--
-- Proven at runtime 2026-08-18: the insertion returned nothing_inserted, and
-- crucially the packet was left completely untouched — no orphan item, no orphan
-- block, assert_packet_block_consistency still passing. The atomicity this
-- function was written for held even as it failed.
--
-- STATUS. Applied and inert. Nothing calls it; the route refuses block packets
-- before reaching it, and it is revoked from anon, authenticated and PUBLIC.
-- Harmless to leave, but recommended to drop, because an unreachable function
-- that always raises will mislead the next reader:
--
--   drop function if exists public.library_insert_item_block(uuid, uuid, uuid, uuid);
--
-- Supporting Library insertion in block mode means CHANGING the freeze
-- invariant, which is a composition decision and not a Library one.
--
-- ============================ original header ============================
-- 0018 — insert a Library snapshot into a BLOCK-mode FlowGuide.
--
-- WHY THIS EXISTS. 0017 shipped Library insertion for legacy packets only,
-- because a block packet needs a packet_blocks row per item and there was no
-- code anywhere that creates one for a NEW item. Item blocks are written in
-- exactly ONE place in the whole schema — convert_packet_to_blocks (0007) —
-- and that converts items that already exist. The block editor's own
-- add_heading_block (0009) creates headings and explicitly rejects item blocks.
--
-- So inserting from the Library into a block packet created an item with no
-- block: invisible in the editor, and then a publish failure from
-- assert_packet_block_consistency reading "packet has an item with no block".
--
-- WHY IT MUST BE ONE FUNCTION. The item row and its block row are a bijection
-- the database enforces. Written as two statements from the application, a
-- failure between them leaves the packet permanently inconsistent and
-- unpublishable, with no affordance anywhere to repair it. supabase-js exposes
-- no multi-statement transaction, so atomicity requires a function. This is the
-- same reasoning that made 0017's two cross-table writers functions.
--
-- WHAT THIS IS NOT. Not a general "add an arbitrary item block" feature. It
-- takes a library_items id and nothing else that could name arbitrary content,
-- and it appends — it cannot place a block at a caller-chosen position. Adding
-- items to a block packet by hand remains unbuilt, deliberately.
--
-- BORROWED WHOLESALE, not redesigned:
--   * the item-block shape          (packet_id, position, 'item', item_id) — 0007
--   * append-then-assert            add_heading_block's idiom              — 0009
--   * owner / draft / mode preamble both of the above
--   * ON DELETE CASCADE from items to packet_blocks, so removing the item on a
--     later failure takes its block with it and the bijection still holds.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

create or replace function public.library_insert_item_block(
  p_owner uuid,
  p_packet_id uuid,
  p_library_item_id uuid,
  p_section_id uuid default null   -- optional; defaults to the first section
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid; v_status text; v_mode text;
  v_section uuid; v_title text; v_address text; v_description text; v_notes text;
  v_revision bigint; v_item uuid; v_pos int;
begin
  -- Lock the packet for the whole transaction: position assignment reads
  -- max(position) and a concurrent insert must not pick the same one.
  select user_id, status, composition_mode into v_user, v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_user is null    then raise exception 'library block insert: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'library block insert: caller does not own packet'; end if;
  if v_status <> 'draft' then
    raise exception 'library block insert: packet is not draft (status=%)', v_status;
  end if;
  if v_mode <> 'blocks' then
    raise exception 'library block insert: packet is not in block mode (mode=%)', v_mode;
  end if;

  select title, address, description, notes, revision
    into v_title, v_address, v_description, v_notes, v_revision
    from public.library_items where id = p_library_item_id and user_id = p_owner;
  if v_title is null then
    raise exception 'library block insert: library item % not found for this owner', p_library_item_id;
  end if;

  -- Block packets keep their sections — assert_packet_block_consistency counts
  -- items THROUGH sections — but composition is by block, so any section of this
  -- packet is a correct home. A caller-supplied one is verified to belong here.
  if p_section_id is not null then
    select id into v_section from public.sections
      where id = p_section_id and packet_id = p_packet_id;
    if v_section is null then
      raise exception 'library block insert: section % is not in this packet', p_section_id;
    end if;
  else
    select id into v_section from public.sections
      where packet_id = p_packet_id order by sort_order, id limit 1;
    if v_section is null then
      raise exception 'library block insert: packet has no section to hold an item';
    end if;
  end if;

  -- The item. Lineage is written as BOTH columns or neither; 0017's CHECK makes
  -- a half state unrepresentable and this is where one would be introduced.
  -- 0014 ingestion provenance is deliberately left NULL: a Library copy has no
  -- import origin, so ownership recompute must decline for it rather than guess.
  insert into public.items (section_id, title, address, description, notes, sort_order,
                            library_item_id, library_item_revision)
  select v_section, coalesce(v_title,''), coalesce(v_address,''),
         coalesce(v_description,''), coalesce(v_notes,''),
         coalesce((select max(sort_order) + 1 from public.items where section_id = v_section), 0),
         p_library_item_id, v_revision
  returning id into v_item;

  -- The block, APPENDED. Positions are dense 0..n-1, so max+1 keeps them dense
  -- and needs no shifting — which is why this cannot place a block anywhere else.
  select coalesce(max(position) + 1, 0) into v_pos
    from public.packet_blocks where packet_id = p_packet_id;

  insert into public.packet_blocks (packet_id, position, block_type, item_id)
  values (p_packet_id, v_pos, 'item', v_item);

  -- The same assertion add_heading_block runs, inside the same transaction: if
  -- the bijection or the position density is broken, nothing is written at all.
  perform public.assert_packet_block_consistency(p_packet_id);

  return v_item;
end;
$$;

revoke all on function public.library_insert_item_block(uuid, uuid, uuid, uuid) from public;
revoke all on function public.library_insert_item_block(uuid, uuid, uuid, uuid) from anon, authenticated;

do $verify$
declare v_left text;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname='public' and p.proname='library_insert_item_block') then
    raise exception '0018: library_insert_item_block was not created';
  end if;

  select string_agg(p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='library_insert_item_block'
    and (not p.prosecdef or coalesce(array_to_string(p.proconfig,','),'') not like '%search_path=%');
  if v_left is not null then
    raise exception '0018: not SECURITY DEFINER with a pinned search_path: %', v_left;
  end if;

  select string_agg(distinct r.rolname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'),('authenticated')) as r(rolname)
  where n.nspname='public' and p.proname='library_insert_item_block'
    and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_left is not null then
    raise exception '0018: still executable by: %', v_left;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='library_insert_item_block'
               and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) then
    raise exception '0018: PUBLIC can still execute library_insert_item_block';
  end if;

  raise notice '0018: library_insert_item_block installed; not reachable by anon, authenticated or PUBLIC';
end
$verify$;

commit;

notify pgrst, 'reload schema';
