-- Rollback for 0061: drop the password columns and the attempts table.
-- Safe to run against a prod that has set passwords: the only thing lost is
-- the ability to sign in with password; magic links keep working unchanged.

begin;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('prune_password_login_attempts_daily');
    exception when others then null;
    end;
  end if;
end $$;

drop table if exists public.password_login_attempts;

alter table public.users
  drop constraint if exists users_password_pair;

alter table public.users
  drop column if exists password_hash,
  drop column if exists password_updated_at;

commit;

notify pgrst, 'reload schema';
