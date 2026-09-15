-- The Supabase platform pieces FlowGuide's migrations touch, recreated just far
-- enough for the migrations to run on plain PostgreSQL 17. Nothing here models
-- behaviour a migration under test depends on.

-- Roles, and Supabase's default grants: a table created with no revoke is
-- readable by anon, so a "no grants survive" check has something to fail on.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- pg_cron (0024 schedules the evidence purge). The extension itself is not
-- installable here; replay.sh swaps 0024's CREATE EXTENSION for this schema.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean not null default true
);
create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid
$$;
create or replace function cron.unschedule(p_name text) returns boolean
language sql as $$ delete from cron.job where jobname = p_name returning true $$;

-- Storage (0029 registers the photo bucket and a read policy).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text
);
alter table storage.objects enable row level security;
