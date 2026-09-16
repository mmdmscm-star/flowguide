-- ============================================================================
-- ROLLBACK FOR 0057. Not a migration; kept outside supabase/migrations.
--
-- ORDER MATTERS. Revert and deploy the app change FIRST. Without view_count the
-- dashboard has nothing to render a count from, and the view endpoint's RPC is
-- gone.
--
-- THE COUNTS ARE LOST, and cannot be recovered: they live only in this column,
-- which is the point of a design with no per-view rows. `viewed` is untouched
-- by both 0057 and this rollback — it was left in place precisely so that
-- reverting the application restores a working binary badge.
-- ============================================================================

begin;

drop function if exists public.record_packet_view(text);

alter table public.packets
  drop column if exists view_count;

do $$
begin
  if to_regprocedure('public.record_packet_view(text)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'packets'
                   and column_name = 'view_count') then
    raise exception 'ROLLBACK 0057 INCOMPLETE: an 0057 object survived.';
  end if;
  -- The legacy column the application falls back to must still be there.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'packets'
                    and column_name = 'viewed') then
    raise exception 'ROLLBACK 0057 REFUSED: packets.viewed is gone, so there is nothing to revert to.';
  end if;
end $$;

commit;
