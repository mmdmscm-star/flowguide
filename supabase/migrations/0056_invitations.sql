-- ============================================================================
-- 0056 — AN APPROVED REQUEST BECOMES AN INVITATION, AND THE INVITATION IS THE LINK.
--
-- 0055 made a new account cost a single-use code the person had to type. That
-- is right for a direct invitation and wrong for the ordinary path: someone who
-- asked for access had to wait, receive a code, find the sign-in page, ask for a
-- magic link, come back and paste the code.
--
-- So an invite may now be RESERVED FOR ONE EMAIL (invite_codes.email). A
-- reserved invite has no code to type — it is claimed by proving control of
-- that address, which is exactly what a magic link already proves:
--
--   founder    approve a request -> reserve an invite for its email, send a
--              7-day magic link in a "You're invited to Sendset" email
--   requester  open it -> a page (no side effects) -> Get started -> the link
--              is verified and the reserved invite consumed in ONE transaction
--
-- Nothing about typed codes changes: an invite with email NULL is exactly the
-- 0055 invite, redeemed by redeem_invite through /join. That stays the escape
-- hatch for direct and offline invitations.
--
--   public.consume_link_and_create_account   the account-creation body BOTH
--       redemptions share, so they cannot drift apart. Owner-only.
--   public.redeem_invite(token, code_hash)   replaced in place to call it;
--       same signature, same behaviour, so its grants survive.
--   public.redeem_bound_invite(token)        claims the invite reserved for the
--       link's own address. PT403 no_invitation when there is none.
--   public.approve_early_access_request(id)  reserves the invite and records the
--       approval, once. PT404 not_found.
--   public.record_invitation_sent(id)        notes that the email went out.
--
-- GRANTS: nothing for anon or authenticated. service_role executes the three
-- routes' functions; it still has no UPDATE on either table, so approval and
-- consumption happen only inside these functions.
--
-- ROLLBACK: supabase/rollbacks/0056_invitations_down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.invite_codes') is null or to_regclass('public.early_access_requests') is null
     or to_regprocedure('public.redeem_invite(text,text)') is null then
    raise exception 'MIGRATION 0056 ABORTED: 0055 is not installed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='invite_codes' and column_name='email')
     or to_regprocedure('public.redeem_bound_invite(text)') is not null
     or to_regprocedure('public.approve_early_access_request(uuid)') is not null
     or to_regprocedure('public.consume_link_and_create_account(uuid,text,uuid)') is not null then
    raise exception 'MIGRATION 0056 ABORTED: an 0056 object already exists.';
  end if;
end $$;

create temp table _0056_before on commit drop as
  select 'user' as kind, u.id, md5(row(u.*)::text) as v from public.users u
  union all select 'invite', i.id, md5(row(i.*)::text) from public.invite_codes i
  union all select 'request', r.id, md5(row(r.*)::text) from public.early_access_requests r
  union all select 'link', l.id, md5(row(l.*)::text) from public.magic_links l;

-- ---------------------------------------------------------------------------
-- 1. AN INVITE MAY BE RESERVED FOR ONE ADDRESS.
--
-- email NULL  — a typed code, as in 0055: whoever holds it, any address.
-- email set   — no code at all; claimed only by proving control of that address.
-- A code and a reservation are the two ways to hold an invite, so one of them
-- must be present. At most one LIVE reservation per address.
-- ---------------------------------------------------------------------------
alter table public.invite_codes
  add column email text,
  alter column code_hash drop not null,
  add constraint invite_codes_email_shape
    check (email is null or (email = lower(email) and length(email) <= 320
           and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  add constraint invite_codes_code_or_reservation check (code_hash is not null or email is not null);

create unique index invite_codes_one_live_reservation_per_email
  on public.invite_codes (email) where email is not null and used_at is null and revoked_at is null;

comment on column public.invite_codes.email is
  'When set, this invite is reserved for exactly this address and has no code to type: it is claimed by a magic link proving control of the address (0056). NULL is a 0055 typed code.';

-- ---------------------------------------------------------------------------
-- 2. A REQUEST REMEMBERS ITS APPROVAL.
--
-- Deliberately thin: when the request row is purged at 90 days the invite and
-- the account stand on their own.
-- ---------------------------------------------------------------------------
alter table public.early_access_requests
  add column approved_at timestamptz,
  add column invite_id uuid references public.invite_codes(id) on delete set null,
  add column invitation_sent_at timestamptz,
  add constraint early_access_requests_sent_only_when_approved
    check (invitation_sent_at is null or approved_at is not null);

-- ---------------------------------------------------------------------------
-- 3. THE ONE ACCOUNT-CREATION BODY, SHARED BY BOTH REDEMPTIONS.
--
-- Callable by nobody: both callers are SECURITY DEFINER and run as the owner.
-- ---------------------------------------------------------------------------
create function public.consume_link_and_create_account(p_link_id uuid, p_email text, p_invite_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  begin
    insert into public.users (email) values (p_email) returning id into v_user;
  exception when unique_violation then
    -- Another link for the same email created the account first. Sign in to
    -- it; this invite stays unused.
    select id into v_user from public.users where email = p_email;
    update public.magic_links set used = true where id = p_link_id;
    return jsonb_build_object('userId', v_user, 'created', false);
  end;

  insert into public.professional_profiles (user_id, email) values (v_user, p_email);
  update public.invite_codes set used_at = now(), used_by = v_user where id = p_invite_id;
  update public.magic_links set used = true where id = p_link_id;

  return jsonb_build_object('userId', v_user, 'created', true);
end;
$$;

revoke all on function public.consume_link_and_create_account(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. THE TYPED CODE, UNCHANGED — now calling the shared body.
--
-- CREATE OR REPLACE with the same signature: the grants from 0055 survive.
-- A reserved invite is not redeemable here: it has no code_hash to match.
-- ---------------------------------------------------------------------------
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

  return public.consume_link_and_create_account(v_link.id, v_link.email, v_invite);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE RESERVED INVITE: claimed by the link's own address.
--
--   link_invalid    used, expired or unknown link           (PT401)
--   no_invitation   no live invite reserved for that address (PT403)
--
-- The caller must hold the link's token, which only the address it was sent to
-- ever received. Nothing else is accepted as proof.
-- ---------------------------------------------------------------------------
create function public.redeem_bound_invite(p_magic_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link record; v_user uuid; v_invite uuid;
begin
  select id, email, used, expires_at into v_link
    from public.magic_links where token = p_magic_token for update;
  if v_link.id is null or v_link.used or v_link.expires_at <= now() then
    raise exception 'redeem: the sign-in link is not valid' using errcode = 'PT401', detail = 'link_invalid';
  end if;

  select id into v_user from public.users where email = v_link.email;
  if v_user is not null then
    update public.magic_links set used = true where id = v_link.id;
    return jsonb_build_object('userId', v_user, 'created', false);
  end if;

  select id into v_invite
    from public.invite_codes
   where email = v_link.email and used_at is null and revoked_at is null
     for update;
  if v_invite is null then
    -- The account may have appeared while this statement waited on the lock:
    -- two links for one address, clicked together. The invitation is spent, and
    -- the right answer for the second click is the account it paid for.
    select id into v_user from public.users where email = v_link.email;
    if v_user is not null then
      update public.magic_links set used = true where id = v_link.id;
      return jsonb_build_object('userId', v_user, 'created', false);
    end if;
    raise exception 'redeem: no invitation is waiting for this address' using errcode = 'PT403', detail = 'no_invitation';
  end if;

  return public.consume_link_and_create_account(v_link.id, v_link.email, v_invite);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. APPROVAL: reserve one invite for the requested address, once.
--
--   approved         the invite is reserved and the request records it
--   already_approved pressed twice: the SAME invite, so no second invitation
--   has_account      that address can already sign in; no invite is made
-- ---------------------------------------------------------------------------
create function public.approve_early_access_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_req record; v_invite uuid; v_user uuid;
begin
  select id, email, approved_at, invite_id, invitation_sent_at into v_req
    from public.early_access_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'approve: no such request' using errcode = 'PT404', detail = 'not_found';
  end if;
  if v_req.approved_at is not null then
    return jsonb_build_object('status', 'already_approved', 'email', v_req.email,
                              'inviteId', v_req.invite_id, 'invitationSentAt', v_req.invitation_sent_at);
  end if;

  select id into v_user from public.users where email = v_req.email;
  if v_user is not null then
    update public.early_access_requests set approved_at = now() where id = v_req.id;
    return jsonb_build_object('status', 'has_account', 'email', v_req.email);
  end if;

  -- A live reservation for this address is reused rather than duplicated (the
  -- unique index refuses a second one anyway).
  select id into v_invite from public.invite_codes
   where email = v_req.email and used_at is null and revoked_at is null for update;
  if v_invite is null then
    insert into public.invite_codes (email, label) values (v_req.email, 'early access: ' || v_req.email)
      returning id into v_invite;
  end if;

  update public.early_access_requests set approved_at = now(), invite_id = v_invite where id = v_req.id;
  return jsonb_build_object('status', 'approved', 'email', v_req.email, 'inviteId', v_invite);
end;
$$;

create function public.record_invitation_sent(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sent timestamptz;
begin
  update public.early_access_requests set invitation_sent_at = now()
   where id = p_request_id and approved_at is not null
   returning invitation_sent_at into v_sent;
  if v_sent is null then
    raise exception 'record: that request is not approved' using errcode = 'PT409', detail = 'not_approved';
  end if;
  return jsonb_build_object('invitationSentAt', v_sent);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. GRANTS.
-- ---------------------------------------------------------------------------
revoke all on function public.redeem_bound_invite(text) from public, anon, authenticated, service_role;
revoke all on function public.approve_early_access_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_invitation_sent(uuid) from public, anon, authenticated, service_role;
grant execute on function public.redeem_bound_invite(text) to service_role;
grant execute on function public.approve_early_access_request(uuid) to service_role;
grant execute on function public.record_invitation_sent(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; role_name text; n int;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    for r in select unnest(array['public.redeem_bound_invite(text)', 'public.approve_early_access_request(uuid)',
                                 'public.record_invitation_sent(uuid)', 'public.consume_link_and_create_account(uuid,text,uuid)',
                                 'public.redeem_invite(text,text)']) as sig loop
      if has_function_privilege(role_name, r.sig, 'EXECUTE') then
        raise exception 'MIGRATION 0056 ABORTED: % can execute %.', role_name, r.sig;
      end if;
    end loop;
    if has_table_privilege(role_name, 'public.invite_codes', 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege(role_name, 'public.early_access_requests', 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'MIGRATION 0056 ABORTED: % can reach an early-access table.', role_name;
    end if;
  end loop;

  if has_function_privilege('service_role', 'public.consume_link_and_create_account(uuid,text,uuid)', 'EXECUTE') then
    raise exception 'MIGRATION 0056 ABORTED: the shared account body must be owner-only.';
  end if;
  foreach role_name in array array['public.redeem_bound_invite(text)', 'public.approve_early_access_request(uuid)',
                                   'public.record_invitation_sent(uuid)', 'public.redeem_invite(text,text)'] loop
    if not has_function_privilege('service_role', role_name, 'EXECUTE') then
      raise exception 'MIGRATION 0056 ABORTED: service_role cannot execute %.', role_name;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = role_name::regprocedure and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
      raise exception 'MIGRATION 0056 ABORTED: % is not a definer function with an empty search_path.', role_name;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.early_access_requests', 'UPDATE')
     or has_column_privilege('service_role', 'public.invite_codes', 'used_at', 'UPDATE')
     or has_column_privilege('service_role', 'public.invite_codes', 'email', 'INSERT') then
    raise exception 'MIGRATION 0056 ABORTED: service_role may write approval or reservation state directly.';
  end if;

  -- Both redemptions share one account-creation body.
  for r in select p.proname, p.prosrc from pg_proc p
            where p.oid in ('public.redeem_invite(text,text)'::regprocedure, 'public.redeem_bound_invite(text)'::regprocedure) loop
    if position('public.consume_link_and_create_account(v_link.id, v_link.email, v_invite)' in r.prosrc) = 0
       or position('insert into public.users' in r.prosrc) > 0 then
      raise exception 'MIGRATION 0056 ABORTED: % does not create accounts through the shared body.', r.proname;
    end if;
  end loop;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'invite_codes_one_live_reservation_per_email'
                  and indexdef like '%UNIQUE%' and indexdef like '%used_at IS NULL%' and indexdef like '%revoked_at IS NULL%') then
    raise exception 'MIGRATION 0056 ABORTED: the one-live-reservation index is missing or not partial.';
  end if;

  select count(*) into n from (
    select 'user' as kind, u.id, md5(row(u.*)::text) as v from public.users u
    union all select 'link', l.id, md5(row(l.*)::text) from public.magic_links l
  ) now_rows full join (select kind, id, v from _0056_before where kind in ('user', 'link')) b using (kind, id)
  where now_rows.v is distinct from b.v;
  if n <> 0 then raise exception 'MIGRATION 0056 ABORTED: % existing account or link row changed.', n; end if;

  raise notice '0056 catalog: reserved invites with one live reservation per address; both redemptions share one owner-only account body; service_role writes no approval or reservation state; no account or link row changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 9. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
-- ---------------------------------------------------------------------------
savepoint invitation_probe;

do $$
declare
  v_email text := 'migration-0056-probe-' || gen_random_uuid() || '@invalid.example';
  v_req uuid; v_token text := 'probe-' || gen_random_uuid(); v_token2 text := 'probe-' || gen_random_uuid();
  v_res jsonb; v_user uuid; v_detail text; v_hash text;
begin
  insert into public.early_access_requests (name, email, use_case) values ('Probe', v_email, 'migration probe') returning id into v_req;

  v_res := public.approve_early_access_request(v_req);
  if v_res ->> 'status' <> 'approved' then raise exception '0056 PROOF: approval did not reserve an invite (%)', v_res; end if;
  if not exists (select 1 from public.invite_codes where email = v_email and code_hash is null and used_at is null) then
    raise exception '0056 PROOF: the reserved invite is not codeless and unused';
  end if;
  if (public.approve_early_access_request(v_req)) ->> 'status' <> 'already_approved' then
    raise exception '0056 PROOF: approving twice reserved a second invite';
  end if;

  insert into public.magic_links (email, token, expires_at) values (v_email, v_token, now() + interval '7 days');
  v_res := public.redeem_bound_invite(v_token);
  select id into v_user from public.users where email = v_email;
  if not (v_res ->> 'created')::boolean or v_user is null
     or not exists (select 1 from public.professional_profiles where user_id = v_user)
     or not exists (select 1 from public.invite_codes where email = v_email and used_by = v_user)
     or not (select used from public.magic_links where token = v_token) then
    raise exception '0056 PROOF: claiming the invitation did not create the account and consume the invite together (%)', v_res;
  end if;

  -- A second link for the same address now signs in; nothing is consumed twice.
  insert into public.magic_links (email, token, expires_at) values (v_email, v_token2, now() + interval '7 days');
  v_res := public.redeem_bound_invite(v_token2);
  if (v_res ->> 'created')::boolean or (v_res ->> 'userId')::uuid <> v_user then
    raise exception '0056 PROOF: a second claim did not simply sign in (%)', v_res;
  end if;

  -- An address with no invitation is refused, and the typed-code path still works.
  insert into public.magic_links (email, token, expires_at) values ('other-' || v_email, 'probe-' || gen_random_uuid(), now() + interval '1 hour');
  begin
    perform public.redeem_bound_invite((select token from public.magic_links where email = 'other-' || v_email));
    raise exception '0056 PROOF: an address with no invitation was let in';
  exception when sqlstate 'PT403' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'no_invitation' then raise exception '0056 PROOF: refused with detail %', v_detail; end if;
  end;

  v_hash := encode(sha256(convert_to('probe-code-' || gen_random_uuid(), 'UTF8')), 'hex');
  insert into public.invite_codes (code_hash, label) values (v_hash, 'probe manual');
  v_res := public.redeem_invite((select token from public.magic_links where email = 'other-' || v_email), v_hash);
  if not (v_res ->> 'created')::boolean then raise exception '0056 PROOF: the typed-code path stopped working (%)', v_res; end if;

  raise notice '0056 proof: approval reserves one codeless invite and is idempotent; the link claims it and creates the account in one step; a later link signs in; an uninvited address is refused; typed codes still work.';
end $$;

rollback to savepoint invitation_probe;
release savepoint invitation_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0056-probe-%')
     or exists (select 1 from public.invite_codes where email like 'migration-0056-probe-%') then
    raise exception 'MIGRATION 0056 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
