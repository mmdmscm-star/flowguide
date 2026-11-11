-- ============================================================================
-- 0061 — EMAIL + PASSWORD SIGN-IN, alongside the existing magic link.
--
-- Until now the only way into Sendset was the magic link: enter your email,
-- click a sign-in link in the inbox. That shape turns into a hard problem the
-- moment someone else needs to use an account on a device that does not have
-- access to the account's email — a spouse taking over sending Sendsets, a
-- shared device, a tablet that isn't signed into the account's Gmail. The
-- magic link stays (it is also the password-reset mechanism), and this
-- migration adds the pieces that let a professional set a password on their
-- existing account and then sign in with email + password on any device.
--
-- SCHEMA
--
--   public.users
--     + password_hash         text,          bcrypt hash; NULL means "no
--                                            password set" — the magic link
--                                            is still the only way in.
--     + password_updated_at   timestamptz,   when the hash was last written;
--                                            used by the UI to show "last
--                                            changed on …", not for security.
--
--   public.password_login_attempts
--     One row per /api/auth/password-login submission against the email,
--     successful or not. The route reads this table to rate-limit: 5 failed
--     attempts per email per 15-minute window locks that email out of the
--     password path (the magic link stays open). Rows older than a day are
--     pruned by pg_cron below so the table does not grow forever.
--
--     email            text        normalised lowercase, as stored on users.
--     ok               boolean     true if the password matched; false otherwise.
--     ip_hash          text        sha256 of the client IP, for an optional
--                                  per-IP lock later; never the IP itself.
--     attempted_at     timestamptz now().
--
-- GRANTS: nothing for anon or authenticated. service_role reads and inserts
-- password_login_attempts; updates users.password_hash / password_updated_at.
-- Password_hash is NEVER returned to the client under any role.
--
-- ROLLBACK: supabase/rollbacks/0061_user_password_down.sql.
-- ============================================================================

begin;

-- 1. The hash column + its when-set timestamp.
alter table public.users
  add column if not exists password_hash       text,
  add column if not exists password_updated_at timestamptz;

-- A soft invariant: either both columns are set or both are null. Keeps a
-- half-written row from reading as "password set" to the UI.
alter table public.users
  drop constraint if exists users_password_pair;
alter table public.users
  add  constraint users_password_pair
    check (
      (password_hash is null and password_updated_at is null) or
      (password_hash is not null and password_updated_at is not null)
    );

-- 2. Attempts table for rate-limiting.
create table if not exists public.password_login_attempts (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  ok            boolean     not null,
  ip_hash       text,
  attempted_at  timestamptz not null default now()
);

create index if not exists password_login_attempts_email_time_idx
  on public.password_login_attempts (email, attempted_at desc);

-- Prune anything older than a day so the table stays bounded. Only the
-- recent-window query matters for rate-limit decisions; the rest is noise.
-- Matches the pattern 0055/0056 use for early-access housekeeping.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'prune_password_login_attempts_daily',
      '17 3 * * *',
      $cron$ delete from public.password_login_attempts where attempted_at < now() - interval '1 day' $cron$
    );
  end if;
exception when others then
  -- pg_cron absent in dev/test: the table is still correct, just unbounded
  -- until the next deploy to an environment that has it. Not a correctness
  -- issue — the rate-limit query reads a 15-minute window regardless.
  null;
end $$;

-- 3. GRANTS. password_hash must never be reachable under anon/authenticated
-- PostgREST, but column-level revoke on an anon role that has nothing is
-- defence in depth rather than a live gate. The real gate is: all auth paths
-- go through the service role via the Next server, never the client.
revoke all on table public.password_login_attempts from public, anon, authenticated;
grant select, insert on table public.password_login_attempts to service_role;

commit;

-- Verification that the column landed. Fails loudly if a prior migration
-- raced this one so the next deploy doesn't limp along missing the column.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'
  ) then
    raise exception '0061: users.password_hash did not land';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'password_login_attempts'
  ) then
    raise exception '0061: password_login_attempts table did not land';
  end if;
end $$;

notify pgrst, 'reload schema';
