-- 0034 - STRUCTURAL REVISION: stop punishing a professional for typing.
--
-- THE BUG. finalize_ingestion_run required packets.content_rev to equal the
-- value captured when the run began. content_rev is bumped by BOTH structural
-- change (sections/items/details/links/photos/contacts) AND packet metadata
-- (title, client_name, personal_note, map_url, identity_mode, custom_identity,
-- composition_mode). So a professional who typed a title while a 1-3 minute
-- import was running made the run UNFINALIZABLE - permanently, because every
-- retry and every auto-resume re-read the same mismatch. The only exit was to
-- discard a packet whose content had been fully computed. Reproduced from a
-- real stuck run (ce6bfcea, 2026-08-22): replaying its stored chunk results
-- finalizes cleanly; adding one title edit makes it fail forever.
--
-- THE FIX. A second counter that moves ONLY on the changes that can actually
-- conflict with an append-only import. Metadata never touches it.
--
--   ingest_bump_packet_self()  metadata  -> content_rev only        (UNCHANGED)
--   ingest_bump_by_packet()    sections, packet_blocks -> both
--   ingest_bump_by_section()   items                   -> both
--   ingest_bump_by_item()      details/links/photos/contacts -> both
--
-- content_rev KEEPS ITS EXACT MEANING and every existing consumer. Structural
-- change still bumps it. Only the finalize GUARD moves to structural_rev.
--
-- The count assertions immediately after the guard are deliberately kept. They
-- are a cheap second opinion, and structural_rev additionally closes their
-- known blind spot: a delete+add that nets to the same count bumps the counter
-- twice and is caught, where the counts alone saw nothing.
--
-- WHY PHOTOS STAY GUARDED even though they cannot move an import's placement:
-- media accounting after finalize is PACKET-WIDE, not run-scoped. A photo added
-- mid-run that is neither creator-uploaded nor named in the source produces
-- `media_not_in_source`, which blocks publishing. Letting it through the guard
-- would trade a clear conflict for a confusing publish block later.
--
-- SCOPE. Guard only. No placement logic changes: finalize already computes
-- where content lands from max(sort_order) at apply time, never from a
-- baseline, so nothing here can move a row. library_import is untouched - the
-- packet path rejects `destination <> 'packet'` before the guard is reached.

begin;

-- ---------------------------------------------------------------------------
-- PRECONDITION, enforced rather than remembered.
--
-- A run that is mid-flight when this deploys has baseline_structural_rev = 0
-- (the column default) while its packet's structural_rev is also 0 - so
-- structural changes it made BEFORE this migration existed would be invisible
-- to the new guard, and the run would finalize as if nothing had happened.
-- Rather than trust a manual check, refuse to migrate.
--
-- Runs whose packet is already deleted (packet_id is null) can never finalize -
-- the packet path raises 'packet not found' - so they cannot be made unsafe by
-- this change and are excluded. At authoring time exactly one such orphan
-- exists: ce6bfcea, the 2026-08-22 stuck run whose packet was deleted.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.ingestion_runs
    where status in ('active','finalizing') and packet_id is not null;
  if n > 0 then
    raise exception
      'MIGRATION 0034 ABORTED: % ingestion run(s) are in flight with a live packet. Let them finish or discard them, then re-run.', n;
  end if;
end $$;

alter table packets add column structural_rev bigint not null default 0;

comment on column packets.structural_rev is
  'Bumped by structural/content-row changes (sections, items, details, links, photos, contacts, blocks) and NEVER by packet metadata. Used only as the ingestion concurrency guard in finalize_ingestion_run. MEANINGFUL ONLY FROM 0034 FORWARD: every existing packet starts at 0 regardless of its history, so this must never be read as a general "has this packet ever changed" oracle.';

alter table ingestion_runs add column baseline_structural_rev bigint not null default 0;

comment on column ingestion_runs.baseline_structural_rev is
  'packets.structural_rev captured when this run began. finalize compares against it. Existing rows default to 0; see the 0034 precondition for why no run may be in flight across this migration.';

-- ---------------------------------------------------------------------------
-- The three CHILD triggers now move both counters. ingest_bump_packet_self()
-- is deliberately NOT redefined: metadata must not touch structural_rev, and
-- that function is the whole reason this migration exists.
--
-- These are BEFORE/AFTER trigger functions with no arguments and unchanged
-- signatures, so CREATE OR REPLACE preserves their grants (they are revoked
-- from every role and never granted, per 0012).
-- ---------------------------------------------------------------------------

create or replace function public.ingest_bump_by_packet() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  pid := case when tg_op = 'DELETE' then old.packet_id else new.packet_id end;
  if pid is not null then update public.packets set content_rev = content_rev + 1, structural_rev = structural_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_section() returns trigger
language plpgsql security definer set search_path = '' as $$
declare sid uuid; pid uuid;
begin
  sid := case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  select packet_id into pid from public.sections where id = sid;
  if pid is not null then update public.packets set content_rev = content_rev + 1, structural_rev = structural_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare iid uuid; pid uuid;
begin
  iid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  select s.packet_id into pid from public.items i join public.sections s on s.id = i.section_id where i.id = iid;
  if pid is not null then update public.packets set content_rev = content_rev + 1, structural_rev = structural_rev + 1 where id = pid; end if;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION public.create_organize_run(p_owner uuid, p_packet_type text, p_slug text, p_source_text text, p_source_hash text, p_source_len integer, p_request_key text, p_segmenter_version text, p_chunks jsonb, p_delimiter_hint text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_packet uuid; v_run uuid; v_hash text; c jsonb; n int;
begin
  if p_request_key is null or length(p_request_key) < 8 then raise exception 'ingestion: a request key is required'; end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  -- Idempotency: an existing run for (owner, request_key) is returned as-is when
  -- the source matches; reuse of the key with a different source is rejected.
  select id, packet_id, source_hash into v_run, v_packet, v_hash
    from public.ingestion_runs where user_id = p_owner and request_key = p_request_key;
  if v_run is not null then
    if v_hash <> p_source_hash then raise exception 'ingestion: request key reused with a different source'; end if;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', true);
  end if;

  -- Create packet + run + plan + origin marker. A concurrent identical request
  -- loses the (user_id, request_key) unique race; we roll back its packet insert
  -- and return the winner's packet/run (exactly one of each).
  begin
    insert into public.packets (user_id, slug, packet_type, status)
      values (p_owner, p_slug, coalesce(nullif(p_packet_type,''),'general'), 'draft')
      returning id into v_packet;

    insert into public.ingestion_runs (
      user_id, packet_id, entry_point, source_text, source_hash, source_len, request_key,
      segmenter_version, delimiter_hint, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev, baseline_structural_rev
    ) values (
      p_owner, v_packet, 'organize', p_source_text, p_source_hash, p_source_len, p_request_key,
      p_segmenter_version, nullif(p_delimiter_hint,''), 'active', n, 0, 0, 0, 0, 0
    ) returning id into v_run;

    for c in select value from jsonb_array_elements(p_chunks) loop
      insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
      values (v_run, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
              c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
              coalesce((c->>'is_continuation')::boolean, false), 'pending');
    end loop;

    update public.packets set origin_ingestion_run_id = v_run where id = v_packet;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', false);
  exception when unique_violation then
    select id, packet_id, source_hash into v_run, v_packet, v_hash
      from public.ingestion_runs where user_id = p_owner and request_key = p_request_key;
    if v_run is null then raise; end if;  -- some other unique conflict
    if v_hash <> p_source_hash then raise exception 'ingestion: request key reused with a different source'; end if;
    return jsonb_build_object('packet_id', v_packet, 'run_id', v_run, 'reused', true);
  end;
end;
$function$;

create or replace function public.create_ingestion_run(
  p_owner uuid,
  p_packet_id uuid,
  p_entry_point text,
  p_target_section_id uuid,
  p_source_text text,
  p_source_hash text,
  p_source_len int,
  p_segmenter_version text,
  p_chunks jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid; v_status text; v_mode text; v_rev bigint; v_srev bigint;
  v_sec_packet uuid; v_run_id uuid; v_base_sections int; v_base_items int; c jsonb; n int;
begin
  if p_entry_point not in ('append','section_append') then
    raise exception 'ingestion: create_ingestion_run is for append/section_append (got %)', p_entry_point;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  select user_id, status, composition_mode, content_rev, structural_rev into v_user, v_status, v_mode, v_rev, v_srev
    from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'ingestion: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'ingestion: packet % is not draft', p_packet_id; end if;
  -- Both append entry points are legacy-only. Finalization for them writes rows
  -- into sections/items, which is NOT the canonical representation for a block
  -- packet (packet_blocks is). Allowing either in block mode would create content
  -- invisible to the block editor and recipient renderer.
  if p_entry_point in ('append','section_append') and v_mode <> 'legacy' then
    raise exception 'ingestion: % requires legacy composition mode', p_entry_point;
  end if;

  if p_entry_point = 'section_append' then
    if p_target_section_id is null then raise exception 'ingestion: section_append needs a target section'; end if;
    select packet_id into v_sec_packet from public.sections where id = p_target_section_id;
    if v_sec_packet is null or v_sec_packet <> p_packet_id then
      raise exception 'ingestion: target section does not belong to packet';
    end if;
  end if;

  select count(*) into v_base_sections from public.sections where packet_id = p_packet_id;
  select count(*) into v_base_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = p_packet_id;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, target_section_id, source_text, source_hash, source_len,
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev, baseline_structural_rev
  ) values (
    p_owner, p_packet_id, p_entry_point,
    case when p_entry_point = 'section_append' then p_target_section_id else null end,
    p_source_text, p_source_hash, p_source_len, p_segmenter_version, 'active', n, 0, v_base_sections, v_base_items, v_rev, v_srev
  ) returning id into v_run_id;

  for c in select value from jsonb_array_elements(p_chunks) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
    values (v_run_id, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
            c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
            coalesce((c->>'is_continuation')::boolean, false), 'pending');
  end loop;

  return v_run_id;
end;
$$;

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
    set status = 'finalized', finalized_at = now(), completed_chunks = total_chunks,
        source_offset_base = v_offset_base,
        derived_title = '', derived_client_name = '', error = '',
        evidence_purge_after = now() + interval '30 days', updated_at = now()
    where id = p_run_id;
  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- RECOVERY (D): re-arm a run whose guard tripped, so completed work is never
-- stranded.
--
-- A SEPARATE function rather than a p_force argument on finalize_ingestion_run,
-- deliberately: adding a parameter would change that function's signature,
-- which means DROP and CREATE, which discards its grants and recreates it with
-- EXECUTE granted to PUBLIC. That is exactly what 0031 did to
-- create_organize_run and 0032 had to repair. finalize keeps its signature and
-- its grants; this function carries its own.
--
-- IT ONLY MOVES THE BASELINE. It applies nothing, writes no packet content, and
-- cannot bypass ownership, draft status, or the destination guard. Whether the
-- override should be OFFERED at all is decided before this is called - a
-- section_append whose target section is gone, or a packet holding media that
-- cannot be reconciled, must not reach here.
-- ---------------------------------------------------------------------------
create or replace function public.rebaseline_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_puser uuid; v_pstatus text;
  v_srev bigint; v_rev bigint; v_sections int; v_items int; v_sec_packet uuid;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.destination <> 'packet' then
    raise exception 'ingestion: run % has destination % and cannot use the packet path', p_run_id, v_run.destination;
  end if;
  if v_run.status <> 'active' then raise exception 'ingestion: run is % (cannot re-baseline)', v_run.status; end if;

  select user_id, status, structural_rev, content_rev
    into v_puser, v_pstatus, v_srev, v_rev
    from public.packets where id = v_run.packet_id for update;
  if v_puser is null then raise exception 'ingestion: packet not found'; end if;
  if v_puser <> p_owner then raise exception 'ingestion: caller does not own packet'; end if;
  if v_pstatus <> 'draft' then raise exception 'ingestion: packet is not draft (cannot re-baseline)'; end if;

  -- A section_append has a NAMED destination. If it is gone, re-baselining
  -- would arm a finalize that can only fail - or, worse, invite someone to
  -- relax that check later and land the items somewhere the professional never
  -- chose. Refused here as well as in finalize, so the invariant holds even if
  -- a caller skips the preflight.
  if v_run.entry_point = 'section_append' then
    select packet_id into v_sec_packet from public.sections where id = v_run.target_section_id;
    if v_sec_packet is null or v_sec_packet <> v_run.packet_id then
      raise exception 'ingestion: target section no longer valid';
    end if;
  end if;

  select count(*) into v_sections from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_items from public.items i
    join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;

  update public.ingestion_runs
     set baseline_structural_rev = v_srev,
         baseline_content_rev    = v_rev,
         baseline_section_count  = v_sections,
         baseline_item_count     = v_items,
         updated_at              = now()
   where id = p_run_id;

  return jsonb_build_object(
    'ok', true, 'structural_rev', v_srev, 'sections', v_sections, 'items', v_items);
end;
$$;

-- NEW FUNCTION: created with EXECUTE granted to PUBLIC by default. Revoked and
-- granted explicitly, matching every other privileged RPC here.
revoke all on function public.rebaseline_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.rebaseline_ingestion_run(uuid, uuid) to service_role;

-- The functions replaced above kept their exact signatures, so their grants
-- survived. Re-asserted rather than assumed - the cost is nothing and the
-- failure mode (0031) was a day of anon-executable SECURITY DEFINER.
revoke all on function public.create_organize_run(uuid, text, text, text, text, integer, text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.create_organize_run(uuid, text, text, text, text, integer, text, text, jsonb, text) to service_role;
revoke all on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) to service_role;
revoke all on function public.finalize_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ingestion_run(uuid, uuid) to service_role;

commit;
