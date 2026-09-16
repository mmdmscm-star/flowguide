-- ============================================================================
-- ROLLBACK FOR 0056. Not a migration; kept outside supabase/rollbacks' peers.
--
-- ORDER MATTERS. Revert and deploy the app change FIRST: without
-- redeem_bound_invite an invitation link can no longer create an account.
--
-- Returns redeem_invite to its self-contained 0055 body, drops the invitation
-- functions, the approval columns and the reservation column. REFUSES while any
-- live reserved invite exists: dropping the column would turn it into a row
-- nobody can ever redeem (no code, no reservation). Revoke them first, and tell
-- anyone holding an invitation that it is withdrawn.
--
-- Accounts, typed codes and early-access requests are untouched.
-- ============================================================================

begin;

do $$
declare n int;
begin
  select count(*) into n from public.invite_codes where email is not null and used_at is null and revoked_at is null;
  if n > 0 then
    raise exception 'ROLLBACK 0056 REFUSED: % reserved invitation(s) are still live. Revoke them first.', n;
  end if;
end $$;

-- redeem_invite, exactly as 0055 wrote it.
create or replace function public.redeem_invite(p_magic_token text, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link record; v_user uuid; v_invite uuid;
begin
  select id, email, used, expires_at into v_link
    from public.magic_links where token = p_magic_token for update;
  if v_link.id is null or v_link.used or v_link.expires_at <= now() then
    raise exception 'redeem: the sign-in link is not valid' using errcode = 'PT401', detail = 'link_invalid';
  end if;

  -- An account already exists: sign in to it. The code is not looked at.
  select id into v_user from public.users where email = v_link.email;
  if v_user is not null then
    update public.magic_links set used = true where id = v_link.id;
    return jsonb_build_object('userId', v_user, 'created', false);
  end if;

  -- One refusal for unknown, used, revoked and malformed codes alike.
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'redeem: the invite code is not valid' using errcode = 'PT403', detail = 'invite_invalid';
  end if;
  select id into v_invite
    from public.invite_codes
   where code_hash = p_code_hash and used_at is null and revoked_at is null
     for update;
  if v_invite is null then
    raise exception 'redeem: the invite code is not valid' using errcode = 'PT403', detail = 'invite_invalid';
  end if;

  begin
    insert into public.users (email) values (v_link.email) returning id into v_user;
  exception when unique_violation then
    -- Another link for the same email created the account first. Sign in to
    -- it; this invite stays unused.
    select id into v_user from public.users where email = v_link.email;
    update public.magic_links set used = true where id = v_link.id;
    return jsonb_build_object('userId', v_user, 'created', false);
  end;

  insert into public.professional_profiles (user_id, email) values (v_user, v_link.email);
  update public.invite_codes set used_at = now(), used_by = v_user where id = v_invite;
  update public.magic_links set used = true where id = v_link.id;

  return jsonb_build_object('userId', v_user, 'created', true);
end;
$$;

drop function public.redeem_bound_invite(text);
drop function public.approve_early_access_request(uuid);
drop function public.record_invitation_sent(uuid);
drop function public.consume_link_and_create_account(uuid, text, uuid);

alter table public.early_access_requests
  drop constraint early_access_requests_sent_only_when_approved,
  drop column invitation_sent_at,
  drop column invite_id,
  drop column approved_at;

-- Spent and revoked reservations have no code_hash, and 0055's column is NOT
-- NULL. They are history, not credentials, so each keeps its row with a random
-- placeholder nobody can ever produce: these invites are already unusable.
update public.invite_codes
   set code_hash = encode(sha256(convert_to('spent-reservation:' || id::text || ':' || gen_random_uuid()::text, 'UTF8')), 'hex')
 where code_hash is null;

drop index public.invite_codes_one_live_reservation_per_email;
alter table public.invite_codes
  drop constraint invite_codes_code_or_reservation,
  drop constraint invite_codes_email_shape,
  drop column email,
  alter column code_hash set not null;

do $$
begin
  if to_regprocedure('public.redeem_bound_invite(text)') is not null
     or to_regprocedure('public.approve_early_access_request(uuid)') is not null
     or to_regprocedure('public.record_invitation_sent(uuid)') is not null
     or to_regprocedure('public.consume_link_and_create_account(uuid,text,uuid)') is not null
     or exists (select 1 from information_schema.columns where table_schema='public' and table_name='invite_codes' and column_name='email')
     or exists (select 1 from information_schema.columns where table_schema='public' and table_name='early_access_requests' and column_name='approved_at') then
    raise exception 'ROLLBACK 0056 INCOMPLETE: an 0056 object survived.';
  end if;
end $$;

commit;
