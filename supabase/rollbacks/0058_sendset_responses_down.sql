-- ============================================================================
-- ROLLBACK FOR 0058. Not a migration; kept outside supabase/migrations.
--
-- ORDER MATTERS. Revert and deploy the application FIRST. Without these objects
-- the response endpoint, the owner's list and the dashboard count all fail.
--
-- REFUSES WHILE ANY RESPONSE EXISTS. A response is somebody's words to a
-- professional, and dropping these tables destroys every one of them with no
-- copy anywhere else. If that is really intended, delete the rows first as a
-- separate, deliberate act — this script will not do it as a side effect.
-- ============================================================================

begin;

set local lock_timeout = '3s';

do $$
declare n int;
begin
  if to_regclass('public.sendset_responses') is not null then
    select count(*) into n from public.sendset_responses;
    if n > 0 then
      raise exception 'ROLLBACK 0058 REFUSED: % response(s) exist. They would be destroyed. Delete them deliberately first.', n;
    end if;
  end if;
end $$;

drop function if exists public.mark_sendset_response_notified(uuid);
drop function if exists public.record_sendset_response(text, text, text, text, text);
drop table if exists public.sendset_response_lines;
drop table if exists public.sendset_responses;

alter table public.packets drop constraint if exists packets_response_actions_known;
alter table public.packets drop column if exists response_actions;

do $$
begin
  if to_regclass('public.sendset_responses') is not null
     or to_regclass('public.sendset_response_lines') is not null
     or to_regprocedure('public.record_sendset_response(text,text,text,text,text)') is not null
     or to_regprocedure('public.mark_sendset_response_notified(uuid)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'packets'
                   and column_name = 'response_actions') then
    raise exception 'ROLLBACK 0058 INCOMPLETE: an 0058 object survived.';
  end if;
end $$;

commit;
