-- ============================================================================
-- 0008 — Allow safe block-mode publishing (R1C-B)
--
-- R1A (0007) shipped a TEMPORARY rule (trg_block_mode_draft_only) that forbade
-- any block-mode packet from leaving draft, so nothing could be published before
-- the block renderer existed. The renderer and the block-aware publish route
-- shipped in R1C-A. This migration removes that temporary rule and replaces it
-- with a permanent DB backstop that lets a block-mode packet be published ONLY
-- when its block composition is valid and consistent.
--
-- Scope — this migration ONLY swaps the draft-only rule for a publish-consistency
-- rule. It does NOT touch, and deliberately preserves:
--   * the composition-mode transition guard (enforce_packet_mode_transition) and
--     its RPC-only GUC authorization;
--   * the block/item ownership constraint trigger (assert_block_item_ownership);
--   * the structural freeze of legacy sections/items in block mode
--     (freeze_sections_in_block_mode / freeze_items_in_block_mode);
--   * controlled block writes (all DML on packet_blocks revoked; changes only via
--     the SECURITY DEFINER convert/revert RPCs);
--   * packet_blocks RLS (public SELECT gated on packets.status='published');
--   * URLs, privacy behavior, published_at, and the identity snapshot.
--
-- Legacy publishing is completely unaffected: every rule added here is gated on
-- composition_mode='blocks', which legacy packets never match.
--
-- Runs safely as a single transaction.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Remove the temporary R1A draft-only rule for block packets.
--    (Trigger first, then the now-unreferenced function.)
-- ----------------------------------------------------------------------------
drop trigger if exists trg_block_mode_draft_only on public.packets;
drop function if exists public.enforce_block_mode_draft_only();

-- ----------------------------------------------------------------------------
-- 2. Permanent block-publish consistency gate.
--
--    A block-mode packet may transition INTO 'published' only when:
--      (a) assert_packet_block_consistency(id) passes — the item-block/item
--          bijection holds and positions are exactly dense 0..n-1; this also
--          guarantees every referenced item exists and belongs to the packet
--          (existence is additionally guaranteed by assert_block_item_ownership);
--      (b) there is at least one item block (consistency alone is vacuously true
--          for an empty packet, so this is checked explicitly);
--      (c) every item referenced by an item block has a nonblank title.
--    Any failure raises and aborts the publish. An inconsistent or empty block
--    packet therefore cannot be published.
--
--    Design notes (reviewed for R1C-B):
--    * Status-only publish is safe to validate here. Block rows are immutable
--      except through the convert/revert RPCs, which take FOR UPDATE on the
--      packet row; the publish UPDATE takes the same row lock, so a concurrent
--      convert/revert serializes and this AFTER trigger always observes a stable,
--      final block set. The assertion reads (never writes) block/item rows.
--    * The application publish route remains authoritative for the VALUES of a
--      normal publish — it sets published_at and the professional_snapshot and
--      runs its own block validation. This trigger only enforces the INVARIANT
--      (consistency); it does not set published_at or the snapshot. Legacy and
--      block publishing are thus enforced at the same level: app route for
--      values, DB backstop for correctness.
--    * At this stage we enforce consistency only; we do NOT additionally require
--      the publish to have gone through the app flow (e.g. by demanding a
--      non-null published_at). Legacy publishing has no such DB requirement, and
--      publishing — unlike a composition-mode change — is not structurally
--      dangerous, so requiring block publishing to prove "publish flow" at the DB
--      would make it stricter than legacy without benefit. A direct service-role
--      status flip on a CONSISTENT block packet would succeed but leave
--      published_at/snapshot unset (a degraded, not corrupt, state); direct DB
--      writes are an out-of-band admin action, not reachable from the app.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_block_publish_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_blocks int;
begin
  -- WHEN clause guarantees: new.composition_mode='blocks', new.status='published',
  -- and this UPDATE is the transition INTO published.

  -- (a) bijection + dense positions
  perform public.assert_packet_block_consistency(new.id);

  -- (b) at least one item block
  select count(*) into v_item_blocks
    from public.packet_blocks
    where packet_id = new.id and block_type = 'item';
  if v_item_blocks = 0 then
    raise exception 'block publish: packet % has no item blocks; add at least one item before publishing', new.id;
  end if;

  -- (c) every referenced item has a nonblank title
  if exists (
    select 1
    from public.packet_blocks b
    join public.items i on i.id = b.item_id
    where b.packet_id = new.id
      and b.block_type = 'item'
      and btrim(coalesce(i.title, '')) = ''
  ) then
    raise exception 'block publish: packet % has an item block whose item has a blank title', new.id;
  end if;

  return null;
end;
$$;

-- Fire only on the transition INTO published for a block packet. A block packet
-- can never be INSERTed (the transition guard forces creation in legacy mode),
-- so an UPDATE trigger is sufficient. Unpublishing (published -> draft) and
-- edits to an already-published packet do not match this WHEN clause, so
-- unpublishing a consistent block packet back to draft stays possible.
create constraint trigger trg_block_publish_consistency
  after update on public.packets
  not deferrable
  for each row
  when (
    new.composition_mode = 'blocks'
    and new.status = 'published'
    and old.status is distinct from 'published'
  )
  execute function public.enforce_block_publish_consistency();

-- ----------------------------------------------------------------------------
-- 3. Function privileges — mirror the other internal enforcement functions:
--    no direct execute for any API role. Trigger functions fire regardless of
--    execute grants; this only prevents a direct RPC call to it.
-- ----------------------------------------------------------------------------
revoke all on function public.enforce_block_publish_consistency() from public, anon, authenticated, service_role;
