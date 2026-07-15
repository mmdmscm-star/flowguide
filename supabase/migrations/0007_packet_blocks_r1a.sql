-- ============================================================
-- R1A — Ordered-block composition: additive, INERT database substrate.
--
-- Adds packets.composition_mode ('legacy' default) and the packet_blocks table,
-- with DB-enforced safety that holds even against direct service-role writes:
--   * cross-packet item ownership (immediate constraint trigger);
--   * a complete structural freeze of legacy sections/items in block mode,
--     coordinated with a packet-row lock so it is concurrency-safe;
--   * a composition-mode transition guard (legacy<->blocks only, draft-only,
--     block representation must be complete/consistent);
--   * block packets kept draft-only until R1C ships the block renderer;
--   * controlled writes (direct DML revoked; changes only via SECURITY DEFINER
--     RPCs) and consistency assertions.
--
-- Every existing packet stays 'legacy', so this changes no behavior. Depends
-- only on the base schema (packets, sections, items) and the existing
-- update_updated_at(); no dependency on migration 0005 or any WIP branch.
-- reorder_blocks is intentionally NOT included (deferred to R2).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Composition mode on packets (default legacy; opt-in per packet).
-- ------------------------------------------------------------
alter table public.packets
  add column composition_mode text not null default 'legacy'
    check (composition_mode in ('legacy', 'blocks'));

-- ------------------------------------------------------------
-- 2. packet_blocks — one ordered sequence of independent blocks per packet.
--    Heading/Subheading/Label are visual-only; Item blocks reference an existing
--    item row (content is never duplicated). Positions are >= 0, unique, dense.
--    Label blocks carry no subtext (settled prototype behavior).
-- ------------------------------------------------------------
create table public.packet_blocks (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references public.packets(id) on delete cascade,
  position int not null,
  block_type text not null check (block_type in ('heading', 'subheading', 'label', 'item')),
  item_id uuid references public.items(id) on delete cascade,
  heading_text text,
  heading_subtext text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_blocks_position_nonneg check (position >= 0),
  constraint packet_blocks_shape check (
    (block_type = 'item'
       and item_id is not null
       and heading_text is null
       and heading_subtext is null)
    or
    (block_type in ('heading', 'subheading')
       and item_id is null
       and heading_text is not null
       and btrim(heading_text) <> '')
    or
    (block_type = 'label'
       and item_id is null
       and heading_text is not null
       and btrim(heading_text) <> ''
       and heading_subtext is null)
  ),
  constraint packet_blocks_position_unique unique (packet_id, position)
    deferrable initially deferred
);

create unique index packet_blocks_one_item_per_packet
  on public.packet_blocks (packet_id, item_id)
  where block_type = 'item';

create index idx_packet_blocks_packet_position
  on public.packet_blocks (packet_id, position);

create trigger update_packet_blocks_updated_at
  before update on public.packet_blocks
  for each row execute function public.update_updated_at();

-- ------------------------------------------------------------
-- 3. RLS — public may SELECT blocks of PUBLISHED packets (mirrors item policies).
--    All writes go through the SECURITY DEFINER RPCs below, never directly.
-- ------------------------------------------------------------
alter table public.packet_blocks enable row level security;

create policy "Public can view blocks of published packets"
  on public.packet_blocks for select
  using (
    exists (
      select 1 from public.packets
      where packets.id = packet_blocks.packet_id
        and packets.status = 'published'
    )
  );

-- ------------------------------------------------------------
-- 4. Table privileges — start from nothing (defeat Supabase default grants),
--    then grant ONLY RLS-gated SELECT. INSERT/UPDATE/DELETE stay revoked for
--    every API role, including service_role.
-- ------------------------------------------------------------
revoke all on public.packet_blocks from public, anon, authenticated, service_role;
grant select on public.packet_blocks to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Locking helper — lock the given packet rows FOR KEY SHARE in deterministic
--    ascending id order (dedup, skip nulls) and report whether any is in block
--    mode. FOR KEY SHARE waits behind a conversion's FOR UPDATE (so a structural
--    write blocks until conversion commits and then observes the FINAL mode),
--    yet does NOT conflict with ordinary FOR NO KEY UPDATE packet updates — e.g.
--    the legacy insert_items_into_section RPC, which inserts item rows (this
--    trigger) and then updates non-key packet content (raw_input). Using FOR
--    SHARE here would deadlock two concurrent such appends. A missing packet row
--    (mid-cascade teardown) contributes nothing -> allowed.
-- ------------------------------------------------------------
create or replace function public.packets_in_block_mode(p_ids uuid[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_mode text;
  v_blocks boolean := false;
begin
  for v_id in
    select distinct x from unnest(p_ids) as t(x) where x is not null order by x
  loop
    v_mode := null;
    select composition_mode into v_mode from public.packets where id = v_id for key share;
    if v_mode = 'blocks' then
      v_blocks := true;
    end if;
  end loop;
  return v_blocks;
end;
$$;

-- ------------------------------------------------------------
-- 6. Cross-packet item-ownership guard — immediate, non-deferrable.
--    Rejects any item block whose item belongs to a different packet, on both
--    INSERT and UPDATE, regardless of writer.
-- ------------------------------------------------------------
create or replace function public.assert_block_item_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.block_type = 'item' then
    select s.packet_id into v_owner
      from public.items i
      join public.sections s on s.id = i.section_id
      where i.id = new.item_id;
    if v_owner is null then
      raise exception 'packet_blocks: item % not found', new.item_id;
    end if;
    if v_owner <> new.packet_id then
      raise exception 'packet_blocks: item % belongs to packet %, not %', new.item_id, v_owner, new.packet_id;
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger trg_block_item_ownership
  after insert or update on public.packet_blocks
  not deferrable
  for each row
  execute function public.assert_block_item_ownership();

-- ------------------------------------------------------------
-- 7. Complete structural freeze of SECTIONS while their packet is in block mode:
--    reject INSERT, DELETE, and every UPDATE (title/description included).
--    UPDATE checks BOTH old and new packet ownership (covers a packet_id change),
--    locking both in deterministic order. Cascade-safe (packet gone -> allowed).
-- ------------------------------------------------------------
create or replace function public.freeze_sections_in_block_mode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.packets_in_block_mode(array[new.packet_id]) then
      raise exception 'sections are frozen: cannot INSERT a section into a block-mode packet';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if public.packets_in_block_mode(array[old.packet_id]) then
      raise exception 'sections are frozen: cannot DELETE a section of a block-mode packet';
    end if;
    return old;
  else -- UPDATE (any column, including title/description; also a packet_id change)
    if public.packets_in_block_mode(array[old.packet_id, new.packet_id]) then
      raise exception 'sections are frozen: cannot UPDATE a section of a block-mode packet';
    end if;
    return new;
  end if;
end;
$$;

create trigger trg_freeze_sections
  before insert or update or delete on public.sections
  for each row execute function public.freeze_sections_in_block_mode();

-- ------------------------------------------------------------
-- 8. Legacy ITEM freeze while their packet is in block mode: reject INSERT,
--    DELETE, section_id changes and sort_order changes. Ordinary CONTENT edits
--    (title/address/description/notes) remain allowed. A section_id change is
--    structural and checks BOTH the source and destination packets. Cascade-safe.
-- ------------------------------------------------------------
create or replace function public.freeze_items_in_block_mode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src uuid;
  v_dst uuid;
begin
  if tg_op = 'INSERT' then
    select s.packet_id into v_dst from public.sections s where s.id = new.section_id;
    if public.packets_in_block_mode(array[v_dst]) then
      raise exception 'items are frozen: cannot INSERT an item into a block-mode packet';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select s.packet_id into v_src from public.sections s where s.id = old.section_id;
    if public.packets_in_block_mode(array[v_src]) then
      raise exception 'items are frozen: cannot DELETE an item of a block-mode packet';
    end if;
    return old;
  else -- UPDATE
    if new.section_id is distinct from old.section_id then
      select s.packet_id into v_src from public.sections s where s.id = old.section_id;
      select s.packet_id into v_dst from public.sections s where s.id = new.section_id;
      if public.packets_in_block_mode(array[v_src, v_dst]) then
        raise exception 'items are frozen: section_id cannot change for a block-mode packet';
      end if;
    elsif new.sort_order is distinct from old.sort_order then
      select s.packet_id into v_src from public.sections s where s.id = old.section_id;
      if public.packets_in_block_mode(array[v_src]) then
        raise exception 'items are frozen: sort_order cannot change for a block-mode packet';
      end if;
    end if;
    -- content-only edits (title/address/description/notes) are allowed
    return new;
  end if;
end;
$$;

create trigger trg_freeze_items
  before insert or update or delete on public.items
  for each row execute function public.freeze_items_in_block_mode();

-- ------------------------------------------------------------
-- 9. Consistency assertion — bijection between a block-mode packet's items and
--    its item blocks, plus positions EXACTLY {0 .. n-1} (dense), including the
--    zero-block case (empty is vacuously dense). Raises on any violation.
-- ------------------------------------------------------------
create or replace function public.assert_packet_block_consistency(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_blocks int;
  v_items int;
  v_count int;
  v_min int;
  v_max int;
begin
  select count(*) into v_item_blocks
    from public.packet_blocks where packet_id = p_packet_id and block_type = 'item';
  select count(*) into v_items
    from public.items i join public.sections s on s.id = i.section_id
    where s.packet_id = p_packet_id;
  if v_item_blocks <> v_items then
    raise exception 'consistency: packet % has % items but % item blocks', p_packet_id, v_items, v_item_blocks;
  end if;

  -- every packet item is referenced by a block (with equal counts + the
  -- one-item-per-packet unique index, this is a bijection)
  if exists (
    select 1 from public.items i join public.sections s on s.id = i.section_id
    where s.packet_id = p_packet_id
      and not exists (
        select 1 from public.packet_blocks b
        where b.packet_id = p_packet_id and b.block_type = 'item' and b.item_id = i.id
      )
  ) then
    raise exception 'consistency: packet % has an item with no block', p_packet_id;
  end if;

  -- positions must be EXACTLY {0 .. n-1}. With CHECK(position>=0) and
  -- UNIQUE(packet_id,position), min=0 and max=n-1 imply exactly 0..n-1.
  select count(*), min(position), max(position)
    into v_count, v_min, v_max
    from public.packet_blocks where packet_id = p_packet_id;
  if v_count = 0 then
    return; -- no blocks: vacuously dense
  end if;
  if v_min <> 0 or v_max <> v_count - 1 then
    raise exception 'consistency: packet % positions not dense 0..% (min %, max %, count %)',
      p_packet_id, v_count - 1, v_min, v_max, v_count;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 10. Composition-mode transition guard (DB-level; applies to ANY writer).
--     - new packets must be created in legacy mode;
--     - a mode change is REJECTED unless it is authorized by the controlled RPC
--       for THIS packet (see the transaction-local GUC below), so a direct
--       service-role UPDATE of composition_mode always fails, even if the rows
--       happen to look consistent;
--     - legacy -> blocks only for a draft packet with a complete, consistent
--       block representation;
--     - blocks -> legacy only for a draft packet after block rows are removed;
--     - any other transition/value is rejected.
--     Ordinary legacy edits (no mode change) never invoke this (WHEN clauses).
--
--     RPC-only authorization: convert/revert call set_config(
--       'app.block_transition_authorized_packet', <packet id>, is_local => true)
--     immediately before their mode UPDATE and clear it immediately after.
--     is_local scopes it to the current transaction. Ordinary application writes
--     go through PostgREST as a single `UPDATE packets ...` statement in their
--     own transaction with no preceding set_config, so the GUC is unset (null)
--     and the transition is rejected. Only a SECURITY DEFINER function that
--     explicitly sets the GUC can authorize the flip — normal table updates
--     cannot reproduce it.
-- ------------------------------------------------------------
create or replace function public.enforce_packet_mode_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block_count int;
begin
  if tg_op = 'INSERT' then
    -- WHEN clause guarantees new.composition_mode <> 'legacy'
    raise exception 'packets must be created in legacy mode (got %)', new.composition_mode;
  end if;

  -- UPDATE with an actual mode change (guaranteed by WHEN clause).
  -- Reject unless the controlled RPC authorized a transition for THIS packet.
  if current_setting('app.block_transition_authorized_packet', true) is distinct from new.id::text then
    raise exception 'composition_mode may only be changed via convert_packet_to_blocks / revert_packet_to_legacy';
  end if;

  if old.composition_mode = 'legacy' and new.composition_mode = 'blocks' then
    if new.status <> 'draft' then
      raise exception 'composition_mode legacy->blocks requires a draft packet (status=%)', new.status;
    end if;
    perform public.assert_packet_block_consistency(new.id);
  elsif old.composition_mode = 'blocks' and new.composition_mode = 'legacy' then
    if new.status <> 'draft' then
      raise exception 'composition_mode blocks->legacy requires a draft packet (status=%)', new.status;
    end if;
    select count(*) into v_block_count from public.packet_blocks where packet_id = new.id;
    if v_block_count <> 0 then
      raise exception 'composition_mode blocks->legacy requires block rows removed first (found %)', v_block_count;
    end if;
  else
    raise exception 'invalid composition_mode transition % -> %', old.composition_mode, new.composition_mode;
  end if;
  return null;
end;
$$;

create constraint trigger trg_packet_mode_insert
  after insert on public.packets
  not deferrable
  for each row
  when (new.composition_mode <> 'legacy')
  execute function public.enforce_packet_mode_transition();

create constraint trigger trg_packet_mode_update
  after update on public.packets
  not deferrable
  for each row
  when (old.composition_mode is distinct from new.composition_mode)
  execute function public.enforce_packet_mode_transition();

-- ------------------------------------------------------------
-- 11. Temporary (until R1C): block-mode packets must remain draft. Prevents
--     publishing a block packet before the block renderer and block-publish
--     validation ship. Legacy publishing is unaffected. R1C will drop this.
-- ------------------------------------------------------------
create or replace function public.enforce_block_mode_draft_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- WHEN clause guarantees new.composition_mode='blocks' and new.status<>'draft'
  raise exception 'block-mode packets must remain draft until the block renderer ships (status=%)', new.status;
end;
$$;

create constraint trigger trg_block_mode_draft_only
  after insert or update on public.packets
  not deferrable
  for each row
  when (new.composition_mode = 'blocks' and new.status <> 'draft')
  execute function public.enforce_block_mode_draft_only();

-- ------------------------------------------------------------
-- 12. convert_packet_to_blocks — legacy -> blocks, concurrency-safe & atomic.
--     Locks the packet row FOR UPDATE first, so any concurrent structural write
--     (whose freeze trigger takes FOR SHARE) blocks until this commits and then
--     observes composition_mode='blocks' and is rejected. The item set is thus
--     fixed under the lock: every item gets exactly one block (no missing item
--     blocks). Refuses non-draft/non-legacy/pre-existing-blocks. Section title ->
--     Heading (+ description as optional subtext); items follow in a
--     deterministic (sort_order, id) order. Blank title + blank description ->
--     no heading (matches the renderer). Blank title + non-empty description
--     (description-only) is ambiguous -> raise.
-- ------------------------------------------------------------
create or replace function public.convert_packet_to_blocks(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
  v_existing int;
  v_pos int := 0;
  sec record;
  it record;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'convert: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'convert: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'legacy' then raise exception 'convert: packet % is not in legacy mode (mode=%)', p_packet_id, v_mode; end if;

  select count(*) into v_existing from public.packet_blocks where packet_id = p_packet_id;
  if v_existing <> 0 then raise exception 'convert: packet % unexpectedly already has % block rows', p_packet_id, v_existing; end if;

  for sec in
    select id, title, description from public.sections where packet_id = p_packet_id order by sort_order, id
  loop
    if btrim(coalesce(sec.title, '')) <> '' then
      insert into public.packet_blocks (packet_id, position, block_type, heading_text, heading_subtext)
      values (p_packet_id, v_pos, 'heading', sec.title, nullif(btrim(coalesce(sec.description, '')), ''));
      v_pos := v_pos + 1;
    elsif btrim(coalesce(sec.description, '')) <> '' then
      raise exception 'convert: packet % has a description-only section % (blank title, non-empty description); ambiguous — refusing', p_packet_id, sec.id;
    end if;
    -- blank title AND blank description -> omit the heading block (renderer shows no header)

    for it in
      select id from public.items where section_id = sec.id order by sort_order, id
    loop
      insert into public.packet_blocks (packet_id, position, block_type, item_id)
      values (p_packet_id, v_pos, 'item', it.id);
      v_pos := v_pos + 1;
    end loop;
  end loop;

  -- Authorize exactly this mode flip (transaction-local), flip, then clear the
  -- authorization. The transition guard (10) re-validates the draft requirement
  -- and completeness/consistency, and rejects any unauthorized change.
  perform set_config('app.block_transition_authorized_packet', p_packet_id::text, true);
  update public.packets set composition_mode = 'blocks' where id = p_packet_id;
  perform set_config('app.block_transition_authorized_packet', '', true);
end;
$$;

-- ------------------------------------------------------------
-- 13. revert_packet_to_legacy — blocks -> legacy, concurrency-safe & atomic.
--     Locks the packet FOR UPDATE, refuses non-draft/non-block, deletes all
--     block rows, then flips mode. The legacy sections/items were frozen
--     throughout block mode, so the packet renders as an identical legacy
--     composition (block-only headings and block order are discarded;
--     item-content edits persist because content lives in the item rows).
-- ------------------------------------------------------------
create or replace function public.revert_packet_to_legacy(p_packet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_mode text;
begin
  select status, composition_mode into v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_status is null then raise exception 'revert: packet % not found', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'revert: packet % is not draft (status=%)', p_packet_id, v_status; end if;
  if v_mode <> 'blocks' then raise exception 'revert: packet % is not in block mode (mode=%)', p_packet_id, v_mode; end if;

  delete from public.packet_blocks where packet_id = p_packet_id;
  -- Authorize exactly this mode flip (transaction-local), flip, then clear it.
  perform set_config('app.block_transition_authorized_packet', p_packet_id::text, true);
  update public.packets set composition_mode = 'legacy' where id = p_packet_id;
  perform set_config('app.block_transition_authorized_packet', '', true);
end;
$$;

-- ------------------------------------------------------------
-- 14. Function privileges — no default PUBLIC execute; grant only what's needed.
--     Trigger/helper functions are invoked internally (no direct execute grant);
--     triggers still fire regardless of execute grants.
-- ------------------------------------------------------------
revoke all on function public.packets_in_block_mode(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.assert_block_item_ownership() from public, anon, authenticated, service_role;
revoke all on function public.freeze_sections_in_block_mode() from public, anon, authenticated, service_role;
revoke all on function public.freeze_items_in_block_mode() from public, anon, authenticated, service_role;
revoke all on function public.enforce_packet_mode_transition() from public, anon, authenticated, service_role;
revoke all on function public.enforce_block_mode_draft_only() from public, anon, authenticated, service_role;
revoke all on function public.assert_packet_block_consistency(uuid) from public, anon, authenticated, service_role;
revoke all on function public.convert_packet_to_blocks(uuid) from public, anon, authenticated, service_role;
revoke all on function public.revert_packet_to_legacy(uuid) from public, anon, authenticated, service_role;

grant execute on function public.convert_packet_to_blocks(uuid) to service_role;
grant execute on function public.revert_packet_to_legacy(uuid) to service_role;
grant execute on function public.assert_packet_block_consistency(uuid) to service_role;
