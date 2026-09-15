-- ============================================================================
-- 0051 — AN IMPORT IS NOT FINISHED UNTIL ITS REVIEW IS RECORDED.
--
-- THE GAP. finalize_ingestion_run commits an import's content and sets the run
-- `finalized`. Only afterwards does the finalize route decide whether that
-- content needs review, and before 53fd4a2 it wrote `needs_review` in a
-- separate call. In between, the run was `finalized` and a publish could land.
-- No lock closes that: the unblocked state was committed.
--
-- THE FIX.
--   1. finalize_ingestion_run sets `review = {"pending": true}` in the SAME
--      UPDATE that sets `finalized`. That is its only change, and section 5
--      proves it: removing the one inserted fragment reproduces 0034's body.
--   2. public.packet_has_blocking_run(packet) is the one SQL definition of "an
--      import blocks publishing": active, finalizing, needs_review, or finalized
--      with review.pending = true. lib/import-blocking.ts states the same rule
--      for PostgREST, and a test compares the two.
--   3. block_publish_during_ingest asks that function.
--   4. The one-active-run index counts a pending run as holding its Sendset's
--      slot, as 0013 required of every non-terminal state.
--   5. A CHECK keeps the marker meaningful: `pending` may only be boolean true,
--      and only on a finalized run.
--
-- The route half (53fd4a2, da57d7b) is already deployed: it replaces the marker
-- with the decided verdict, fails closed, and replays finalize for a pending
-- run. See docs/migrations/0051-review-pending.md, including the limitation that
-- a deterministically failing check leaves a run pending.
--
-- EXISTING ROWS. No run carries `pending` (asserted), so nothing currently
-- finalized becomes blocked, no row is written, and no updated_at moves
-- (asserted). CREATE OR REPLACE keeps both functions' signatures and grants
-- (asserted against the before-picture).
--
-- ROLLBACK: supabase/rollbacks/0051_finalize_review_pending_down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS: production is exactly what this migration was written on.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  select md5(prosrc) as m, length(prosrc) as l, prosecdef, proconfig, proacl::text as acl into r
    from pg_proc where oid = 'public.finalize_ingestion_run(uuid,uuid)'::regprocedure;
  if r.m <> 'ebd3c4e438d0c04c760b11611cbd73e6' or r.l <> 12731 then
    raise exception 'MIGRATION 0051 ABORTED: finalize_ingestion_run is not 0034''s body (md5 %, % chars).', r.m, r.l;
  end if;
  if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then
    raise exception 'MIGRATION 0051 ABORTED: finalize_ingestion_run is no longer SECURITY DEFINER with an empty search_path.';
  end if;
  if r.acl <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'MIGRATION 0051 ABORTED: finalize_ingestion_run ACL is %, expected postgres + service_role only.', r.acl;
  end if;

  select md5(prosrc) as m, length(prosrc) as l into r
    from pg_proc where oid = 'public.block_publish_during_ingest()'::regprocedure;
  if r.m <> '5dc197d2fcff871d01c7bb10ffacefb3' or r.l <> 364 then
    raise exception 'MIGRATION 0051 ABORTED: block_publish_during_ingest is not 0013''s body (md5 %, % chars).', r.m, r.l;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_block_publish_during_ingest'
                  and tgrelid = 'public.packets'::regclass and tgenabled = 'O'
                  and tgfoid = 'public.block_publish_during_ingest()'::regprocedure) then
    raise exception 'MIGRATION 0051 ABORTED: trg_block_publish_during_ingest is not the enabled publish guard on packets.';
  end if;

  if (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'idx_ingestion_runs_one_active_packet')
     is distinct from 'CREATE UNIQUE INDEX idx_ingestion_runs_one_active_packet ON public.ingestion_runs USING btree (packet_id) WHERE ((destination = ''packet''::text) AND (status = ANY (ARRAY[''active''::text, ''finalizing''::text, ''needs_review''::text])))' then
    raise exception 'MIGRATION 0051 ABORTED: idx_ingestion_runs_one_active_packet is not the 0020 definition.';
  end if;

  if exists (select 1 from public.ingestion_runs where review ? 'pending') then
    raise exception 'MIGRATION 0051 ABORTED: a run already carries review.pending.';
  end if;
  if to_regprocedure('public.packet_has_blocking_run(uuid)') is not null then
    raise exception 'MIGRATION 0051 ABORTED: packet_has_blocking_run already exists.';
  end if;
  if exists (select 1 from pg_constraint where conname = 'ingestion_runs_review_pending_shape') then
    raise exception 'MIGRATION 0051 ABORTED: ingestion_runs_review_pending_shape already exists.';
  end if;
end $$;

-- The before-picture: every run and every packet, and the grants and library
-- index this migration must not change.
create temp table _0051_runs on commit drop as
  select id, status, review, updated_at, finalized_at from public.ingestion_runs;
create temp table _0051_packets on commit drop as
  select id, status, updated_at from public.packets;
create temp table _0051_catalog on commit drop as
  select (select proacl::text from pg_proc where oid = 'public.finalize_ingestion_run(uuid,uuid)'::regprocedure) as finalize_acl,
         (select coalesce(proacl::text, 'DEFAULT') from pg_proc where oid = 'public.block_publish_during_ingest()'::regprocedure) as trigger_acl,
         (select indexdef from pg_indexes where indexname = 'idx_ingestion_runs_one_active_library') as library_index;

-- ---------------------------------------------------------------------------
-- 1. THE ONE SQL DEFINITION OF "AN IMPORT BLOCKS PUBLISHING".
--
-- The marker is compared as JSON (`= 'true'::jsonb`), not as text, so only the
-- boolean true counts — the same rule lib/import-blocking.ts applies.
-- SECURITY INVOKER and executable by nobody but its owner: the SECURITY DEFINER
-- functions that call it run as that owner.
-- ---------------------------------------------------------------------------
create function public.packet_has_blocking_run(p_packet_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.ingestion_runs r
     where r.packet_id = p_packet_id
       and (r.status in ('active', 'finalizing', 'needs_review')
            or (r.status = 'finalized' and r.review -> 'pending' = 'true'::jsonb))
  )
$$;

comment on function public.packet_has_blocking_run(uuid) is
  'True while an import run blocks publishing this Sendset: active, finalizing, needs_review, or finalized with review.pending = true (0051). Mirrored for PostgREST by lib/import-blocking.ts.';

revoke all on function public.packet_has_blocking_run(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE MARKER STAYS MEANINGFUL.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add constraint ingestion_runs_review_pending_shape
  check (not (review ? 'pending') or (review -> 'pending' = 'true'::jsonb and status = 'finalized'));

-- ---------------------------------------------------------------------------
-- 3. FINALIZE SETS THE MARKER IN THE SAME UPDATE AS `finalized`.
--    0034's function, byte for byte, plus one fragment in that UPDATE.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_puser uuid; v_cur_rev bigint; v_cur_srev bigint; v_sec_packet uuid;
  v_prev int := 0; leaf record; v_cur_sections int; v_cur_items int;
  v_base_sort int; v_item_base int; v_target_section uuid;
  v_last_section uuid := null; v_first_sec boolean;
  sec jsonb; it jsonb; d jsonb; l jsonb; ph text; ct jsonb;
  v_new_section uuid; v_new_item uuid; di int; li int; pi int; ci int;
  v_sections int := 0; v_items int := 0;
  v_offset_base int := null;      -- 0014: where this run's source begins in packets.raw_input
  v_emit int := 0;                -- 0014: emission index of an item WITHIN its chunk
  -- ONE literal, measured and concatenated. Two copies could drift apart and
  -- silently shift every offset derived from the base, with nothing failing.
  v_delim constant text := E'\n\n--- Added ---\n\n';
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;

  -- 0021 GUARD. A LIBRARY run must never enter the packet path.
  --
  -- It would already fail without this: `from public.packets where id = null`
  -- returns no row and the next check raises 'packet not found'. But that is an
  -- accident of a lookup, not a stated rule, and it is indistinguishable from a
  -- genuinely deleted packet. Library imports finish through their own path and
  -- never create packet, section or item composition structures.
  if v_run.destination <> 'packet' then
    raise exception 'ingestion: run % has destination % and cannot use the packet path',
      p_run_id, v_run.destination;
  end if;
  if v_run.status = 'finalized' then return jsonb_build_object('status','finalized','reused',true); end if;
  if v_run.status <> 'active' then raise exception 'ingestion: run is % (cannot finalize)', v_run.status; end if;

  select status, user_id, content_rev, structural_rev into v_pstatus, v_puser, v_cur_rev, v_cur_srev from public.packets where id = v_run.packet_id for update;
  if v_puser is null then raise exception 'ingestion: packet not found'; end if;
  if v_puser <> p_owner then raise exception 'ingestion: caller does not own packet'; end if;
  if v_pstatus <> 'draft' then raise exception 'ingestion: packet is not draft (cannot finalize)'; end if;

  -- Authoritative change detection: the content revision must exactly match the
  -- value captured when the run began (any edit/reorder/child change bumped it).
  if v_cur_srev <> v_run.baseline_structural_rev then
    raise exception 'ingestion: packet structure changed since the import began (structural_rev % <> %)', v_cur_srev, v_run.baseline_structural_rev;
  end if;
  -- Supplementary count assertions.
  select count(*) into v_cur_sections from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_cur_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  if v_cur_sections <> v_run.baseline_section_count or v_cur_items <> v_run.baseline_item_count then
    raise exception 'ingestion: packet content changed since the import began (counts % / %)', v_cur_sections, v_cur_items;
  end if;

  -- Coverage/completeness over LEAF chunks, in JS UTF-16 code-unit offsets.
  for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
    if leaf.status <> 'completed' then raise exception 'ingestion: chunk % not completed', leaf.ordinal; end if;
    if leaf.source_start <> v_prev then raise exception 'ingestion: coverage gap/overlap at %', leaf.source_start; end if;
    v_prev := leaf.source_end;
  end loop;
  if v_prev <> v_run.source_len then raise exception 'ingestion: chunks do not cover the whole source (% of %)', v_prev, v_run.source_len; end if;

  -- ---- Apply to the canonical packet ----
  if v_run.entry_point in ('organize','append') then
    select coalesce(max(sort_order),-1)+1 into v_base_sort from public.sections where packet_id = v_run.packet_id;
    for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
      v_first_sec := true;
      v_emit := 0;
      for sec in select value from jsonb_array_elements(coalesce(leaf.result->'sections','[]'::jsonb)) loop
        if v_first_sec and leaf.is_continuation and v_last_section is not null then
          v_new_section := v_last_section;  -- continuation spillover joins previous group (never by title)
        else
          insert into public.sections (packet_id, title, description, sort_order)
            values (v_run.packet_id, coalesce(nullif(sec->>'title',''),'Section'), coalesce(sec->>'description',''), v_base_sort)
            returning id into v_new_section;
          v_base_sort := v_base_sort + 1; v_sections := v_sections + 1;
        end if;
        v_last_section := v_new_section; v_first_sec := false;

        select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_new_section;
        for it in select value from jsonb_array_elements(coalesce(sec->'items','[]'::jsonb)) loop
          insert into public.items (section_id, title, address, description, notes, sort_order,
                                    origin_run_id, origin_chunk_ordinal, origin_emit_index)
            values (v_new_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                    coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base,
                    p_run_id, leaf.ordinal, v_emit)
            returning id into v_new_item;
          v_item_base := v_item_base + 1; v_items := v_items + 1; v_emit := v_emit + 1;
          di := 0;
          for d in select value from jsonb_array_elements(coalesce(it->'details','[]'::jsonb)) loop
            insert into public.item_details (item_id,label,value,sort_order) values (v_new_item, coalesce(d->>'label',''), coalesce(d->>'value',''), di); di := di+1;
          end loop;
          li := 0;
          for l in select value from jsonb_array_elements(coalesce(it->'links','[]'::jsonb)) loop
            if coalesce(l->>'url','') like 'http%' then
              insert into public.item_links (item_id,url,label,sort_order) values (v_new_item, l->>'url', coalesce(l->>'label',''), li); li := li+1;
            end if;
          end loop;
          pi := 0;
          for ph in select value from jsonb_array_elements_text(coalesce(it->'photos','[]'::jsonb)) loop
            if ph like 'http%' then insert into public.item_photos (item_id,url,storage_path,sort_order) values (v_new_item, ph, '', pi); pi := pi+1; end if;
          end loop;
          ci := 0;
          for ct in select value from jsonb_array_elements(
            coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)) loop
            if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
              insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
                values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''), coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
            end if;
          end loop;
        end loop;
      end loop;
    end loop;

    if v_run.entry_point = 'organize' then
      -- raw_input is REPLACED by this run's source, so the base is provably 0.
      v_offset_base := 0;
      update public.packets set
        title = case when v_run.derived_title <> '' then v_run.derived_title else title end,
        client_name = case when v_run.derived_client_name <> '' then v_run.derived_client_name else client_name end,
        raw_input = coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    else
      -- Measure where this run's source will LAND, BEFORE concatenating, in JS
      -- UTF-16 code units so the base shares one frame with the chunk offsets.
      select public.utf16_length(coalesce(raw_input,'')) + public.utf16_length(v_delim)
        into v_offset_base from public.packets where id = v_run.packet_id;
      update public.packets set raw_input = coalesce(raw_input,'') || v_delim || coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    end if;

  else  -- section_append: items only, into the named section
    v_target_section := v_run.target_section_id;
    select packet_id into v_sec_packet from public.sections where id = v_target_section;
    if v_sec_packet is null or v_sec_packet <> v_run.packet_id then raise exception 'ingestion: target section no longer valid'; end if;
    select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_target_section;
    for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
      v_emit := 0;
      for it in select value from jsonb_array_elements(coalesce(leaf.result->'items','[]'::jsonb)) loop
        insert into public.items (section_id, title, address, description, notes, sort_order,
                                  origin_run_id, origin_chunk_ordinal, origin_emit_index)
          values (v_target_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                  coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base,
                  p_run_id, leaf.ordinal, v_emit)
          returning id into v_new_item;
        v_item_base := v_item_base + 1; v_items := v_items + 1; v_emit := v_emit + 1;
        di := 0;
        for d in select value from jsonb_array_elements(coalesce(it->'details','[]'::jsonb)) loop
          insert into public.item_details (item_id,label,value,sort_order) values (v_new_item, coalesce(d->>'label',''), coalesce(d->>'value',''), di); di := di+1;
        end loop;
        li := 0;
        for l in select value from jsonb_array_elements(coalesce(it->'links','[]'::jsonb)) loop
          if coalesce(l->>'url','') like 'http%' then insert into public.item_links (item_id,url,label,sort_order) values (v_new_item, l->>'url', coalesce(l->>'label',''), li); li := li+1; end if;
        end loop;
        pi := 0;
        for ph in select value from jsonb_array_elements_text(coalesce(it->'photos','[]'::jsonb)) loop
          if ph like 'http%' then insert into public.item_photos (item_id,url,storage_path,sort_order) values (v_new_item, ph, '', pi); pi := pi+1; end if;
        end loop;
        ci := 0;
        for ct in select value from jsonb_array_elements(
          coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)) loop
          if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
            insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
              values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''), coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
          end if;
        end loop;
      end loop;
    end loop;
    -- Measure where this run's source will LAND, BEFORE concatenating, in JS
    -- UTF-16 code units so the base shares one frame with the chunk offsets.
    select public.utf16_length(coalesce(raw_input,'')) + public.utf16_length(v_delim)
      into v_offset_base from public.packets where id = v_run.packet_id;
    update public.packets set raw_input = coalesce(raw_input,'') || v_delim || coalesce(v_run.source_text,'')
      where id = v_run.packet_id;
  end if;

  -- Finalize + privacy cleanup (same transaction): drop ALL source-derived fields.
  -- Clearing the origin marker means the finalized packet is no longer an
  -- orphan-import candidate for any later discard.
  update public.packets set origin_ingestion_run_id = null
    where id = v_run.packet_id and origin_ingestion_run_id = p_run_id;
  update public.ingestion_runs
    set status = 'finalized', review = '{"pending": true}'::jsonb, finalized_at = now(), completed_chunks = total_chunks,
        source_offset_base = v_offset_base,
        derived_title = '', derived_client_name = '', error = '',
        evidence_purge_after = now() + interval '30 days', updated_at = now()
    where id = p_run_id;
  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE PUBLISH GUARD ASKS THE ONE DEFINITION.
-- ---------------------------------------------------------------------------
create or replace function public.block_publish_during_ingest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if public.packet_has_blocking_run(new.id) then
      raise exception 'cannot publish while an import is in progress, needs review, or is still being checked';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A PENDING RUN HOLDS ITS SENDSET'S ONE RUN SLOT.
-- ---------------------------------------------------------------------------
drop index public.idx_ingestion_runs_one_active_packet;
create unique index idx_ingestion_runs_one_active_packet
  on public.ingestion_runs (packet_id)
  where destination = 'packet'
    and (status in ('active', 'finalizing', 'needs_review')
         or (status = 'finalized' and review -> 'pending' = 'true'::jsonb));

-- ---------------------------------------------------------------------------
-- 6. CATALOG ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; n int; v_src text;
begin
  -- Finalize: exactly one fragment added, nothing else changed.
  select prosrc, prosecdef, proconfig, proacl::text as acl into r
    from pg_proc where oid = 'public.finalize_ingestion_run(uuid,uuid)'::regprocedure;
  if md5(r.prosrc) <> '9767c7b488c565a2793df80da442b495' then
    raise exception 'MIGRATION 0051 ABORTED: new finalize body md5 is %, expected 9767c7b488c565a2793df80da442b495.', md5(r.prosrc);
  end if;
  if md5(replace(r.prosrc, 'review = ''{"pending": true}''::jsonb, ', '')) <> 'ebd3c4e438d0c04c760b11611cbd73e6' then
    raise exception 'MIGRATION 0051 ABORTED: removing the pending fragment does not reproduce 0034''s finalize body.';
  end if;
  if length(r.prosrc) - length(replace(r.prosrc, 'review = ''{"pending": true}''::jsonb, ', '')) <> length('review = ''{"pending": true}''::jsonb, ') then
    raise exception 'MIGRATION 0051 ABORTED: the pending fragment does not appear exactly once.';
  end if;
  if not r.prosecdef or not ('search_path=""' = any(r.proconfig))
     or r.acl is distinct from (select finalize_acl from _0051_catalog) then
    raise exception 'MIGRATION 0051 ABORTED: finalize_ingestion_run security or grants changed (acl %).', r.acl;
  end if;

  -- Publish guard: asks the helper, keeps its security and (absent) grants.
  select prosrc, prosecdef, proconfig, coalesce(proacl::text, 'DEFAULT') as acl into r
    from pg_proc where oid = 'public.block_publish_during_ingest()'::regprocedure;
  if position('public.packet_has_blocking_run(new.id)' in r.prosrc) = 0
     or position('ingestion_runs' in r.prosrc) > 0 then
    raise exception 'MIGRATION 0051 ABORTED: block_publish_during_ingest does not delegate to packet_has_blocking_run.';
  end if;
  if not r.prosecdef or not ('search_path=""' = any(r.proconfig))
     or r.acl is distinct from (select trigger_acl from _0051_catalog) then
    raise exception 'MIGRATION 0051 ABORTED: block_publish_during_ingest security or grants changed (acl %).', r.acl;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_block_publish_during_ingest'
                  and tgrelid = 'public.packets'::regclass and tgenabled = 'O') then
    raise exception 'MIGRATION 0051 ABORTED: the publish guard trigger is gone.';
  end if;

  -- Helper: invoker, stable, pinned, executable by nobody but its owner.
  select provolatile, prosecdef, proconfig, proacl, proowner into r
    from pg_proc where oid = 'public.packet_has_blocking_run(uuid)'::regprocedure;
  if r.provolatile <> 's' or r.prosecdef or not ('search_path=""' = any(r.proconfig)) then
    raise exception 'MIGRATION 0051 ABORTED: packet_has_blocking_run must be STABLE, SECURITY INVOKER, empty search_path.';
  end if;
  if r.proacl is null or exists (select 1 from aclexplode(r.proacl) a where a.grantee <> r.proowner) then
    raise exception 'MIGRATION 0051 ABORTED: packet_has_blocking_run is executable by a role other than its owner.';
  end if;
  foreach v_src in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_src, 'public.packet_has_blocking_run(uuid)', 'EXECUTE') then
      raise exception 'MIGRATION 0051 ABORTED: % can execute packet_has_blocking_run.', v_src;
    end if;
  end loop;

  -- Indexes.
  select indexdef into v_src from pg_indexes where indexname = 'idx_ingestion_runs_one_active_packet';
  if position('CREATE UNIQUE INDEX' in v_src) <> 1 or position('(packet_id)' in v_src) = 0
     or position('destination = ''packet''' in v_src) = 0 or position('needs_review' in v_src) = 0
     or position('''finalized''' in v_src) = 0 or position('''pending''' in v_src) = 0
     or position('''true''::jsonb' in v_src) = 0 then
    raise exception 'MIGRATION 0051 ABORTED: the packet one-active index is not pending-aware: %', v_src;
  end if;
  if (select indexdef from pg_indexes where indexname = 'idx_ingestion_runs_one_active_library')
     is distinct from (select library_index from _0051_catalog) then
    raise exception 'MIGRATION 0051 ABORTED: the library one-active index changed.';
  end if;

  -- Constraint present and validated against every existing row.
  if not exists (select 1 from pg_constraint where conname = 'ingestion_runs_review_pending_shape'
                  and conrelid = 'public.ingestion_runs'::regclass and contype = 'c' and convalidated) then
    raise exception 'MIGRATION 0051 ABORTED: ingestion_runs_review_pending_shape is missing or not validated.';
  end if;

  -- Not one existing row written.
  select count(*) into n from _0051_runs b full join public.ingestion_runs cur on cur.id = b.id
   where (b.id, b.status, b.review, b.updated_at, b.finalized_at) is distinct from (cur.id, cur.status, cur.review, cur.updated_at, cur.finalized_at);
  if n <> 0 then raise exception 'MIGRATION 0051 ABORTED: % ingestion run row(s) differ from the before-picture.', n; end if;
  select count(*) into n from _0051_packets b full join public.packets p on p.id = b.id
   where (b.id, b.status, b.updated_at) is distinct from (p.id, p.status, p.updated_at);
  if n <> 0 then raise exception 'MIGRATION 0051 ABORTED: % packet row(s) differ from the before-picture.', n; end if;

  raise notice '0051 catalog: finalize = 0034 + pending fragment (grants kept), guard delegates to packet_has_blocking_run, helper owner-only, index pending-aware, library index untouched, CHECK validated, no row written.';
end $$;

-- ---------------------------------------------------------------------------
-- 7. BEHAVIOURAL PROOF on throwaway rows, discarded with ROLLBACK TO SAVEPOINT.
--    (The publish transition itself and a real finalize are exercised against a
--    replayed schema in scripts/pg-harness; a migration may not assign a
--    packet's status to published — see ownership-route.test.)
-- ---------------------------------------------------------------------------
savepoint review_pending_probe;

do $$
declare u uuid; pk uuid; run_a uuid; run_b uuid;
begin
  insert into public.users (email) values ('migration-0051-probe-' || gen_random_uuid() || '@invalid.example') returning id into u;
  insert into public.packets (user_id, slug, title) values (u, 'mig0051probe' || substr(md5(random()::text), 1, 12), 'probe')
    returning id into pk;

  if public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a Sendset with no runs is blocked'; end if;

  insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status, review)
    values (u, pk, 'append', 'probe', 'seg-v4', 'finalized', '{}') returning id into run_a;
  if public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a pre-0051 finalized run ({}) blocks'; end if;

  update public.ingestion_runs set review = '{"pending": true}' where id = run_a;
  if not public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a pending finalized run does not block'; end if;

  begin
    insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status)
      values (u, pk, 'append', 'probe', 'seg-v4', 'active');
    raise exception '0051 PROOF: a second run started while a pending run held the slot';
  exception when unique_violation then null;
  end;

  update public.ingestion_runs set review = '{"ok": true, "summary": ""}' where id = run_a;
  if public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a decided finalized run still blocks'; end if;

  insert into public.ingestion_runs (user_id, packet_id, entry_point, source_hash, segmenter_version, status)
    values (u, pk, 'append', 'probe', 'seg-v4', 'active') returning id into run_b;
  if not public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: an active run does not block'; end if;
  update public.ingestion_runs set status = 'needs_review', review = '{"ok": false}' where id = run_b;
  if not public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a needs_review run does not block'; end if;
  update public.ingestion_runs set status = 'discarded' where id = run_b;
  if public.packet_has_blocking_run(pk) then raise exception '0051 PROOF: a discarded run blocks'; end if;

  begin
    update public.ingestion_runs set status = 'needs_review', review = '{"pending": true}' where id = run_a;
    raise exception '0051 PROOF: pending was accepted on a run that is not finalized';
  exception when check_violation then null;
  end;
  begin
    update public.ingestion_runs set review = '{"pending": "true"}' where id = run_a;
    raise exception '0051 PROOF: a text "true" was accepted as the pending marker';
  exception when check_violation then null;
  end;

  raise notice '0051 proof: no runs / {} / decided / discarded do not block; pending, active, needs_review do; a pending run holds the slot; the marker is boolean-only and finalized-only.';
end $$;

rollback to savepoint review_pending_probe;
release savepoint review_pending_probe;

do $$
begin
  if exists (select 1 from public.users where email like 'migration-0051-probe-%@invalid.example') then
    raise exception 'MIGRATION 0051 ABORTED: the probe left a row behind.';
  end if;
end $$;

commit;
