-- ============================================================================
-- ROLLBACK FOR 0055. Not a migration; kept outside supabase/migrations.
--
-- ORDER MATTERS. Revert and deploy the app change FIRST: once verify stops
-- creating accounts, dropping redeem_invite leaves no way to create one.
--
-- Drops the purge job, redeem_invite and both tables — which DELETES every
-- invite code (used or not) and every early-access request. Accounts created
-- through invites are untouched. Refuses while any unused, unrevoked invite
-- exists, so outstanding codes are not silently destroyed; revoke them first
-- if that is intended.
-- ============================================================================

begin;

do $$
declare n int;
begin
  select count(*) into n from public.invite_codes where used_at is null and revoked_at is null;
  if n > 0 then
    raise exception 'ROLLBACK 0055 REFUSED: % unused invite code(s) exist. Revoke them first if they should stop working.', n;
  end if;
end $$;

select cron.unschedule('sendset-purge-early-access-requests')
 where exists (select 1 from cron.job where jobname = 'sendset-purge-early-access-requests');

drop function public.redeem_invite(text, text);
drop table public.early_access_requests;
drop table public.invite_codes;

do $$
begin
  if to_regprocedure('public.redeem_invite(text,text)') is not null
     or to_regclass('public.invite_codes') is not null
     or to_regclass('public.early_access_requests') is not null
     or exists (select 1 from cron.job where jobname = 'sendset-purge-early-access-requests') then
    raise exception 'ROLLBACK 0055 INCOMPLETE: an 0055 object survived.';
  end if;
end $$;

commit;
