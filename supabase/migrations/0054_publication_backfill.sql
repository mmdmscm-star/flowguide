-- ============================================================================
-- 0054 — FREEZE THE COPY RECIPIENTS ALREADY SEE, FOR SENDSETS PUBLISHED BEFORE 0052.
--
-- Sendsets published before the publish route switched to publish_packet have
-- no packet_publications row. Before readers switch to the frozen copy, each
-- needs one that is exactly what its public page renders today. The copy is
-- built in TypeScript by the same builder publish uses
-- (scripts/publication-backfill.mts); this migration adds the one narrow door
-- that stores it.
--
--   1. public.packet_backfill_token(packet) reads, in one statement, every input
--      the live recipient page depends on that draft_rev does not already count:
--      status, published_at, draft_rev, the stored identity snapshot and — only
--      when that snapshot is null and the page therefore shows the live account
--      profile — whether that profile exists and its identity_rev. It also says
--      whether a publication already exists.
--   2. public.backfill_packet_publication(packet, expected token, format, content)
--      locks the Sendset, refuses unless it is published and has no publication,
--      recomputes the token and refuses on any difference, validates the copy
--      with publish_packet's rules (copied verbatim; asserted below against the
--      INSTALLED publish_packet), and inserts one row.
--
-- WHAT IT NEVER DOES: change a status, published_at, professional_snapshot or any
-- other packets column (it writes no packets row at all, so 0053's door is never
-- reached); run publish gates; overwrite or update a publication.
--
-- THE ROW IT WRITES:
--   published_at        = the Sendset's existing published_at (when recipients
--                         started seeing it), not now().
--   source_draft_rev    = the Sendset's draft_rev: the copy is built from these rows.
--   identity_dependency = from identity_mode, exactly as publish_packet derives it.
--   source_identity_rev = the profile's identity_rev ONLY when the stored snapshot
--                         is null (the frozen card IS the current profile). When a
--                         snapshot is stored, the revision it was taken at is
--                         unknown, so it is NULL: "may differ", never a false
--                         "unchanged".
--
-- GRANTS. Both functions: EXECUTE for service_role only.
--
-- ROLLBACK: supabase/rollbacks/0054_publication_backfill_down.sql (functions).
-- Backfilled ROWS are removed only by the manifest-bound SQL the backfill script
-- generates, never by this rollback.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  if to_regclass('public.packet_publications') is null then
    raise exception 'MIGRATION 0054 ABORTED: packet_publications (0050) does not exist.';
  end if;
  if to_regprocedure('public.publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)') is null then
    raise exception 'MIGRATION 0054 ABORTED: publish_packet (0052) does not exist; its validation is the rule this copies.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_packet_status_single_door' and tgrelid = 'public.packets'::regclass) then
    raise exception 'MIGRATION 0054 ABORTED: the single-door status trigger (0053) does not exist.';
  end if;
  foreach f in array array['packet_backfill_token(uuid)', 'backfill_packet_publication(uuid,jsonb,smallint,jsonb)'] loop
    if to_regprocedure('public.' || f) is not null then
      raise exception 'MIGRATION 0054 ABORTED: public.% already exists.', f;
    end if;
  end loop;
end $$;

create temp table _0054_before on commit drop as
  select 'packet' as kind, p.id, md5(row(p.*)::text) as v from public.packets p
  union all select 'publication', x.packet_id, md5(row(x.*)::text) from public.packet_publications x
  union all select 'profile', f.id, md5(row(f.*)::text) from public.professional_profiles f;

-- ---------------------------------------------------------------------------
-- 1. THE BACKFILL TOKEN.
--
-- The live page renders packets columns and content rows (all counted by
-- draft_rev, 0050), plus an identity: the stored professional_snapshot, or the
-- live account profile when that snapshot is null (SQL NULL or JSON null — the
-- page cannot tell them apart). identity_rev counts every profile column the page
-- renders. NULL when the Sendset does not exist.
-- ---------------------------------------------------------------------------
create function public.packet_backfill_token(p_packet_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'format', 1,
    'status', p.status,
    -- As exact epoch text: a timestamptz rendered into jsonb follows the session
    -- TimeZone, and a JSON number would lose microseconds in JavaScript.
    'published_at', extract(epoch from p.published_at)::text,
    'draft_rev', p.draft_rev,
    'identity_mode', p.identity_mode,
    'professional_snapshot', p.professional_snapshot,
    'identity_from_profile', coalesce(jsonb_typeof(p.professional_snapshot), 'null') = 'null',
    'profile_exists', case when coalesce(jsonb_typeof(p.professional_snapshot), 'null') = 'null'
                           then exists (select 1 from public.professional_profiles f where f.user_id = p.user_id) end,
    'identity_rev', case when coalesce(jsonb_typeof(p.professional_snapshot), 'null') = 'null'
                         then (select f.identity_rev from public.professional_profiles f where f.user_id = p.user_id) end,
    'has_publication', exists (select 1 from public.packet_publications x where x.packet_id = p.id)
  ) end
  from (select 1) one
  left join public.packets p on p.id = p_packet_id
$$;

comment on function public.packet_backfill_token(uuid) is
  'Every input the live recipient page depends on beyond draft_rev, in one statement (0054). The backfill script reads it before building the copy; backfill_packet_publication recomputes it under the Sendset lock and refuses on any difference. service_role only.';

-- ---------------------------------------------------------------------------
-- 2. THE BACKFILL.
--
-- Errors carry PostgREST status codes and a stable DETAIL:
--   not_found            no such Sendset
--   not_published        the Sendset is not published, or has no published_at
--   publication_exists   a publication row already exists (it is never touched)
--   changed              the token differs: something changed after it was read
--   invalid_snapshot     publish_packet's snapshot rules refuse the copy
-- ---------------------------------------------------------------------------
create function public.backfill_packet_publication(
  p_packet_id uuid, p_expected_token jsonb, p_format_version smallint, p_content jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pk record; v_token jsonb; v_foreign int; v_dep text; v_digest text;
begin
  select id, slug, status, published_at, draft_rev, identity_mode, composition_mode into v_pk
    from public.packets where id = p_packet_id for update;
  if v_pk.id is null then
    raise exception 'backfill: Sendset not found' using errcode = 'PT404', detail = 'not_found';
  end if;
  if v_pk.status is distinct from 'published' or v_pk.published_at is null then
    raise exception 'backfill: only a published Sendset is backfilled' using errcode = 'PT409', detail = 'not_published';
  end if;
  if exists (select 1 from public.packet_publications x where x.packet_id = p_packet_id) then
    raise exception 'backfill: this Sendset already has a publication' using errcode = 'PT409', detail = 'publication_exists';
  end if;

  -- THE BINDING. Everything the copy was built from, recomputed under the lock.
  v_token := public.packet_backfill_token(p_packet_id);
  if v_token is distinct from p_expected_token then
    raise exception 'backfill: this Sendset changed after the copy was built' using errcode = 'PT409', detail = 'changed';
  end if;

  -- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.
  if p_format_version is distinct from 1::smallint then
    raise exception 'backfill: unsupported snapshot format %', p_format_version using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  if jsonb_typeof(p_content) is distinct from 'object' or p_content ->> 'slug' is distinct from v_pk.slug then
    raise exception 'backfill: the snapshot is not this Sendset' using errcode = 'PT400', detail = 'invalid_snapshot';
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
    raise exception 'backfill: the snapshot names % section, item or block id(s) outside this Sendset', v_foreign
      using errcode = 'PT400', detail = 'invalid_snapshot';
  end if;
  if v_pk.composition_mode = 'blocks' then
    perform public.assert_packet_block_consistency(p_packet_id);
  end if;

  -- THE WRITE. One new row; never an update.
  v_dep := case when v_pk.identity_mode = 'default' then 'account_profile' else 'sendset' end;
  begin
    insert into public.packet_publications
           (packet_id, format_version, content, source_draft_rev, identity_dependency, source_identity_rev, published_at)
    values (p_packet_id, p_format_version, p_content, v_pk.draft_rev, v_dep,
            case when v_dep = 'account_profile' and (v_token ->> 'identity_from_profile')::boolean
                 then (v_token ->> 'identity_rev')::bigint end,
            v_pk.published_at);
  exception when check_violation then
    raise exception 'backfill: the snapshot is not recipient-safe (%)', sqlerrm using errcode = 'PT400', detail = 'invalid_snapshot';
  end;

  -- The digest of the STORED jsonb (whose text form does not depend on the key
  -- order the caller sent), so a rollback can recognise this exact row later.
  select encode(sha256(convert_to(x.content::text, 'UTF8')), 'hex') into v_digest
    from public.packet_publications x where x.packet_id = p_packet_id;

  return jsonb_build_object('packetId', p_packet_id, 'publishedAt', v_pk.published_at,
                            'sourceDraftRev', v_pk.draft_rev, 'identityDependency', v_dep,
                            'contentSha256', v_digest);
end;
$$;

comment on function public.backfill_packet_publication(uuid, jsonb, smallint, jsonb) is
  'Store the frozen copy of a Sendset published before 0052 (0054): only when published, only when no publication exists, only with an unchanged backfill token; publish_packet''s snapshot rules; published_at preserved; writes no packets row. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. GRANTS.
-- ---------------------------------------------------------------------------
revoke all on function public.packet_backfill_token(uuid) from public, anon, authenticated, service_role;
revoke all on function public.backfill_packet_publication(uuid, jsonb, smallint, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.packet_backfill_token(uuid) to service_role;
grant execute on function public.backfill_packet_publication(uuid, jsonb, smallint, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; role_name text; n int; v_publish text; v_backfill text;
begin
  for r in select * from (values ('packet_backfill_token(uuid)'), ('backfill_packet_publication(uuid,jsonb,smallint,jsonb)')) t(sig) loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = ('public.' || r.sig)::regprocedure
         and p.prosecdef
         and 'search_path=""' = any (p.proconfig)
         and p.proacl is not null
         and not exists (select 1 from aclexplode(p.proacl) a
                          where a.grantee <> p.proowner
                            and a.grantee <> (select oid from pg_roles where rolname = 'service_role'))
    ) then
      raise exception 'MIGRATION 0054 ABORTED: public.% has the wrong security, search_path or grants.', r.sig;
    end if;
    foreach role_name in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_name, 'public.' || r.sig, 'EXECUTE') then
        raise exception 'MIGRATION 0054 ABORTED: % can execute public.%.', role_name, r.sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', 'public.' || r.sig, 'EXECUTE') then
      raise exception 'MIGRATION 0054 ABORTED: service_role cannot execute public.%.', r.sig;
    end if;
  end loop;

  -- PARITY WITH THE INSTALLED publish_packet. The validation block, from its
  -- heading to the write, must be publish_packet's own — minus the one check on
  -- the identity snapshot a backfill does not take, and with the message prefix
  -- 'backfill:' for 'publish:'. Whitespace-insensitive.
  select regexp_replace(
           regexp_replace(
             substring(prosrc from position('-- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.' in prosrc)
                              for position('-- THE WRITE.' in prosrc) - position('-- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.' in prosrc)),
             'if jsonb_typeof\(p_professional_snapshot\) is distinct from ''object'' then.*?end if;', ''),
           '\s+', ' ', 'g')
    into v_publish from pg_proc where oid = 'public.publish_packet(uuid,uuid,jsonb,smallint,jsonb,jsonb)'::regprocedure;
  select regexp_replace(
           replace(
             substring(prosrc from position('-- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.' in prosrc)
                              for position('-- THE WRITE.' in prosrc) - position('-- THE SNAPSHOT MUST BE A RECIPIENT-SAFE COPY OF THIS SENDSET.' in prosrc)),
             '''backfill: ', '''publish: '),
           '\s+', ' ', 'g')
    into v_backfill from pg_proc where oid = 'public.backfill_packet_publication(uuid,jsonb,smallint,jsonb)'::regprocedure;
  if v_publish is null or length(v_publish) < 500 or v_publish is distinct from v_backfill then
    raise exception 'MIGRATION 0054 ABORTED: the backfill''s snapshot validation is not publish_packet''s.';
  end if;

  -- Nothing existing was written.
  select count(*) into n from (
    select 'packet' as kind, p.id, md5(row(p.*)::text) as v from public.packets p
    union all select 'publication', x.packet_id, md5(row(x.*)::text) from public.packet_publications x
    union all select 'profile', f.id, md5(row(f.*)::text) from public.professional_profiles f
  ) now_rows full join _0054_before b using (kind, id)
  where now_rows.v is distinct from b.v;
  if n <> 0 then raise exception 'MIGRATION 0054 ABORTED: % existing row(s) changed.', n; end if;

  raise notice '0054 catalog: token and backfill (definer), service_role-only execute; validation identical to the installed publish_packet; no existing row changed.';
end $$;

-- ---------------------------------------------------------------------------
-- 5. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
--
-- The Sendset is published through publish_packet (the only door), then its
-- publication is removed and its identity snapshot cleared, which is exactly the
-- shape of a Sendset published before 0052.
-- ---------------------------------------------------------------------------
savepoint backfill_probe;

do $$
declare
  u uuid; pk uuid; sec uuid; it uuid; v_slug text; v_content jsonb; v_token jsonb; v_row record;
  v_before text; v_result jsonb; v_detail text;
begin
  insert into public.users (email) values ('migration-0054-probe-' || gen_random_uuid() || '@invalid.example') returning id into u;
  insert into public.professional_profiles (user_id, name, phone) values (u, 'Probe', '555-0100');
  insert into public.packets (user_id, slug, title) values (u, 'mig0054probe' || substr(md5(random()::text), 1, 12), 'probe')
    returning id, slug into pk, v_slug;
  insert into public.sections (packet_id, title) values (pk, 'S') returning id into sec;
  insert into public.items (section_id, title) values (sec, 'I') returning id into it;
  v_content := jsonb_build_object('slug', v_slug, 'sections', jsonb_build_array(jsonb_build_object('id', sec, 'items', jsonb_build_array(jsonb_build_object('id', it)))));

  begin
    perform public.backfill_packet_publication(pk, public.packet_backfill_token(pk), 1::smallint, v_content);
    raise exception '0054 PROOF: a draft was backfilled';
  exception when sqlstate 'PT409' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'not_published' then raise exception '0054 PROOF: draft refused with detail %', v_detail; end if;
  end;

  perform public.publish_packet(u, pk, public.packet_publish_token(u, pk), 1::smallint, v_content, '{}'::jsonb);
  begin
    perform public.backfill_packet_publication(pk, public.packet_backfill_token(pk), 1::smallint, v_content);
    raise exception '0054 PROOF: an existing publication was overwritten';
  exception when sqlstate 'PT409' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'publication_exists' then raise exception '0054 PROOF: existing publication refused with detail %', v_detail; end if;
  end;

  -- Shape it like a Sendset published before 0052.
  delete from public.packet_publications where packet_id = pk;
  update public.packets set professional_snapshot = null where id = pk;
  select md5(row(p.*)::text) into v_before from public.packets p where p.id = pk;

  v_token := public.packet_backfill_token(pk);
  update public.professional_profiles set name = 'Probe renamed' where user_id = u;
  begin
    perform public.backfill_packet_publication(pk, v_token, 1::smallint, v_content);
    raise exception '0054 PROOF: a stale token was accepted';
  exception when sqlstate 'PT409' then
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail <> 'changed' then raise exception '0054 PROOF: stale token refused with detail %', v_detail; end if;
  end;

  begin
    perform public.backfill_packet_publication(pk, public.packet_backfill_token(pk), 1::smallint, v_content || '{"title":"internal"}'::jsonb);
    raise exception '0054 PROOF: a snapshot carrying the internal title was accepted';
  exception when sqlstate 'PT400' then null;
  end;

  v_result := public.backfill_packet_publication(pk, public.packet_backfill_token(pk), 1::smallint, v_content);
  select x.*, p.published_at as packet_published_at, md5(row(p.*)::text) as packet_now into v_row
    from public.packet_publications x join public.packets p on p.id = x.packet_id where x.packet_id = pk;
  if v_row.published_at is distinct from v_row.packet_published_at
     or v_row.identity_dependency <> 'account_profile' or v_row.source_identity_rev is null
     or v_row.content is distinct from v_content or v_row.packet_now <> v_before
     or v_result ->> 'contentSha256' is distinct from encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex') then
    raise exception '0054 PROOF: the backfilled row is not as designed, or the Sendset row changed (%).', v_row;
  end if;

  raise notice '0054 proof: drafts and existing publications refused, a stale token refused, publish_packet''s rules applied, one row written with the Sendset''s published_at, no packets row touched.';
end $$;

rollback to savepoint backfill_probe;
release savepoint backfill_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0054-probe-%@invalid.example') then
    raise exception 'MIGRATION 0054 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
