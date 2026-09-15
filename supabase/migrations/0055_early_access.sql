-- ============================================================================
-- 0055 — EARLY ACCESS: A NEW SENDSET ACCOUNT NEEDS A SINGLE-USE INVITE CODE.
--
-- Sign-in is Sendset's own magic link (/api/auth/send-magic-link → /api/auth/
-- verify). Until now verify created an account for any email that clicked a
-- link. After the app change, verify only signs in EXISTING accounts; a new
-- email is sent to /join, and the account is created here, by one function,
-- in one transaction with the invite that pays for it.
--
--   public.invite_codes           one row per code: the SHA-256 of the code
--                                 (never the code), a label saying who it is
--                                 for, and when it was used or revoked.
--   public.early_access_requests  name, email and use case from /early-access;
--                                 purged after 90 days by pg_cron.
--   public.redeem_invite(magic token, code hash)
--       1. locks the magic link; refuses a used or expired one  (PT401 link_invalid)
--       2. an account already exists for that email: marks the link used and
--          returns it — no invite is looked at or consumed
--       3. locks the invite; refuses unknown, used or revoked alike (PT403 invite_invalid)
--       4. creates the user and its empty profile, marks the invite used by
--          that user, marks the link used — all or nothing.
--
-- Concurrency: two redemptions of one code serialise on the invite row lock,
-- and the second re-checks "unused" against the committed row and is refused.
-- Two links for one new email race on users.email's unique index; the loser
-- signs in to the winner's account and consumes nothing. Anything that fails
-- rolls back the whole transaction, so a failed signup never burns a code.
--
-- GRANTS: nothing for anon or authenticated. service_role: read both tables;
-- insert an invite's hash and label; set revoked_at; insert and delete requests;
-- execute redeem_invite. It cannot mark an invite used except through the
-- function.
--
-- Not the gate: Supabase Auth's own signup (unused by Sendset) is a separate
-- configuration cleanup and is not relied on here.
--
-- ROLLBACK: supabase/rollbacks/0055_early_access_down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.users') is null or to_regclass('public.magic_links') is null
     or to_regclass('public.professional_profiles') is null then
    raise exception 'MIGRATION 0055 ABORTED: users, magic_links or professional_profiles does not exist.';
  end if;
  if to_regclass('public.invite_codes') is not null or to_regclass('public.early_access_requests') is not null
     or to_regprocedure('public.redeem_invite(text,text)') is not null then
    raise exception 'MIGRATION 0055 ABORTED: an 0055 object already exists.';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    raise exception 'MIGRATION 0055 ABORTED: pg_cron (0024) is not installed; the 90-day purge needs it.';
  end if;
  if exists (select 1 from cron.job where jobname = 'sendset-purge-early-access-requests') then
    raise exception 'MIGRATION 0055 ABORTED: the early-access purge job already exists.';
  end if;
end $$;

create temp table _0055_before on commit drop as
  select 'user' as kind, u.id, md5(row(u.*)::text) as v from public.users u
  union all select 'link', l.id, md5(row(l.*)::text) from public.magic_links l
  union all select 'profile', f.id, md5(row(f.*)::text) from public.professional_profiles f;

-- ---------------------------------------------------------------------------
-- 1. TABLES.
-- ---------------------------------------------------------------------------
create table public.invite_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null,
  label       text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  used_at     timestamptz,
  used_by     uuid references public.users(id) on delete set null,
  constraint invite_codes_code_hash_unique unique (code_hash),
  constraint invite_codes_code_hash_sha256 check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint invite_codes_label_present check (length(btrim(label)) between 1 and 200),
  constraint invite_codes_used_or_revoked check (used_at is null or revoked_at is null),
  constraint invite_codes_used_by_only_when_used check (used_by is null or used_at is not null)
);

comment on table public.invite_codes is
  'Single-use early-access invite codes (0055). Stores only the SHA-256 of each code. Consumed only by redeem_invite, in the transaction that creates the account.';

create table public.early_access_requests (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  use_case    text not null,
  created_at  timestamptz not null default now(),
  constraint early_access_requests_name_present check (length(btrim(name)) between 1 and 200),
  constraint early_access_requests_email_shape check (length(email) <= 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint early_access_requests_use_case_present check (length(btrim(use_case)) between 1 and 2000)
);

create index early_access_requests_email_created on public.early_access_requests (email, created_at);
create index early_access_requests_created on public.early_access_requests (created_at);

comment on table public.early_access_requests is
  'Requests from /early-access (0055), reviewed by hand. Deleted after 90 days by the sendset-purge-early-access-requests job.';

alter table public.invite_codes enable row level security;
alter table public.early_access_requests enable row level security;

revoke all on public.invite_codes from public, anon, authenticated, service_role;
revoke all on public.early_access_requests from public, anon, authenticated, service_role;
grant select on public.invite_codes to service_role;
grant insert (code_hash, label) on public.invite_codes to service_role;
grant update (revoked_at) on public.invite_codes to service_role;
grant select, delete on public.early_access_requests to service_role;
grant insert (name, email, use_case) on public.early_access_requests to service_role;

-- ---------------------------------------------------------------------------
-- 2. REDEMPTION: the one way an invite becomes an account.
-- ---------------------------------------------------------------------------
create function public.redeem_invite(p_magic_token text, p_code_hash text) returns jsonb
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

comment on function public.redeem_invite(text, text) is
  'Create a Sendset account for a verified magic link and consume one invite code, atomically (0055). An existing account signs in without consuming a code. service_role only.';

revoke all on function public.redeem_invite(text, text) from public, anon, authenticated, service_role;
grant execute on function public.redeem_invite(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. RETENTION: early-access requests are kept for 90 days.
-- ---------------------------------------------------------------------------
select cron.schedule('sendset-purge-early-access-requests', '41 3 * * *',
  $cron$delete from public.early_access_requests where created_at < now() - interval '90 days'$cron$);

-- ---------------------------------------------------------------------------
-- 4. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; n int; role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.invite_codes', 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege(role_name, 'public.early_access_requests', 'SELECT,INSERT,UPDATE,DELETE')
       or has_function_privilege(role_name, 'public.redeem_invite(text,text)', 'EXECUTE') then
      raise exception 'MIGRATION 0055 ABORTED: % can reach an 0055 object.', role_name;
    end if;
  end loop;
  if has_column_privilege('service_role', 'public.invite_codes', 'used_at', 'UPDATE')
     or has_column_privilege('service_role', 'public.invite_codes', 'used_by', 'UPDATE')
     or has_table_privilege('service_role', 'public.invite_codes', 'DELETE')
     or not has_column_privilege('service_role', 'public.invite_codes', 'revoked_at', 'UPDATE')
     or not has_function_privilege('service_role', 'public.redeem_invite(text,text)', 'EXECUTE') then
    raise exception 'MIGRATION 0055 ABORTED: service_role privileges on invites are not as designed.';
  end if;

  select p.prosecdef, p.proconfig into r from pg_proc p where p.oid = 'public.redeem_invite(text,text)'::regprocedure;
  if not r.prosecdef or not ('search_path=""' = any (r.proconfig)) then
    raise exception 'MIGRATION 0055 ABORTED: redeem_invite must be SECURITY DEFINER with an empty search_path.';
  end if;

  if not exists (select 1 from pg_class where oid = 'public.invite_codes'::regclass and relrowsecurity)
     or not exists (select 1 from pg_class where oid = 'public.early_access_requests'::regclass and relrowsecurity) then
    raise exception 'MIGRATION 0055 ABORTED: row level security is not enabled.';
  end if;

  if not exists (select 1 from cron.job where jobname = 'sendset-purge-early-access-requests' and active
                  and position('interval ''90 days''' in command) > 0) then
    raise exception 'MIGRATION 0055 ABORTED: the 90-day purge is not scheduled.';
  end if;

  select count(*) into n from (
    select 'user' as kind, u.id, md5(row(u.*)::text) as v from public.users u
    union all select 'link', l.id, md5(row(l.*)::text) from public.magic_links l
    union all select 'profile', f.id, md5(row(f.*)::text) from public.professional_profiles f
  ) now_rows full join _0055_before b using (kind, id)
  where now_rows.v is distinct from b.v;
  if n <> 0 then raise exception 'MIGRATION 0055 ABORTED: % existing row(s) changed.', n; end if;

  raise notice '0055 catalog: no anon/authenticated access; service_role cannot mark an invite used; definer redeem_invite; RLS on; 90-day purge scheduled; no existing row changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 5. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
-- ---------------------------------------------------------------------------
savepoint early_access_probe;

do $$
declare
  v_hash text := encode(sha256(convert_to('probe-invite-' || gen_random_uuid(), 'UTF8')), 'hex');
  v_email text := 'migration-0055-probe-' || gen_random_uuid() || '@invalid.example';
  v_token text := 'probe-' || gen_random_uuid(); v_token2 text := 'probe-' || gen_random_uuid();
  v_result jsonb; v_detail text;
begin
  insert into public.invite_codes (code_hash, label) values (v_hash, 'migration 0055 probe');
  insert into public.magic_links (email, token, expires_at) values (v_email, v_token, now() + interval '10 minutes');

  begin
    perform public.redeem_invite(v_token, encode(sha256(convert_to('wrong', 'UTF8')), 'hex'));
    raise exception '0055 PROOF: an unknown code created an account';
  exception when sqlstate 'PT403' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'invite_invalid' then raise exception '0055 PROOF: unknown code refused with %', v_detail; end if;
  end;
  if exists (select 1 from public.users where email = v_email)
     or (select used from public.magic_links where token = v_token) then
    raise exception '0055 PROOF: a refused code left an account or used the link';
  end if;

  v_result := public.redeem_invite(v_token, v_hash);
  if not (v_result ->> 'created')::boolean
     or not exists (select 1 from public.professional_profiles p join public.users u on u.id = p.user_id where u.email = v_email)
     or not exists (select 1 from public.invite_codes where code_hash = v_hash and used_at is not null and used_by = (v_result ->> 'userId')::uuid) then
    raise exception '0055 PROOF: redemption did not create the account and consume the invite together (%)', v_result;
  end if;

  insert into public.magic_links (email, token, expires_at) values ('other-' || v_email, v_token2, now() + interval '10 minutes');
  begin
    perform public.redeem_invite(v_token2, v_hash);
    raise exception '0055 PROOF: a used code created a second account';
  exception when sqlstate 'PT403' then null;
  end;

  raise notice '0055 proof: unknown code refused without side effects; one redemption creates user, profile and consumes the invite; a used code is refused.';
end $$;

rollback to savepoint early_access_probe;
release savepoint early_access_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0055-probe-%@invalid.example')
     or exists (select 1 from public.invite_codes) then
    raise exception 'MIGRATION 0055 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
