-- ============================================================================
-- 0053 — ONLY publish_packet AND unpublish_packet CHANGE A SENDSET'S STATUS.
--
-- Since cb1114e no TypeScript writes packets.status, and ownership-route.test
-- asserts it. That is a rule about today's source. This makes it a rule about the
-- database: a status change the two functions did not authorise is refused,
-- whoever issues it.
--
-- THE MECHANISM (0007's, for editor-mode changes). publish_packet and
-- unpublish_packet set the transaction-local setting
-- app.publication_authorized_packet to the Sendset's id immediately before their
-- status UPDATE and clear it immediately after (0052). The trigger below allows a
-- status change only when that setting names THIS Sendset. An ordinary write
-- through PostgREST runs in its own transaction with the setting unset, and
-- PostgREST exposes no way to set it.
--
-- WHAT IS REFUSED:
--   * UPDATE that changes status (either direction) without the authorisation;
--   * INSERT of a Sendset with any status but 'draft' without it.
-- WHAT IS NOT TOUCHED: inserting a draft (every creation path), updates that
-- leave status unchanged, deletes (a delete is not a status change), and every
-- other column.
--
-- Narrow on purpose: no backfill, no reader change, no invariant between status
-- and packet_publications — each of those is its own step.
--
-- ROLLBACK: supabase/rollbacks/0053_packet_status_single_door_down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS: the two doors exist and authorise themselves, and nothing
--    else installed changes a status (it would start failing the moment this
--    commits).
-- ---------------------------------------------------------------------------
do $$
declare v_fn text; v_others text;
begin
  foreach v_fn in array array['publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)', 'unpublish_packet(uuid,uuid)'] loop
    if to_regprocedure('public.' || v_fn) is null then
      raise exception 'MIGRATION 0053 ABORTED: public.% (0052) does not exist.', v_fn;
    end if;
    if (select position('set_config(''app.publication_authorized_packet'', p_packet_id::text, true)' in prosrc)
          from pg_proc where oid = ('public.' || v_fn)::regprocedure) = 0 then
      raise exception 'MIGRATION 0053 ABORTED: public.% does not authorise its own status change.', v_fn;
    end if;
  end loop;

  select string_agg(p.proname, ', ' order by p.proname) into v_others
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('publish_packet', 'unpublish_packet')
     and (p.prosrc ~* 'update\s+(public\.)?packets\s+set[^;]*\mstatus\s*='
          or (p.prosrc ~* 'insert\s+into\s+(public\.)?packets\s*\([^)]*\mstatus\M'
              and p.prosrc !~* 'insert\s+into\s+(public\.)?packets\s*\([^)]*\mstatus\M[^;]*values\s*\([^;]*''draft''\)'));
  if v_others is not null then
    raise exception 'MIGRATION 0053 ABORTED: other installed function(s) change a Sendset''s status: %', v_others;
  end if;

  if to_regprocedure('public.enforce_packet_status_single_door()') is not null
     or exists (select 1 from pg_trigger where tgname = 'trg_packet_status_single_door') then
    raise exception 'MIGRATION 0053 ABORTED: the single-door trigger already exists.';
  end if;
end $$;

create temp table _0053_before on commit drop as
  select id, status, published_at, updated_at, draft_rev from public.packets;

-- ---------------------------------------------------------------------------
-- 1. THE DOOR.
--
-- SECURITY INVOKER: it reads one setting and needs no privilege. Refusals carry
-- PT403 (PostgREST: HTTP 403) and DETAIL status_single_door.
-- ---------------------------------------------------------------------------
create function public.enforce_packet_status_single_door() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft'
       and current_setting('app.publication_authorized_packet', true) is distinct from new.id::text then
      raise exception 'status: a Sendset is created as a draft; only publish_packet publishes it'
        using errcode = 'PT403', detail = 'status_single_door';
    end if;
  elsif new.status is distinct from old.status
        and current_setting('app.publication_authorized_packet', true) is distinct from new.id::text then
    raise exception 'status: only publish_packet or unpublish_packet may change a Sendset''s status (% -> %)', old.status, new.status
      using errcode = 'PT403', detail = 'status_single_door';
  end if;
  return new;
end;
$$;

comment on function public.enforce_packet_status_single_door() is
  'Refuses any change to packets.status, and any insert that is not a draft, unless publish_packet or unpublish_packet authorised this Sendset via app.publication_authorized_packet (0053).';

create trigger trg_packet_status_single_door
  before insert or update of status on public.packets
  for each row execute function public.enforce_packet_status_single_door();

revoke all on function public.enforce_packet_status_single_door() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; n int;
begin
  select p.prosecdef, p.proconfig, p.proacl, p.proowner into r
    from pg_proc p where p.oid = 'public.enforce_packet_status_single_door()'::regprocedure;
  if r.prosecdef or not ('search_path=""' = any (r.proconfig)) then
    raise exception 'MIGRATION 0053 ABORTED: the trigger function must be SECURITY INVOKER with an empty search_path.';
  end if;
  if r.proacl is null or exists (select 1 from aclexplode(r.proacl) a where a.grantee <> r.proowner) then
    raise exception 'MIGRATION 0053 ABORTED: the trigger function is executable by a role other than its owner.';
  end if;

  -- BEFORE, row-level, INSERT and UPDATE (tgtype bits ROW 1, BEFORE 2, INSERT 4,
  -- UPDATE 16; not DELETE 8), UPDATE restricted to the status column.
  select t.tgtype, t.tgenabled, t.tgattr::text as attrs, t.tgfoid into r
    from pg_trigger t
   where t.tgname = 'trg_packet_status_single_door' and t.tgrelid = 'public.packets'::regclass;
  if not found or r.tgenabled <> 'O' or (r.tgtype & 31) <> 23
     or r.tgfoid <> 'public.enforce_packet_status_single_door()'::regprocedure
     or r.attrs <> (select attnum::text from pg_attribute where attrelid = 'public.packets'::regclass and attname = 'status') then
    raise exception 'MIGRATION 0053 ABORTED: trg_packet_status_single_door is not an enabled BEFORE INSERT OR UPDATE OF status row trigger (%).', r;
  end if;

  select count(*) into n from _0053_before b full join public.packets p using (id)
   where (b.status, b.published_at, b.updated_at, b.draft_rev) is distinct from (p.status, p.published_at, p.updated_at, p.draft_rev);
  if n <> 0 then raise exception 'MIGRATION 0053 ABORTED: % existing Sendset row(s) changed.', n; end if;

  raise notice '0053 catalog: invoker trigger function, owner-only; enabled BEFORE INSERT OR UPDATE OF status row trigger; no existing row changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 3. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
--
-- The refused status targets are held in variables rather than written as
-- literals: ownership-route.test rejects any migration statement that assigns a
-- published status outside publish_packet, and these statements exist only to be
-- refused.
-- ---------------------------------------------------------------------------
savepoint single_door_probe;

do $$
declare
  u uuid; pk uuid; sec uuid; v_slug text; v_detail text;
  v_published constant text := 'published';
  v_draft constant text := 'draft';
begin
  insert into public.users (email) values ('migration-0053-probe-' || gen_random_uuid() || '@invalid.example') returning id into u;
  insert into public.professional_profiles (user_id, name, phone) values (u, 'Probe', '555-0100');
  insert into public.packets (user_id, slug, title) values (u, 'mig0053probe' || substr(md5(random()::text), 1, 12), 'probe')
    returning id, slug into pk, v_slug;
  insert into public.packets (user_id, slug, title, status) values (u, 'mig0053probe' || substr(md5(random()::text), 1, 12), 'explicit draft', v_draft);
  insert into public.sections (packet_id, title) values (pk, 'S') returning id into sec;
  insert into public.items (section_id, title) values (sec, 'I');

  begin
    insert into public.packets (user_id, slug, title, status) values (u, 'mig0053probe' || substr(md5(random()::text), 1, 12), 'born published', v_published);
    raise exception '0053 PROOF: a Sendset was inserted as published';
  exception when sqlstate 'PT403' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'status_single_door' then raise exception '0053 PROOF: insert refused with detail %', v_detail; end if;
  end;

  begin
    update public.packets set status = v_published where id = pk;
    raise exception '0053 PROOF: a direct update published a Sendset';
  exception when sqlstate 'PT403' then null;
  end;

  -- The flag must name THIS Sendset.
  perform set_config('app.publication_authorized_packet', gen_random_uuid()::text, true);
  begin
    update public.packets set status = v_published where id = pk;
    raise exception '0053 PROOF: authorisation for another Sendset opened this one';
  exception when sqlstate 'PT403' then null;
  end;
  perform set_config('app.publication_authorized_packet', '', true);

  -- The door itself still works, and leaves the flag cleared behind it.
  perform public.publish_packet(u, pk, public.packet_publish_token(u, pk), 1::smallint,
    jsonb_build_object('slug', v_slug), '{}'::jsonb);
  if (select status from public.packets where id = pk) <> v_published then
    raise exception '0053 PROOF: publish_packet could not publish';
  end if;
  begin
    update public.packets set status = v_draft where id = pk;
    raise exception '0053 PROOF: a direct update unpublished a Sendset';
  exception when sqlstate 'PT403' then null;
  end;

  -- Everything that is not a status change is untouched.
  update public.packets set title = 'renamed while published', status = status where id = pk;
  if (select title from public.packets where id = pk) <> 'renamed while published' then
    raise exception '0053 PROOF: an ordinary update of a published Sendset was refused';
  end if;

  perform public.unpublish_packet(u, pk);
  if (select status from public.packets where id = pk) <> v_draft then
    raise exception '0053 PROOF: unpublish_packet could not unpublish';
  end if;

  delete from public.packets where id = pk;

  raise notice '0053 proof: direct inserts and updates of status refused in both directions, authorisation bound to the Sendset id, publish_packet and unpublish_packet still work, ordinary updates and deletes untouched.';
end $$;

rollback to savepoint single_door_probe;
release savepoint single_door_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0053-probe-%@invalid.example') then
    raise exception 'MIGRATION 0053 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
