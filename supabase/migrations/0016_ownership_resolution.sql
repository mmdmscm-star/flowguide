-- 0016 — ownership resolution: atomic Move, intentional Keep.
--
-- WHY THIS IS ONE TABLE AND NOT TWO. Findings are never stored; they are
-- re-derived from live rows on every read (src/lib/ownership-recompute.ts). So
-- MOVING a photo to the item the source actually puts it on needs no record at
-- all — the finding stops being true on the next recompute. Nothing to mark,
-- nothing to go stale.
--
-- KEEP is different in kind. The professional asserts "I know the source puts
-- this elsewhere, and I want it here anyway." That information exists nowhere in
-- the data, so it must be written down. The source is evidence of original
-- ownership; it does not permanently outrank a deliberate edit.
--
--   Move changes reality. Keep records intent. Only Keep needs storage.
--
-- WHAT A DECISION IS KEYED ON, and why it cannot go stale:
--   item_id  — the only stable handle here. item_photos rows are deleted and
--              reinserted with fresh uuids on every save (0011), which is why
--              provenance lives on items (0014) and a decision cannot key on a
--              photo row.
--   url      — the granularity findings are already deduped at. A
--              media_on_wrong_record finding is only ever emitted when the URL
--              occurs in exactly ONE source record, so every copy of it on that
--              item is misplaced together and one decision covers them
--              coherently.
--
-- Deliberately NOT keyed on source_hash. A decision is only ever consulted after
-- recompute has already proven the slice hashes to the run's source_hash, and
-- items.origin_run_id fixes which run that is — so a stored hash could never
-- discriminate, but could silently lose a Keep and make a resolved finding
-- reappear with no way to see why.
--
-- AMBIGUITY IS NOT DECIDABLE. A URL listed under SEVERAL source records is
-- reported as ownership_unverifiable, which offers neither Move nor Keep and
-- does not block. Recording a Keep there would convert "the source never said"
-- into "the user decided". The application enforces this; the table simply never
-- receives such a row.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Intentional overrides. The row's EXISTENCE means kept.
-- ---------------------------------------------------------------------------
create table if not exists public.item_media_decisions (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id) on delete cascade,
  url        text not null,
  created_at timestamptz not null default now(),
  unique (item_id, url)
);

comment on table public.item_media_decisions is
  'A professional''s deliberate "keep this photo here" override of a proven media_on_wrong_record finding. Presence = kept; deletion = undo. Never written for ambiguous findings.';

create index if not exists item_media_decisions_item_idx
  on public.item_media_decisions(item_id);

-- No content_rev trigger, deliberately. A decision is not packet content, and
-- bumping the revision would falsely trip an in-flight run's
-- baseline_content_rev assertion in finalize_ingestion_run.
alter table public.item_media_decisions enable row level security;

-- ACL, stated in full rather than inherited.
--
-- REVOKING FROM anon AND authenticated IS NOT ENOUGH ON ITS OWN. A privilege
-- held by PUBLIC is held by every role, and never appears as a grant to either
-- of those two — which is exactly the shape a default-privilege surprise takes.
-- 0015 existed because access was reachable that nobody had granted on purpose.
revoke all on table public.item_media_decisions from public;
revoke all on table public.item_media_decisions from anon, authenticated;

-- And the converse: do not depend on ALTER DEFAULT PRIVILEGES to have granted
-- the service role anything. bypassrls skips POLICIES, not GRANTS, so without
-- this the ownership route's reads fail on a project whose defaults differ, and
-- the gate reports 503 forever. Insert and delete only — a decision is created
-- or removed, never edited.
grant select, insert, delete on table public.item_media_decisions to service_role;

-- ---------------------------------------------------------------------------
-- 2. Atomic Move.
--
-- Today this would be three writes through update_item_content — rewrite item
-- A's photo list, rewrite item B's — with a window where the photo exists on
-- neither. Here it is one statement in one transaction.
--
-- Moves every row with this URL on the source item. That is correct for every
-- case a Move is offered: media_on_wrong_record fires only when the URL occurs
-- in exactly one source record, so if it is on the wrong item, all its copies
-- there are equally wrong. Findings whose owner is ambiguous never offer Move.
-- ---------------------------------------------------------------------------
create or replace function public.move_item_photos(
  p_owner uuid,
  p_from_item uuid,
  p_to_item uuid,
  p_url text,
  p_packet_id uuid default null   -- optional cross-check, mirrors update_item_content
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from_packet uuid; v_to_packet uuid; v_user uuid; v_status text;
  v_base int; v_moved int;
begin
  if p_from_item = p_to_item then
    raise exception 'move photos: source and destination are the same item';
  end if;
  if coalesce(p_url, '') not like 'http%' then
    raise exception 'move photos: an http(s) url is required';
  end if;

  select s.packet_id into v_from_packet
    from public.items i join public.sections s on s.id = i.section_id where i.id = p_from_item;
  select s.packet_id into v_to_packet
    from public.items i join public.sections s on s.id = i.section_id where i.id = p_to_item;
  if v_from_packet is null then raise exception 'move photos: item % not found', p_from_item; end if;
  if v_to_packet   is null then raise exception 'move photos: item % not found', p_to_item; end if;
  if v_from_packet <> v_to_packet then
    raise exception 'move photos: items belong to different packets';
  end if;
  if p_packet_id is not null and v_from_packet <> p_packet_id then
    raise exception 'move photos: items do not belong to packet %', p_packet_id;
  end if;

  select user_id, status into v_user, v_status
    from public.packets where id = v_from_packet for update;
  if v_user is null      then raise exception 'move photos: packet not found'; end if;
  if v_user <> p_owner   then raise exception 'move photos: caller does not own packet'; end if;
  if v_status <> 'draft' then raise exception 'move photos: packet is not draft (status=%)', v_status; end if;

  -- Plain read, NOT `for update`. finalize_ingestion_run locks ingestion_runs
  -- BEFORE packets, so acquiring them in the opposite order here would be a
  -- deadlock class. Moving photos mid-import would also break that run's
  -- baseline_content_rev assertion, hence the refusal.
  if exists (select 1 from public.ingestion_runs
             where packet_id = v_from_packet and status in ('active','finalizing')) then
    raise exception 'move photos: an import is in progress on this packet';
  end if;

  -- The destination may ALREADY hold this url. A model that DUPLICATES a photo
  -- onto two items, rather than misfiling one copy, produces exactly that: the
  -- correct owner keeps its copy and a second lands somewhere it does not
  -- belong. item_photos carries no unique (item_id, url), so reassigning here
  -- would hand the destination the same photo twice and leave the professional
  -- deleting a duplicate they never created.
  --
  -- The intent behind Move is "this belongs there, not here". When it is already
  -- there, honouring that intent means removing the misplaced copies, not adding
  -- another. Either way the finding stops being true on the next recompute,
  -- which is the outcome that actually has to hold.
  if exists (select 1 from public.item_photos where item_id = p_to_item and url = p_url) then
    delete from public.item_photos where item_id = p_from_item and url = p_url;
    get diagnostics v_moved = row_count;
  else
    -- APPEND to the destination rather than carrying sort_order across. Readers
    -- order by sort_order with no tie-break, so a carried value would collide
    -- with the destination's existing photos and make the carousel order — and
    -- the hero photo — nondeterministic.
    select coalesce(max(sort_order), -1) + 1 into v_base
      from public.item_photos where item_id = p_to_item;

    with ranked as (
      select id, row_number() over (order by sort_order, created_at, id) - 1 as n
        from public.item_photos
       where item_id = p_from_item and url = p_url
    )
    update public.item_photos p
       set item_id = p_to_item, sort_order = v_base + r.n
      from ranked r
     where p.id = r.id;

    get diagnostics v_moved = row_count;
  end if;

  if v_moved = 0 then
    raise exception 'move photos: no photo with that url on item %', p_from_item;
  end if;

  -- A decision recorded against the OLD placement is meaningless once the photo
  -- has left; leaving it would silently suppress a future finding about the same
  -- url landing back on that item.
  delete from public.item_media_decisions where item_id = p_from_item and url = p_url;

  return v_moved;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Keep, and its undo. A resolution the professional cannot reverse is a trap.
-- ---------------------------------------------------------------------------
create or replace function public.set_item_media_decision(
  p_owner uuid, p_item_id uuid, p_url text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_packet uuid; v_user uuid; v_status text;
begin
  if coalesce(p_url, '') not like 'http%' then
    raise exception 'keep photo: an http(s) url is required';
  end if;
  select s.packet_id into v_packet
    from public.items i join public.sections s on s.id = i.section_id where i.id = p_item_id;
  if v_packet is null then raise exception 'keep photo: item % not found', p_item_id; end if;

  select user_id, status into v_user, v_status from public.packets where id = v_packet;
  if v_user <> p_owner   then raise exception 'keep photo: caller does not own packet'; end if;
  if v_status <> 'draft' then raise exception 'keep photo: packet is not draft (status=%)', v_status; end if;

  -- The photo must actually be on the item. Otherwise a Keep could be recorded
  -- for a placement that does not exist and would pre-suppress a future finding.
  if not exists (select 1 from public.item_photos where item_id = p_item_id and url = p_url) then
    raise exception 'keep photo: that url is not on item %', p_item_id;
  end if;

  insert into public.item_media_decisions (item_id, url) values (p_item_id, p_url)
  on conflict (item_id, url) do nothing;
end;
$$;

create or replace function public.clear_item_media_decision(
  p_owner uuid, p_item_id uuid, p_url text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_packet uuid; v_user uuid;
begin
  select s.packet_id into v_packet
    from public.items i join public.sections s on s.id = i.section_id where i.id = p_item_id;
  if v_packet is null then raise exception 'undo keep: item % not found', p_item_id; end if;
  select user_id into v_user from public.packets where id = v_packet;
  if v_user <> p_owner then raise exception 'undo keep: caller does not own packet'; end if;

  delete from public.item_media_decisions where item_id = p_item_id and url = p_url;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Match 0012's posture: reachable only through SECURITY DEFINER callers,
--    never as a PostgREST rpc endpoint for anon/authenticated.
-- ---------------------------------------------------------------------------
revoke all on function public.move_item_photos(uuid, uuid, uuid, text, uuid) from public;
revoke all on function public.move_item_photos(uuid, uuid, uuid, text, uuid) from anon, authenticated;
revoke all on function public.set_item_media_decision(uuid, uuid, text) from public;
revoke all on function public.set_item_media_decision(uuid, uuid, text) from anon, authenticated;
revoke all on function public.clear_item_media_decision(uuid, uuid, text) from public;
revoke all on function public.clear_item_media_decision(uuid, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Prove it.
-- ---------------------------------------------------------------------------
do $verify$
declare v_left text; v_count int;
begin
  -- ---- the table exists ---------------------------------------------------
  if to_regclass('public.item_media_decisions') is null then
    raise exception '0016: item_media_decisions was not created';
  end if;

  -- ---- all three functions exist ------------------------------------------
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision');
  if v_count <> 3 then
    raise exception '0016: expected 3 functions, found %', v_count;
  end if;

  -- ---- they are SECURITY DEFINER with a pinned search_path ----------------
  -- A SECURITY DEFINER function without a pinned search_path is a privilege
  -- escalation waiting for a schema it did not expect. This is asserted rather
  -- than assumed, so a later edit that drops the setting fails the migration.
  select string_agg(p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
    and (not p.prosecdef
      or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%');
  if v_left is not null then
    raise exception '0016: not SECURITY DEFINER with a pinned search_path: %', v_left;
  end if;

  -- ---- no role can EXECUTE them -------------------------------------------
  -- has_function_privilege answers "can this role actually do it", which
  -- already accounts for privileges held through PUBLIC and through role
  -- inheritance. A search of grant ROWS would not, which is how a default-grant
  -- surprise stays invisible.
  --
  -- PUBLIC is deliberately NOT passed to has_function_privilege: it is a
  -- pseudo-role, not a row in pg_roles, and the function raises on it. It gets
  -- its own ACL check below instead.
  select string_agg(distinct r.rolname::text || ' -> ' || p.proname::text, ', ') into v_left
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'),('authenticated')) as r(rolname)
  where n.nspname = 'public'
    and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
    and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_left is not null then
    raise exception '0016: functions still executable: %', v_left;
  end if;

  -- ---- and PUBLIC holds nothing on them, explicitly -----------------------
  -- Grantee OID 0 is PUBLIC. A NULL proacl is NOT "no privileges": it means
  -- DEFAULT privileges, and functions default to EXECUTE for PUBLIC — so a
  -- missing revoke reads as an empty ACL while the whole world can call it.
  select string_agg(p.proname::text, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('move_item_photos','set_item_media_decision','clear_item_media_decision')
    and (p.proacl is null
      or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));
  if v_left is not null then
    raise exception '0016: PUBLIC can still execute: %', v_left;
  end if;

  -- ---- no role can reach the TABLE either ---------------------------------
  -- Tested by effect, across every privilege type. The earlier draft of this
  -- check read information_schema.role_table_grants for grantee in
  -- ('anon','authenticated') and would have passed while both roles held
  -- everything through PUBLIC.
  select string_agg(distinct r.rolname::text || ':' || pr.priv::text, ', ') into v_left
  from (values ('anon'),('authenticated')) as r(rolname)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) as pr(priv)
  where has_table_privilege(r.rolname, 'public.item_media_decisions', pr.priv);
  if v_left is not null then
    raise exception '0016: item_media_decisions still reachable: %', v_left;
  end if;

  -- ---- and PUBLIC holds nothing on the table ------------------------------
  if exists (select 1 from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             cross join lateral aclexplode(c.relacl) a
             where n.nspname = 'public' and c.relname = 'item_media_decisions'
               and a.grantee = 0) then
    raise exception '0016: PUBLIC still holds privileges on item_media_decisions';
  end if;

  -- ---- RLS is on, with no policy ------------------------------------------
  -- The second layer. Even if a privilege were somehow granted, no policy means
  -- no row is visible to a non-bypassrls role.
  if not coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = 'item_media_decisions'), false) then
    raise exception '0016: row level security is not enabled on item_media_decisions';
  end if;
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'item_media_decisions') > 0 then
    raise exception '0016: item_media_decisions must carry no policy';
  end if;

  -- ---- the legitimate caller CAN still work -------------------------------
  -- A lockdown that also locks out the only intended caller is not a success;
  -- it is a 503 discovered in production.
  select string_agg(pr.priv::text, ', ') into v_left
  from (values ('SELECT'),('INSERT'),('DELETE')) as pr(priv)
  where not has_table_privilege('service_role', 'public.item_media_decisions', pr.priv);
  if v_left is not null then
    raise exception '0016: service_role lacks % on item_media_decisions', v_left;
  end if;

  raise notice '0016: table + 3 RPCs installed; anon/authenticated/PUBLIC hold nothing; service_role can read and write; RLS on with no policy';
end
$verify$;

commit;

notify pgrst, 'reload schema';
