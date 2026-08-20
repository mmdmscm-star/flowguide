-- 0025 — the observe-only fact ledger.
--
-- WHY THIS EXISTS
-- Corpus v2 measured the real failure: across three runs of a realistic
-- 13-record import, 93.0% of facts landed correctly, MISCLASSIFIED = 0 and
-- LOST = 68. The losses were not spread evenly — ranged values ("$4,200 to
-- $5,800") scored 12.8%. The model is not mis-filing facts; it is DROPPING a
-- specific shape of them, silently, with no signal that anything went missing.
--
-- The ledger is the signal. For each chunk it records which shaped facts the
-- segment contained and which of them appear anywhere in the model's output.
-- Measured offline against those same three runs, it would have flagged 25 of
-- the 26 distinct lost facts (96.2%).
--
-- WHAT THIS MIGRATION DOES NOT DO
-- Nothing acts on the ledger. No repair, no re-routing, no stripping, no
-- surfacing to the professional, and no read path anywhere in the application.
-- It is a column that gets written and, for now, only looked at. Steps 4-6 of
-- the fact-accounting design are deliberately not built.
--
-- THE LEDGER IS EVIDENCE, NOT METADATA
-- It stores verbatim fragments of the professional's source text, which may
-- contain contacts, pricing, private notes or customer information. It is
-- therefore held to exactly the same rules as segment_text: service-role only
-- through the existing ingestion_chunks policy, cleared by every path that
-- clears chunk evidence today, and expired by the same retention window.
--
-- That last point is the substance of sections 2-5. FOUR live functions clear
-- chunk evidence, and a ledger left behind by any one of them would outlive the
-- source text it quotes — a discarded import would wipe the source and keep the
-- quotations. Each function below is re-issued with one field added to its
-- existing clearing statement and NOTHING else changed; each body was extracted
-- programmatically from the migration that last defined it rather than retyped.

-- ---------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------
alter table public.ingestion_chunks
  add column if not exists fact_ledger jsonb;

comment on column public.ingestion_chunks.fact_ledger is
  'Observe-only fact accounting for this chunk: shaped facts detected in the segment and whether each appears in the model result. EVIDENCE - contains verbatim source fragments, cleared and expired exactly as segment_text is. Nothing reads it.';

-- ---------------------------------------------------------------------------
-- 2. Packet path, finalize.
--    Re-issued verbatim from 0021_library_import_proposals.sql with `fact_ledger = null`
--    added to its clearing statement. No other line differs.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_puser uuid; v_cur_rev bigint; v_sec_packet uuid;
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

  select status, user_id, content_rev into v_pstatus, v_puser, v_cur_rev from public.packets where id = v_run.packet_id for update;
  if v_puser is null then raise exception 'ingestion: packet not found'; end if;
  if v_puser <> p_owner then raise exception 'ingestion: caller does not own packet'; end if;
  if v_pstatus <> 'draft' then raise exception 'ingestion: packet is not draft (cannot finalize)'; end if;

  -- Authoritative change detection: the content revision must exactly match the
  -- value captured when the run began (any edit/reorder/child change bumped it).
  if v_cur_rev <> v_run.baseline_content_rev then
    raise exception 'ingestion: packet changed since the import began (content_rev % <> %)', v_cur_rev, v_run.baseline_content_rev;
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
        source_text = null, derived_title = '', derived_client_name = '', error = '', updated_at = now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result = null, segment_text = null, section_hint = '', error = '', fact_ledger = null, updated_at = now()
    where run_id = p_run_id;

  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Packet path, discard.
--    Re-issued verbatim from 0021_library_import_proposals.sql with `fact_ledger = null`
--    added to its clearing statement. No other line differs.
-- ---------------------------------------------------------------------------
create or replace function public.discard_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run record; v_pstatus text; v_origin uuid; v_secs int; v_items int; v_blocks int; v_deleted boolean := false;
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
  if v_run.status = 'finalized' then raise exception 'ingestion: run already finalized'; end if;
  -- IDEMPOTENT: a repeat discard returns the prior result and NEVER re-evaluates
  -- packet deletion. (If the first discard deleted the packet, the run cascaded
  -- away, so reaching here means the packet was preserved -> deletedPacket=false.)
  if v_run.status = 'discarded' then
    return jsonb_build_object('status','discarded','deletedPacket',false,'reused',true);
  end if;

  update public.ingestion_runs
    set status='discarded', source_text=null, derived_title='', derived_client_name='', error='', updated_at=now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result=null, segment_text=null, section_hint='', error='', fact_ledger = null, updated_at=now()
    where run_id = p_run_id;

  -- Deletion eligibility is evaluated exactly ONCE, on this first discard.
  select status, origin_ingestion_run_id into v_pstatus, v_origin from public.packets where id = v_run.packet_id for update;
  select count(*) into v_secs from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  select count(*) into v_blocks from public.packet_blocks where packet_id = v_run.packet_id;

  if v_run.entry_point = 'organize' and v_origin = p_run_id and v_pstatus = 'draft'
     and v_secs = 0 and v_items = 0 and v_blocks = 0 then
    delete from public.packets where id = v_run.packet_id;
    v_deleted := true;
  elsif v_origin = p_run_id then
    -- Preserved: drop the origin marker so a LATER discard (or content removal)
    -- can never delete this packet on behalf of this run.
    update public.packets set origin_ingestion_run_id = null
      where id = v_run.packet_id and origin_ingestion_run_id = p_run_id;
  end if;

  return jsonb_build_object('status','discarded','deletedPacket',v_deleted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Library path, close (discard branch).
--    Re-issued verbatim from 0024_ingestion_evidence_retention.sql with `fact_ledger = null`
--    added to its clearing statement. No other line differs.
-- ---------------------------------------------------------------------------
create or replace function public.library_close_import_run(
  p_owner uuid, p_run_id uuid, p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $lci$
declare v_run record; v_dropped int;
begin
  if p_status not in ('finalized','discarded') then
    raise exception 'library: close status must be finalized or discarded (got %)', p_status;
  end if;

  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'library: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'library: caller does not own run'; end if;
  if v_run.destination <> 'library' then raise exception 'library: run % is not a library import', p_run_id; end if;

  -- IDEMPOTENT: a repeated close returns the prior outcome instead of raising.
  if v_run.status = p_status then
    return jsonb_build_object('status', p_status, 'droppedProposals', 0, 'reused', true);
  end if;
  if v_run.status in ('finalized','discarded') then
    raise exception 'library: run % is already %', p_run_id, v_run.status;
  end if;

  delete from public.library_import_proposals where run_id = p_run_id;
  get diagnostics v_dropped = row_count;

  -- 0024: FINISHING AND THROWING AWAY ARE NO LONGER THE SAME ACT.
  --
  -- Both used to clear the source, every segment and every model result, which
  -- made a completed import impossible to diagnose afterwards — the evidence a
  -- reliability investigation needs was destroyed by the act of succeeding.
  --
  -- Finalize now KEEPS that evidence and stamps an expiry; discard still clears
  -- it immediately, because the professional has said they do not want it.
  -- Chunk `error` is kept on finalize too: why a chunk retried or split is part
  -- of the record.
  if p_status = 'finalized' then
    update public.ingestion_runs
       set status = p_status, derived_title = '', derived_client_name = '',
           evidence_purge_after = now() + interval '30 days', updated_at = now()
     where id = p_run_id;
  else
    update public.ingestion_runs
       set status = p_status, source_text = null, derived_title = '',
           derived_client_name = '', error = '', evidence_purge_after = null, updated_at = now()
     where id = p_run_id;

    update public.ingestion_chunks
       set result = null, segment_text = null, section_hint = '', error = '', fact_ledger = null, updated_at = now()
     where run_id = p_run_id;
  end if;

  return jsonb_build_object('status', p_status, 'droppedProposals', v_dropped, 'reused', false);
end;
$lci$;

-- ---------------------------------------------------------------------------
-- 5. Scheduled expiry.
--    Re-issued verbatim from 0024_ingestion_evidence_retention.sql with `fact_ledger = null`
--    added to its clearing statement. No other line differs.
-- ---------------------------------------------------------------------------
create or replace function public.purge_ingestion_evidence()
returns int
language plpgsql
security definer
set search_path = ''
as $pie$
declare v_runs int := 0;
begin
  update public.ingestion_chunks c
     set result = null, segment_text = null, section_hint = '', error = '', fact_ledger = null, updated_at = now()
   where c.run_id in (
           select r.id from public.ingestion_runs r
            where r.evidence_purge_after is not null and r.evidence_purge_after <= now())
     and (c.result is not null or c.segment_text is not null or c.fact_ledger is not null);

  update public.ingestion_runs r
     set source_text = null, evidence_purge_after = null, updated_at = now()
   where r.evidence_purge_after is not null and r.evidence_purge_after <= now();
  get diagnostics v_runs = row_count;

  return v_runs;
end;
$pie$;
