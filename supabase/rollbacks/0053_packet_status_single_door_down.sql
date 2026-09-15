-- ============================================================================
-- ROLLBACK FOR 0053. Not a migration; kept outside supabase/migrations.
--
-- Drops the single-door trigger and its function. Touches no row. Safe at any
-- time: publish_packet and unpublish_packet keep working without it, and no
-- application code writes a status directly (ownership-route.test). What is lost
-- is only the database's own refusal of a status change made any other way.
-- ============================================================================

begin;

drop trigger trg_packet_status_single_door on public.packets;
drop function public.enforce_packet_status_single_door();

do $$
begin
  if to_regprocedure('public.enforce_packet_status_single_door()') is not null
     or exists (select 1 from pg_trigger where tgname = 'trg_packet_status_single_door') then
    raise exception 'ROLLBACK 0053 INCOMPLETE: a 0053 object survived.';
  end if;
end $$;

commit;
