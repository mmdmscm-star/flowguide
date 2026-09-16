-- ============================================================================
-- 0057 — AN HONEST COUNT OF PAGE OPENS, REPLACING A BOOLEAN THAT MEANT LITTLE.
--
-- `packets.viewed` is one-way and binary. In production 32 of 34 published
-- Sendsets have reached true, so the badge says the same thing about nearly
-- everything; it cannot tell one open from forty; and until 2026-08 the
-- professional's own visits set it, with no backfill to undo that.
--
-- WHAT A VIEW IS: a browser opening the published recipient page. Repeats count.
-- It is not people, not recipients, not unique anything. Nothing about who
-- opened it is recorded, because nothing about who opened it is stored: this
-- migration adds ONE INTEGER and no event row, no timestamp, no identifier.
--
--   public.packets.view_count            lifetime page opens, per Sendset
--   public.record_packet_view(text)      +1, atomically, for a published slug
--
-- ON THE SENDSET, NOT THE PUBLICATION. The URL is stable across Republish, so
-- the count is too; unpublish/republish preserve it; a duplicate is a new row
-- and starts at 0 by the column default.
--
-- NO PUBLIC WRITE PATH, and this is the part with history. Migration 0015 had
-- to remove a policy literally called "Public can mark packets as viewed": RLS
-- gates rows, not columns, so it granted anon a whole-row UPDATE of every
-- published packet — verified exploitable against production. This function is
-- the narrow replacement. It writes one column, only for a published slug, and
-- anon and authenticated may not execute it. Only the server can call it.
--
-- STARTS AT ZERO EVERYWHERE, deliberately. `viewed = true` records that at
-- least one open happened, possibly the owner's; turning it into 1 would state
-- a number nobody measured. A counter that begins honestly is worth more than
-- one seeded with a guess.
--
-- `viewed` IS LEFT IN PLACE, unread by the application from this deploy on. It
-- is dropped by a later cleanup migration once the count is proven live.
--
-- ROLLBACK: supabase/rollbacks/0057_packet_view_count_down.sql.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'packets'
                and column_name = 'view_count') then
    raise exception 'MIGRATION 0057 ABORTED: packets.view_count already exists.';
  end if;
  if to_regprocedure('public.record_packet_view(text)') is not null then
    raise exception 'MIGRATION 0057 ABORTED: record_packet_view already exists.';
  end if;
  -- The two revision triggers this migration must not disturb.
  if to_regprocedure('public.draft_rev_packet_self()') is null
     or to_regprocedure('public.ingest_bump_packet_self()') is null then
    raise exception 'MIGRATION 0057 ABORTED: the revision triggers are not the ones this was written against.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. THE COLUMN.
-- ---------------------------------------------------------------------------
alter table public.packets
  add column view_count integer not null default 0;

comment on column public.packets.view_count is
  'Lifetime browser opens of the published recipient page (0057). Page opens, not people: repeats count, nothing identifies a visitor, and no per-view row exists. Excluded from draft_rev and content_rev by those triggers column lists, so a view never makes a published Sendset look edited. Survives Republish; a duplicate starts at 0.';

-- ---------------------------------------------------------------------------
-- 2. THE ONLY WAY TO WRITE IT.
--
-- `set view_count = view_count + 1` reads and writes under the row lock the
-- UPDATE takes, so simultaneous opens cannot lose a count against each other.
-- Returns nothing: the caller must not learn whether the slug existed, and a
-- count is not a fact a recipient's browser is owed.
-- ---------------------------------------------------------------------------
create function public.record_packet_view(p_slug text) returns void
language sql security definer set search_path = '' as $$
  update public.packets
     set view_count = view_count + 1
   where slug = p_slug
     and status = 'published';
$$;

comment on function public.record_packet_view(text) is
  'Add one page open to a published Sendset (0057). Atomic; silent about whether the slug exists; unpublished and missing slugs are a no-op. Server-only: anon and authenticated hold no EXECUTE.';

-- A NEW FUNCTION IS EXECUTABLE BY PUBLIC UNTIL SAID OTHERWISE, which is how a
-- SECURITY DEFINER function becomes an anon-callable write.
revoke all on function public.record_packet_view(text) from public;
revoke all on function public.record_packet_view(text) from anon;
revoke all on function public.record_packet_view(text) from authenticated;
grant execute on function public.record_packet_view(text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. PROOF, IN THE SAME TRANSACTION AS THE CHANGE.
--
-- The hard invariant: a view must never make a published Sendset look like it
-- has unpublished changes. Both revision triggers compare explicit column
-- tuples, so a new column is excluded by construction — but "by construction"
-- is exactly the kind of reasoning that stops being true when someone edits a
-- tuple later. 0050 proved the same property for `viewed`; this proves it for
-- `view_count`, and rolls the fixture back either way.
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid; pk uuid; d0 bigint; d1 bigint; c0 bigint; c1 bigint; v0 int; v1 int; n int;
begin
  insert into public.users (email) values ('0057-proof@example.invalid') returning id into u;
  insert into public.packets (user_id, slug, title, status)
    values (u, '0057-proof-slug', 'proof', 'draft') returning id into pk;

  d0 := (select draft_rev from public.packets where id = pk);
  c0 := (select content_rev from public.packets where id = pk);
  v0 := (select view_count from public.packets where id = pk);
  if v0 <> 0 then raise exception '0057 PROOF: a new Sendset did not start at 0 views'; end if;

  -- A DRAFT IS NOT COUNTABLE.
  perform public.record_packet_view('0057-proof-slug');
  if (select view_count from public.packets where id = pk) <> 0 then
    raise exception '0057 PROOF: an unpublished Sendset counted a view';
  end if;

  -- A MISSING SLUG IS A SILENT NO-OP, not an error the caller could read.
  perform public.record_packet_view('0057-no-such-slug');

  -- THE INVARIANT, WRITTEN DIRECTLY.
  --
  -- Not through record_packet_view, because that only writes a PUBLISHED row
  -- and a migration may not publish one: 0053 refuses every status change
  -- outside publish_packet/unpublish_packet, and ownership-route.test scans
  -- these files for exactly that. The counting behaviour is proved against a
  -- properly published Sendset in scripts/pg-harness/test-0057.mjs. What has to
  -- be proved HERE, beside the column it is about, is that moving view_count
  -- moves no revision — the trigger tuples are the same whatever the status.
  update public.packets set view_count = view_count + 1 where id = pk;
  v1 := (select view_count from public.packets where id = pk);
  if v1 <> 1 then raise exception '0057 PROOF: the probe write did not take (% )', v1; end if;

  d1 := (select draft_rev from public.packets where id = pk);
  c1 := (select content_rev from public.packets where id = pk);
  if d1 <> d0 then raise exception '0057 PROOF: a view moved draft_rev % -> %', d0, d1; end if;
  if c1 <> c0 then raise exception '0057 PROOF: a view moved content_rev % -> %', c0, c1; end if;

  -- A REAL EDIT STILL MOVES draft_rev, so the check above is not passing
  -- because the trigger stopped working altogether.
  update public.packets set client_title = 'a client-facing heading' where id = pk;
  if (select draft_rev from public.packets where id = pk) <= d1 then
    raise exception '0057 PROOF: draft_rev stopped responding to a real edit';
  end if;

  -- NO PUBLIC EXECUTE.
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema = 'public' and routine_name = 'record_packet_view'
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if n > 0 then
    raise exception '0057 PROOF: record_packet_view is executable by % unprivileged grantee(s)', n;
  end if;

  delete from public.packets where id = pk;
  delete from public.users where id = u;
end $$;

commit;
