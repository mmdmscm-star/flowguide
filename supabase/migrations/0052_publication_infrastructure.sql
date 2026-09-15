-- ============================================================================
-- 0052 — PUBLISH ATOMICALLY, AGAINST EXACTLY WHAT THE GATES CHECKED.
--
-- THE INVARIANT. No publish can succeed without the TypeScript publish gates —
-- ownership above all — having passed for the same underlying inputs. The gates
-- stay in the route; this migration binds their verdict to the write.
--
--   1. public.packet_publish_token(owner, packet) reads, in ONE statement,
--      everything a publish gate reads: status, draft_rev, the account profile
--      (only when the Sendset's identity comes from it), whether an import
--      blocks, whether there is a title, and a SHA-256 of every input the
--      ownership check selects. The route reads it BEFORE running the gates.
--   2. public.publish_packet(…, expected_token, snapshot, …) locks the Sendset,
--      recomputes the token, and refuses on any difference. Only then does it
--      validate the snapshot and write the publication and the status, in one
--      transaction. Any refusal leaves the existing publication and status
--      exactly as they were.
--   3. public.unpublish_packet deletes the publication and returns the Sendset
--      to draft, under the same lock.
--   4. Two lock-only triggers make the writers that never touched the Sendset
--      row contend on it: media decisions (the OLD and NEW owning Sendsets) and
--      the account profile (every Sendset its owner has). Without them a Keep
--      or a profile edit could commit between the recomputation and the commit.
--      Every other token input's writers already take that row lock (0050/0012
--      revision triggers, FK checks) or can only run while a blocking import
--      makes the token refuse anyway.
--
-- WHAT THIS DOES NOT DO YET. The route still publishes the old way until it is
-- changed to call these functions. Nothing enforces the authorization flag the
-- functions set (0053 adds that trigger). Readers still render live rows; no
-- publication is backfilled (0054). Additive, and inert until the route uses it.
--
-- GRANTS. Token, publish and unpublish: EXECUTE for service_role only. The lock
-- trigger functions: executable by nobody (triggers fire regardless).
--
-- ROLLBACK: supabase/rollbacks/0052_publication_infrastructure_down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  if to_regclass('public.packet_publications') is null then
    raise exception 'MIGRATION 0052 ABORTED: packet_publications (0050) does not exist.';
  end if;
  if to_regprocedure('public.packet_has_blocking_run(uuid)') is null then
    raise exception 'MIGRATION 0052 ABORTED: packet_has_blocking_run (0051) does not exist.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'packets' and column_name = 'draft_rev') then
    raise exception 'MIGRATION 0052 ABORTED: packets.draft_rev (0050) does not exist.';
  end if;
  foreach f in array array['packet_publish_token(uuid,uuid)', 'publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)',
                           'unpublish_packet(uuid,uuid)', 'lock_packets_for_media_decision()', 'lock_packets_for_profile()'] loop
    if to_regprocedure('public.' || f) is not null then
      raise exception 'MIGRATION 0052 ABORTED: public.% already exists.', f;
    end if;
  end loop;
  if exists (select 1 from pg_trigger where tgname in ('trg_lock_packets_for_media_decision', 'trg_lock_packets_for_profile')) then
    raise exception 'MIGRATION 0052 ABORTED: a 0052 lock trigger already exists.';
  end if;
end $$;

create temp table _0052_before on commit drop as
  select 'packet' as kind, id, status || '|' || coalesce(published_at::text, '') || '|' || updated_at::text as v from public.packets
  union all select 'publication', packet_id, md5(content::text) || '|' || published_at::text from public.packet_publications
  union all select 'profile', id, updated_at::text || '|' || identity_rev::text from public.professional_profiles
  union all select 'decision', id, item_id::text || '|' || url from public.item_media_decisions;

-- ---------------------------------------------------------------------------
-- 1. THE PUBLISH TOKEN.
--
-- One SQL statement, so one snapshot of the database. Compared as jsonb equality.
--
-- gate_inputs covers, column for column, what lib/ownership-service.ts
-- loadPacketOwnership selects (a source test fails if that list grows): the
-- Sendset's raw_input; its items' id, section_id, title and origin columns;
-- their photos; the runs those items came from; those runs' chunks; and the
-- media decisions on those items. Every array is explicitly ordered, and jsonb
-- renders a given value identically every time, so equal inputs give an equal
-- digest.
--
-- The account profile is part of the token only when identity_mode is
-- 'default': a custom or no-identity Sendset never reads it, so a profile edit
-- must not abort its publish. identity_mode itself moves draft_rev.
--
-- SECURITY DEFINER, not invoker: it asks packet_has_blocking_run, which 0051
-- made executable by its owner only. As an invoker function the route's
-- service_role would be refused. It reads nothing beyond the owner-filtered
-- Sendset, and only service_role may call it.
-- ---------------------------------------------------------------------------
create function public.packet_publish_token(p_owner uuid, p_packet_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with p as (
    select id, status, draft_rev, title, raw_input, identity_mode
      from public.packets
     where id = p_packet_id and user_id = p_owner
  ), its as (
    select i.id, i.section_id, i.title, i.origin_run_id, i.origin_chunk_ordinal, i.origin_emit_index
      from public.items i
      join public.sections s on s.id = i.section_id
     where s.packet_id = p_packet_id
  ), gate as (
    select jsonb_build_object(
      'raw_input', (select raw_input from p),
      'items', coalesce((select jsonb_agg(jsonb_build_array(id, section_id, title, origin_run_id, origin_chunk_ordinal, origin_emit_index) order by id)
                           from its), '[]'::jsonb),
      'photos', coalesce((select jsonb_agg(jsonb_build_array(ph.item_id, ph.url) order by ph.item_id, ph.url)
                            from public.item_photos ph where ph.item_id in (select id from its)), '[]'::jsonb),
      'runs', coalesce((select jsonb_agg(jsonb_build_array(r.id, r.source_hash, r.source_len, r.segmenter_version, r.source_offset_base, r.delimiter_hint) order by r.id)
                          from public.ingestion_runs r where r.id in (select origin_run_id from its)), '[]'::jsonb),
      'chunks', coalesce((select jsonb_agg(jsonb_build_array(c.run_id, c.ordinal, c.source_start, c.source_end, c.status) order by c.run_id, c.ordinal)
                            from public.ingestion_chunks c where c.run_id in (select origin_run_id from its)), '[]'::jsonb),
      'decisions', coalesce((select jsonb_agg(jsonb_build_array(d.item_id, d.url) order by d.item_id, d.url)
                               from public.item_media_decisions d where d.item_id in (select id from its)), '[]'::jsonb)
    ) as j
  )
  select case when not exists (select 1 from p) then null else jsonb_build_object(
    'format', 1,
    'status', (select status from p),
    'draft_rev', (select draft_rev from p),
    'identity_dependency', (select case when identity_mode = 'default' then 'account_profile' else 'sendset' end from p),
    'profile_exists', (select case when identity_mode = 'default'
                                   then exists (select 1 from public.professional_profiles f where f.user_id = p_owner) end from p),
    'identity_rev', (select case when identity_mode = 'default'
                                 then (select f.identity_rev from public.professional_profiles f where f.user_id = p_owner) end from p),
    'blocking_run', public.packet_has_blocking_run(p_packet_id),
    'title_present', (select btrim(coalesce(title, '')) <> '' from p),
    'gate_inputs', encode(sha256(convert_to((select j from gate)::text, 'UTF8')), 'hex')
  ) end
$$;

comment on function public.packet_publish_token(uuid, uuid) is
  'Everything a publish gate reads, in one statement (0052). The route reads it before running the gates; publish_packet recomputes it under the Sendset lock and refuses on any difference. NULL when the Sendset does not exist or is not the owner''s.';

-- ---------------------------------------------------------------------------
-- 2. WRITERS THAT DID NOT CONTEND ON THE SENDSET ROW NOW DO.
--
-- BEFORE row triggers taking FOR SHARE on the Sendset rows, in id order. FOR
-- SHARE conflicts with publish_packet's FOR UPDATE but not with another SHARE,
-- so two Keeps do not serialise against each other.
--
-- Deadlock-free: publish_packet locks one Sendset row and reads everything else
-- without locking; these triggers take Sendset rows in id order before their
-- own row is written; content writers take one Sendset row. No cycle exists.
--
-- A delete cascading from a deleted Sendset finds no Sendset row to lock (the
-- command already removed it) and locks nothing — proved in the harness.
-- ---------------------------------------------------------------------------
create function public.lock_packets_for_media_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_items uuid[] := array[]::uuid[];
begin
  if tg_op <> 'INSERT' then v_items := v_items || old.item_id; end if;
  if tg_op <> 'DELETE' then v_items := v_items || new.item_id; end if;
  perform 1 from public.packets p
   where p.id in (select s.packet_id from public.items i join public.sections s on s.id = i.section_id
                   where i.id = any (v_items))
   order by p.id
     for share;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger trg_lock_packets_for_media_decision
  before insert or update or delete on public.item_media_decisions
  for each row execute function public.lock_packets_for_media_decision();

-- Every Sendset of the owner, not only identity_mode = 'default' ones: that
-- filter would be read from a snapshot, and a Sendset switched to default
-- concurrently would escape it.
create function public.lock_packets_for_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_users uuid[] := array[]::uuid[];
begin
  if tg_op <> 'INSERT' then v_users := v_users || old.user_id; end if;
  if tg_op <> 'DELETE' then v_users := v_users || new.user_id; end if;
  perform 1 from public.packets p
   where p.user_id = any (v_users)
   order by p.id
     for share;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger trg_lock_packets_for_profile
  before insert or update or delete on public.professional_profiles
  for each row execute function public.lock_packets_for_profile();

-- ---------------------------------------------------------------------------
-- 3. PUBLISH AND REPUBLISH.
--
-- Errors carry PostgREST status codes (PT404 / PT409 / PT400) and a stable
-- DETAIL the route maps to its own messages:
--   not_found          no such Sendset for this owner
--   changed            the token differs: something changed after the gates ran
--   import_blocks      an import blocks publishing
--   title_required     no title
--   invalid_snapshot   the snapshot is not a recipient-safe copy of THIS Sendset
--
-- The identity dependency and source revisions are taken from the recomputed
-- token, never from the caller. The status change is made under the
-- app.publication_authorized_packet flag that 0053 will require.
-- ---------------------------------------------------------------------------
create function public.publish_packet(
  p_owner uuid, p_packet_id uuid, p_expected_token jsonb,
  p_format_version smallint, p_content jsonb, p_professional_snapshot jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pk record; v_token jsonb; v_now timestamptz := now(); v_dep text; v_foreign int;
begin
  select id, user_id, slug, composition_mode into v_pk
    from public.packets where id = p_packet_id for update;
  if v_pk.id is null or v_pk.user_id is distinct from p_owner then
    raise exception 'publish: Sendset not found' using errcode = 'PT404', detail = 'not_found';
  end if;

  -- THE BINDING. Everything the gates read, recomputed under the lock.
  v_token := public.packet_publish_token(p_owner, p_packet_id);
  if v_token is distinct from p_expected_token then
    raise exception 'publish: this Sendset changed while it was being published' using errcode = 'PT409', detail = 'changed';
  end if;
  if (v_token ->> 'blocking_run')::boolean then
    raise exception 'publish: an import blocks publishing' using errcode = 'PT409', detail = 'import_blocks';
  end if;
  if not (v_token ->> 'title_present')::boolean then
    raise exception 'publish: a title is required' using errcode = 'PT400', detail = 'title_required';
  end if;

  -- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.
  if p_format_version is distinct from 1::smallint then
    raise exception 'publish: unsupported snapshot format %', p_format_version using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  if jsonb_typeof(p_content) is distinct from 'object' or p_content ->> 'slug' is distinct from v_pk.slug then
    raise exception 'publish: the snapshot is not this Sendset' using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  if jsonb_typeof(p_professional_snapshot) is distinct from 'object' then
    raise exception 'publish: the identity snapshot must be an object' using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  select count(*) into v_foreign from (
    select jsonb_path_query(p_content, 'lax $.sections[*].id') #>> '{}' as id, 'section' as kind
    union all select jsonb_path_query(p_content, 'lax $.sections[*].items[*].id') #>> '{}', 'item'
    union all select jsonb_path_query(p_content, 'lax $.blocks[*].item.id') #>> '{}', 'item'
    union all select jsonb_path_query(p_content, 'lax $.blocks[*].id') #>> '{}', 'block'
  ) named
  where not case named.kind
    when 'section' then exists (select 1 from public.sections s where s.packet_id = p_packet_id and s.id::text = named.id)
    when 'item' then exists (select 1 from public.items i join public.sections s on s.id = i.section_id
                              where s.packet_id = p_packet_id and i.id::text = named.id)
    else exists (select 1 from public.packet_blocks b where b.packet_id = p_packet_id and b.id::text = named.id)
  end;
  if v_foreign > 0 then
    raise exception 'publish: the snapshot names % section, item or block id(s) outside this Sendset', v_foreign
      using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  if v_pk.composition_mode = 'blocks' then
    perform public.assert_packet_block_consistency(p_packet_id);
  end if;

  -- THE WRITE. One transaction: the copy and the status move together.
  v_dep := v_token ->> 'identity_dependency';
  begin
    insert into public.packet_publications
           (packet_id, format_version, content, source_draft_rev, identity_dependency, source_identity_rev, published_at)
    values (p_packet_id, p_format_version, p_content, (v_token ->> 'draft_rev')::bigint, v_dep,
            case when v_dep = 'account_profile' then (v_token ->> 'identity_rev')::bigint end, v_now)
    on conflict (packet_id) do update
       set format_version      = excluded.format_version,
           content             = excluded.content,
           source_draft_rev    = excluded.source_draft_rev,
           identity_dependency = excluded.identity_dependency,
           source_identity_rev = excluded.source_identity_rev,
           published_at        = excluded.published_at;
  exception when check_violation then
    raise exception 'publish: the snapshot is not recipient-safe (%)', sqlerrm using errcode = 'PT400', detail = 'invalid_snapshot';
  end;

  perform set_config('app.publication_authorized_packet', p_packet_id::text, true);
  update public.packets
     set status = 'published', published_at = v_now, professional_snapshot = p_professional_snapshot
   where id = p_packet_id;
  perform set_config('app.publication_authorized_packet', '', true);

  return jsonb_build_object('slug', v_pk.slug, 'publishedAt', v_now,
                            'sourceDraftRev', (v_token ->> 'draft_rev')::bigint);
end;
$$;

comment on function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb) is
  'Publish or republish atomically (0052): lock, recompute the publish token, refuse on any difference, validate the snapshot, then write the publication and status together. Any refusal leaves the existing publication untouched. service_role only; called only by the publish route after its gates.';

-- ---------------------------------------------------------------------------
-- 4. UNPUBLISH: the frozen copy goes with the status (v1 decision).
-- ---------------------------------------------------------------------------
create function public.unpublish_packet(p_owner uuid, p_packet_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pk record;
begin
  select id, user_id into v_pk from public.packets where id = p_packet_id for update;
  if v_pk.id is null or v_pk.user_id is distinct from p_owner then
    raise exception 'unpublish: Sendset not found' using errcode = 'PT404', detail = 'not_found';
  end if;
  delete from public.packet_publications where packet_id = p_packet_id;
  perform set_config('app.publication_authorized_packet', p_packet_id::text, true);
  update public.packets set status = 'draft' where id = p_packet_id;
  perform set_config('app.publication_authorized_packet', '', true);
  return jsonb_build_object('status', 'draft');
end;
$$;

comment on function public.unpublish_packet(uuid, uuid) is
  'Unpublish (0052): delete the frozen publication and return the Sendset to draft under the Sendset lock. service_role only.';

-- ---------------------------------------------------------------------------
-- 5. GRANTS.
-- ---------------------------------------------------------------------------
revoke all on function public.packet_publish_token(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.unpublish_packet(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.lock_packets_for_media_decision() from public, anon, authenticated, service_role;
revoke all on function public.lock_packets_for_profile() from public, anon, authenticated, service_role;
grant execute on function public.packet_publish_token(uuid, uuid) to service_role;
grant execute on function public.publish_packet(uuid, uuid, jsonb, smallint, jsonb, jsonb) to service_role;
grant execute on function public.unpublish_packet(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; role_name text; n int;
begin
  for r in
    select * from (values
      ('packet_publish_token(uuid,uuid)', true, true),
      ('publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)', true, true),
      ('unpublish_packet(uuid,uuid)', true, true),
      ('lock_packets_for_media_decision()', true, false),
      ('lock_packets_for_profile()', true, false)
    ) as t(sig, definer, service_role_executes)
  loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = ('public.' || r.sig)::regprocedure
         and p.prosecdef = r.definer
         and 'search_path=""' = any (p.proconfig)
         and p.proacl is not null
         and not exists (select 1 from aclexplode(p.proacl) a
                          where a.grantee <> p.proowner
                            and not (r.service_role_executes and a.grantee = (select oid from pg_roles where rolname = 'service_role')))
    ) then
      raise exception 'MIGRATION 0052 ABORTED: public.% has the wrong security, search_path or grants.', r.sig;
    end if;
    foreach role_name in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_name, 'public.' || r.sig, 'EXECUTE') then
        raise exception 'MIGRATION 0052 ABORTED: % can execute public.%.', role_name, r.sig;
      end if;
    end loop;
    if has_function_privilege('service_role', 'public.' || r.sig, 'EXECUTE') <> r.service_role_executes then
      raise exception 'MIGRATION 0052 ABORTED: service_role EXECUTE on public.% is not %.', r.sig, r.service_role_executes;
    end if;
  end loop;

  select count(*) into n from pg_trigger t
   where not t.tgisinternal and t.tgenabled = 'O'
     and ((t.tgname = 'trg_lock_packets_for_media_decision' and t.tgrelid = 'public.item_media_decisions'::regclass
           and t.tgfoid = 'public.lock_packets_for_media_decision()'::regprocedure)
       or (t.tgname = 'trg_lock_packets_for_profile' and t.tgrelid = 'public.professional_profiles'::regclass
           and t.tgfoid = 'public.lock_packets_for_profile()'::regprocedure));
  if n <> 2 then raise exception 'MIGRATION 0052 ABORTED: expected both lock triggers, found %.', n; end if;

  -- BEFORE, row-level, on INSERT, UPDATE and DELETE (tgtype bits 1, 2, 4, 8, 16).
  if exists (select 1 from pg_trigger t
              where t.tgname in ('trg_lock_packets_for_media_decision', 'trg_lock_packets_for_profile')
                and (t.tgtype & 31) <> 31) then
    raise exception 'MIGRATION 0052 ABORTED: a lock trigger is not BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW.';
  end if;

  -- Nothing existing was written.
  select count(*) into n from (
    select 'packet' as kind, id, status || '|' || coalesce(published_at::text, '') || '|' || updated_at::text as v from public.packets
    union all select 'publication', packet_id, md5(content::text) || '|' || published_at::text from public.packet_publications
    union all select 'profile', id, updated_at::text || '|' || identity_rev::text from public.professional_profiles
    union all select 'decision', id, item_id::text || '|' || url from public.item_media_decisions
  ) now_rows full join _0052_before b using (kind, id)
  where now_rows.v is distinct from b.v;
  if n <> 0 then raise exception 'MIGRATION 0052 ABORTED: % existing row(s) changed.', n; end if;

  raise notice '0052 catalog: token, publish and unpublish (definer), service_role-only execute; lock trigger functions owner-only; both BEFORE row triggers present; no existing row changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 7. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
-- ---------------------------------------------------------------------------
savepoint publication_probe;

do $$
declare
  u uuid; pk uuid; sec uuid; it uuid; v_slug text; t0 jsonb; t1 jsonb; v_content jsonb;
  v_before record; v_after record; v_state text; v_detail text;
begin
  insert into public.users (email) values ('migration-0052-probe-' || gen_random_uuid() || '@invalid.example') returning id into u;
  insert into public.professional_profiles (user_id, name, phone) values (u, 'Probe', '555-0100');
  insert into public.packets (user_id, slug, title) values (u, 'mig0052probe' || substr(md5(random()::text), 1, 12), 'probe')
    returning id, slug into pk, v_slug;
  insert into public.sections (packet_id, title) values (pk, 'S') returning id into sec;
  insert into public.items (section_id, title) values (sec, 'I') returning id into it;
  v_content := jsonb_build_object('slug', v_slug, 'sections', jsonb_build_array(jsonb_build_object('id', sec, 'items', jsonb_build_array(jsonb_build_object('id', it)))));

  if public.packet_publish_token(gen_random_uuid(), pk) is not null then
    raise exception '0052 PROOF: another owner received a token';
  end if;

  t0 := public.packet_publish_token(u, pk);
  if t0 is distinct from public.packet_publish_token(u, pk) then
    raise exception '0052 PROOF: the token is not deterministic';
  end if;

  -- The token sees the inputs only the ownership check reads.
  insert into public.item_photos (item_id, url) values (it, 'https://probe.invalid/p.jpg');
  t1 := public.packet_publish_token(u, pk);
  insert into public.item_media_decisions (item_id, url) values (it, 'https://probe.invalid/p.jpg');
  if public.packet_publish_token(u, pk) is not distinct from t1 then
    raise exception '0052 PROOF: the token did not change when a Keep was recorded';
  end if;
  t1 := public.packet_publish_token(u, pk);
  update public.packets set raw_input = 'probe source' where id = pk;
  if public.packet_publish_token(u, pk) is not distinct from t1 then
    raise exception '0052 PROOF: the token did not change when raw_input changed';
  end if;

  -- A blocking import refuses even with a matching token.
  insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status)
    values (u, pk, 'append', 'probe', 'seg-v4', 'active');
  begin
    perform public.publish_packet(u, pk, public.packet_publish_token(u, pk), 1::smallint, v_content, '{}'::jsonb);
    raise exception '0052 PROOF: publish succeeded while an import blocks';
  exception when sqlstate 'PT409' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'import_blocks' then raise exception '0052 PROOF: blocking import refused with detail %', v_detail; end if;
  end;
  delete from public.ingestion_runs where packet_id = pk;
  t0 := public.packet_publish_token(u, pk);

  perform public.publish_packet(u, pk, t0, 1::smallint, v_content, '{}'::jsonb);
  select p.status, pub.source_draft_rev, pub.identity_dependency, pub.source_identity_rev, md5(pub.content::text) as c, pub.published_at
    into v_before
    from public.packets p join public.packet_publications pub on pub.packet_id = p.id where p.id = pk;
  if v_before.status <> 'published' or v_before.identity_dependency <> 'account_profile' or v_before.source_identity_rev is null then
    raise exception '0052 PROOF: publish did not write the status and publication together (%).', v_before;
  end if;

  -- A change after the token: refused, and the live copy survives byte for byte.
  t1 := public.packet_publish_token(u, pk);
  update public.items set title = 'I edited' where id = it;
  begin
    perform public.publish_packet(u, pk, t1, 1::smallint, v_content, '{}'::jsonb);
    raise exception '0052 PROOF: a stale token was accepted';
  exception when sqlstate 'PT409' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'changed' then raise exception '0052 PROOF: stale token refused with detail %', v_detail; end if;
  end;
  select p.status, md5(pub.content::text) as c, pub.published_at into v_after
    from public.packets p join public.packet_publications pub on pub.packet_id = p.id where p.id = pk;
  if v_after.status <> 'published' or v_after.c <> v_before.c or v_after.published_at <> v_before.published_at then
    raise exception '0052 PROOF: a refused republish disturbed the live publication';
  end if;

  -- A snapshot naming another Sendset's item is refused.
  begin
    perform public.publish_packet(u, pk, public.packet_publish_token(u, pk), 1::smallint,
      jsonb_build_object('slug', v_slug, 'sections', jsonb_build_array(jsonb_build_object('id', sec,
        'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid()))))), '{}'::jsonb);
    raise exception '0052 PROOF: a snapshot with a foreign item id was accepted';
  exception when sqlstate 'PT400' then null;
  end;
  begin
    perform public.publish_packet(u, pk, public.packet_publish_token(u, pk), 1::smallint,
      v_content || '{"sections":[{"items":[{"notes":"private"}]}]}'::jsonb, '{}'::jsonb);
    raise exception '0052 PROOF: a snapshot carrying a private note was accepted';
  exception when sqlstate 'PT400' then null;
  end;

  -- Unpublish removes both.
  perform public.unpublish_packet(u, pk);
  select status into v_state from public.packets where id = pk;
  if v_state <> 'draft' or exists (select 1 from public.packet_publications where packet_id = pk) then
    raise exception '0052 PROOF: unpublish left a status or a publication behind';
  end if;

  raise notice '0052 proof: deterministic owner-scoped token that sees Keeps and raw_input; a blocking import refuses; publish writes status and copy together; a stale token and invalid snapshots are refused with the live copy intact; unpublish removes both.';
end $$;

rollback to savepoint publication_probe;
release savepoint publication_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0052-probe-%@invalid.example') then
    raise exception 'MIGRATION 0052 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
