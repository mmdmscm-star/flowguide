-- 0019 — drop library_insert_item_block, applied in 0018 and found unreachable.
--
-- 0018 IS NOT AMENDED. It remains byte-for-byte the file that was integrity-
-- checked and applied on 2026-08-18:
--
--   sha256  027d6399f3dbd6afb1550b2f5f07e72bca19baf3eff2cba8d6510258d089ec6e
--   158 lines, 7654 bytes
--
-- An applied migration is a record of what was run. Editing one after the fact
-- — even only its comments — breaks the chain that made the hash worth checking,
-- and leaves the repository unable to prove what production actually received.
-- So the entire explanation lives HERE, in the migration that corrects it, and
-- in docs/roadmap.md. This file is the amendment.
--
-- WHY IT IS GOING. The function is correct in every respect except that it can
-- never succeed. trg_freeze_items (0007) rejects INSERT for any item whose
-- packet is in block mode — composition there is owned by packet_blocks and the
-- items/sections substrate is deliberately frozen — so the function's first
-- write always raises:
--
--   "items are frozen: cannot INSERT an item into a block-mode packet"
--
-- A live function whose name promises supported block-mode insertion, which can
-- only ever raise, is worse than no function: the next reader will believe the
-- capability exists.
--
-- WHAT IS DELIBERATELY NOT TOUCHED. trg_freeze_items and trg_freeze_sections
-- stay exactly as they are. They are not the defect — they are the invariant,
-- and the reason this function cannot work. Revisiting them is a composition
-- project, recorded as the first Library follow-up.
--
-- HOW IT WAS ESTABLISHED, preserved here since 0018 cannot carry it. The design
-- traced where packet_blocks item rows are created — exactly one place,
-- convert_packet_to_blocks (0007) — and concluded the only gap was a missing
-- block row. It never asked the prior question: may an ITEM row be created in a
-- block packet at all? It may not. 0018's runtime proof failed on its first
-- write with the freeze error above.
--
-- Two things held even as it failed, and both are worth keeping: the packet was
-- left completely untouched — no orphan item, no orphan block,
-- assert_packet_block_consistency still passing — and cleanup was clean. The
-- atomicity 0018 was written for held while the function itself could not run.
--
-- Nothing calls this function: the route refuses block-mode packets before any
-- write, and no Library affordance is offered in the block editor.

begin;

set local lock_timeout = '3s';

drop function if exists public.library_insert_item_block(uuid, uuid, uuid, uuid);

do $verify$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'library_insert_item_block'
  ) then
    raise exception '0019: library_insert_item_block still exists';
  end if;

  -- The freeze must survive this migration untouched. Dropping the function is
  -- the correction; weakening the invariant would be the opposite of it.
  if not exists (select 1 from pg_trigger where tgname = 'trg_freeze_items' and not tgisinternal) then
    raise exception '0019: trg_freeze_items is missing — the block-mode freeze must remain';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_freeze_sections' and not tgisinternal) then
    raise exception '0019: trg_freeze_sections is missing — the block-mode freeze must remain';
  end if;

  -- 0017's Library surface is unaffected by this.
  if to_regclass('public.library_items') is null then
    raise exception '0019: library_items should not have been touched';
  end if;

  raise notice '0019: library_insert_item_block dropped; block-mode freeze intact; library_items untouched';
end
$verify$;

commit;

notify pgrst, 'reload schema';
