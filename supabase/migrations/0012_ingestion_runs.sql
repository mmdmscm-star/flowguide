-- ============================================================================
-- 0012 — Resilient AI ingestion v1 (persisted, resumable ingestion runs)
--
-- A large source that would exceed the 60s Vercel function limit in one model
-- call (see docs/investigations/resilient-ai-ingestion.md) is processed as an
-- ordered set of bounded chunks. Chunk results are STAGED here (transient
-- processing state), never written to the canonical packet as they arrive; the
-- whole combined result is applied to the packet in ONE transaction at finalize.
-- Staged source + model results are cleared on finalize/discard.
--
-- Safety posture (v1 corrections):
--   * Sections are recombined by a DETERMINISTIC continuation flag from the
--     segmentation plan (is_continuation), NEVER by matching displayed titles.
--   * Concurrency: at most one active run per packet; a trigger blocks publishing
--     while a run is active; finalize refuses if the packet's canonical content
--     changed since the run began (content baseline).
--   * Discard deletes a packet ONLY when it was explicitly created for this run
--     (packets.origin_ingestion_run_id), is a draft owned by the caller, and has
--     no canonical content; otherwise only staged data is cleared.
--
-- The packet remains the sole canonical product record.
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Tables + the explicit packet lifecycle marker
-- ----------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  packet_id uuid not null references public.packets(id) on delete cascade,
  entry_point text not null check (entry_point in ('organize','append','section_append')),
  target_section_id uuid references public.sections(id) on delete cascade,
  source_text text,                 -- resumable source; cleared on finalize/discard
  source_hash text not null,
  segmenter_version text not null,
  status text not null default 'active'
    check (status in ('active','finalizing','finalized','discarded','error')),
  total_chunks int not null default 0,      -- number of LEAF chunks (real work total)
  completed_chunks int not null default 0,
  baseline_section_count int not null default 0,  -- canonical content at run creation
  baseline_item_count int not null default 0,
  derived_title text not null default '',   -- organize: title captured from the lead chunk
  derived_client_name text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index if not exists idx_ingestion_runs_packet on public.ingestion_runs(packet_id);
create index if not exists idx_ingestion_runs_user on public.ingestion_runs(user_id);
-- At most ONE active/finalizing run per packet — blocks a conflicting second run
-- at the database level (not just the UI).
create unique index if not exists idx_ingestion_runs_one_active
  on public.ingestion_runs(packet_id) where status in ('active','finalizing');

create table if not exists public.ingestion_chunks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingestion_runs(id) on delete cascade,
  ordinal int not null,             -- STABLE identity within the run (never reused)
  source_start int not null,        -- ORDER key; leaf ranges tile [0, len(source)]
  source_end int not null,
  segment_text text,                -- cleared on finalize/discard
  segment_hash text not null,
  section_hint text not null default '',  -- nearest preceding heading (grouping context)
  is_continuation boolean not null default false, -- spillover of the previous chunk's heading group
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','split')),
  attempt_count int not null default 0,
  split_depth int not null default 0,
  result jsonb,                     -- staged structured result; cleared on finalize/discard
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, ordinal)
);
create index if not exists idx_ingestion_chunks_run on public.ingestion_chunks(run_id, source_start);

-- Explicit "this packet's canonical content originates from this run" marker, so
-- discard can safely delete an abandoned initial-import draft without inferring
-- from entry_point alone.
alter table public.packets add column if not exists origin_ingestion_run_id uuid;

alter table public.ingestion_runs enable row level security;
alter table public.ingestion_chunks enable row level security;
-- No anon/authenticated policies: reachable only via the service role.

-- ----------------------------------------------------------------------------
-- 2. Publish guard trigger — a packet cannot be published while an active or
--    finalizing ingestion run exists for it. Airtight (any route / direct write).
-- ----------------------------------------------------------------------------
create or replace function public.block_publish_during_ingest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if exists (select 1 from public.ingestion_runs where packet_id = new.id and status in ('active','finalizing')) then
      raise exception 'cannot publish while an import is in progress';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_publish_during_ingest on public.packets;
create trigger trg_block_publish_during_ingest
  before update on public.packets
  for each row execute function public.block_publish_during_ingest();

-- ----------------------------------------------------------------------------
-- 3. create_ingestion_run — validate + persist the plan atomically.
--    p_chunks: ordered jsonb array of
--      { ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation }
-- ----------------------------------------------------------------------------
create or replace function public.create_ingestion_run(
  p_owner uuid,
  p_packet_id uuid,
  p_entry_point text,
  p_target_section_id uuid,
  p_source_text text,
  p_source_hash text,
  p_segmenter_version text,
  p_chunks jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_status text;
  v_mode text;
  v_sec_packet uuid;
  v_run_id uuid;
  v_base_sections int;
  v_base_items int;
  c jsonb;
  n int;
begin
  if p_entry_point not in ('organize','append','section_append') then
    raise exception 'ingestion: bad entry_point %', p_entry_point;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  select user_id, status, composition_mode into v_user, v_status, v_mode
    from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'ingestion: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'ingestion: packet % is not draft', p_packet_id; end if;
  -- organize/append create sections; those only make sense on a legacy-mode packet.
  if p_entry_point in ('organize','append') and v_mode <> 'legacy' then
    raise exception 'ingestion: % requires legacy composition mode', p_entry_point;
  end if;

  if p_entry_point = 'section_append' then
    if p_target_section_id is null then raise exception 'ingestion: section_append needs a target section'; end if;
    select packet_id into v_sec_packet from public.sections where id = p_target_section_id;
    if v_sec_packet is null or v_sec_packet <> p_packet_id then
      raise exception 'ingestion: target section does not belong to packet';
    end if;
  end if;

  -- Content baseline (used by finalize to detect edits during the run).
  select count(*) into v_base_sections from public.sections where packet_id = p_packet_id;
  select count(*) into v_base_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = p_packet_id;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, target_section_id, source_text, source_hash,
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count
  ) values (
    p_owner, p_packet_id, p_entry_point,
    case when p_entry_point = 'section_append' then p_target_section_id else null end,
    p_source_text, p_source_hash, p_segmenter_version, 'active', n, 0, v_base_sections, v_base_items
  ) returning id into v_run_id;

  for c in select value from jsonb_array_elements(p_chunks)
  loop
    insert into public.ingestion_chunks (
      run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status
    ) values (
      v_run_id,
      (c->>'ordinal')::int,
      (c->>'source_start')::int,
      (c->>'source_end')::int,
      c->>'segment_text',
      coalesce(c->>'segment_hash',''),
      coalesce(c->>'section_hint',''),
      coalesce((c->>'is_continuation')::boolean, false),
      'pending'
    );
  end loop;

  -- Mark an empty draft as originating from THIS run so discard can safely remove
  -- it later. Only when organize, still empty, and not already claimed.
  if p_entry_point = 'organize' and v_base_sections = 0 then
    update public.packets set origin_ingestion_run_id = v_run_id
      where id = p_packet_id and origin_ingestion_run_id is null;
  end if;

  return v_run_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. stage_chunk_result — idempotent staging of one chunk's model result.
-- ----------------------------------------------------------------------------
create or replace function public.stage_chunk_result(
  p_run_id uuid,
  p_owner uuid,
  p_ordinal int,
  p_segment_hash text,
  p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_status text;
  v_chunk record;
begin
  select user_id, status into v_user, v_status from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_status <> 'active' then raise exception 'ingestion: run is % (not active)', v_status; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;
  if v_chunk.segment_hash <> p_segment_hash then
    raise exception 'ingestion: segment hash mismatch for chunk % (plan changed)', p_ordinal;
  end if;
  if v_chunk.status = 'split' then raise exception 'ingestion: chunk % was subdivided; refresh the plan', p_ordinal; end if;

  -- Idempotent: already completed -> return existing staged result unchanged.
  if v_chunk.status = 'completed' then
    return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',true);
  end if;

  if jsonb_typeof(p_result) <> 'object' then raise exception 'ingestion: chunk result must be an object'; end if;

  update public.ingestion_chunks
    set result = p_result, status = 'completed', attempt_count = attempt_count + 1,
        error = '', updated_at = now()
    where id = v_chunk.id;

  update public.ingestion_runs
    set completed_chunks = completed_chunks + 1, updated_at = now()
    where id = p_run_id;

  return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. mark_chunk_failed — record a failed attempt (before a split or a retry).
-- ----------------------------------------------------------------------------
create or replace function public.mark_chunk_failed(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_error text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid;
begin
  select user_id into v_user from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  update public.ingestion_chunks
    set status = 'failed', attempt_count = attempt_count + 1, error = coalesce(p_error,''), updated_at = now()
    where run_id = p_run_id and ordinal = p_ordinal and status <> 'completed';
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. split_chunk — adaptive subdivision. p_children: ordered jsonb array of
--    { source_start, source_end, segment_text, segment_hash, is_continuation }
-- ----------------------------------------------------------------------------
create or replace function public.split_chunk(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_children jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid; v_status text; v_chunk record; v_next int; ch jsonb; v_added int := 0; v_hint text;
begin
  select user_id, status into v_user, v_status from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_status <> 'active' then raise exception 'ingestion: run is % (not active)', v_status; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;
  if v_chunk.status = 'completed' then raise exception 'ingestion: chunk % already completed', p_ordinal; end if;
  if v_chunk.split_depth >= 4 then raise exception 'ingestion: chunk % too small to subdivide further', p_ordinal; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) < 2 then
    raise exception 'ingestion: split needs >= 2 children';
  end if;

  v_hint := v_chunk.section_hint;
  update public.ingestion_chunks set status = 'split', updated_at = now() where id = v_chunk.id;

  select coalesce(max(ordinal),0) + 1 into v_next from public.ingestion_chunks where run_id = p_run_id;
  for ch in select value from jsonb_array_elements(p_children)
  loop
    insert into public.ingestion_chunks (
      run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status, split_depth
    ) values (
      p_run_id, v_next, (ch->>'source_start')::int, (ch->>'source_end')::int,
      ch->>'segment_text', coalesce(ch->>'segment_hash',''), v_hint,
      coalesce((ch->>'is_continuation')::boolean, false), 'pending', v_chunk.split_depth + 1
    );
    v_next := v_next + 1; v_added := v_added + 1;
  end loop;

  update public.ingestion_runs set total_chunks = total_chunks + (v_added - 1), updated_at = now()
    where id = p_run_id;

  return jsonb_build_object('added', v_added);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. finalize_ingestion_run — apply the combined staged result to the canonical
--    packet in ONE transaction, then mark finalized + clear staged material.
--    Refuses if canonical content changed since the run began. Sections are
--    recombined by the deterministic is_continuation flag, never by title.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_puser uuid; v_sec_packet uuid;
  v_srclen int; v_prev int := 0; leaf record;
  v_cur_sections int; v_cur_items int;
  v_base_sort int; v_item_base int; v_target_section uuid;
  v_last_section uuid := null; v_first_sec boolean;
  sec jsonb; it jsonb; d jsonb; l jsonb; ph text; ct jsonb;
  v_new_section uuid; v_new_item uuid; di int; li int; pi int; ci int;
  v_sections int := 0; v_items int := 0;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.status = 'finalized' then
    return jsonb_build_object('status','finalized','reused',true);
  end if;
  if v_run.status <> 'active' then raise exception 'ingestion: run is % (cannot finalize)', v_run.status; end if;

  select status, user_id into v_pstatus, v_puser from public.packets where id = v_run.packet_id for update;
  if v_puser is null then raise exception 'ingestion: packet not found'; end if;
  if v_puser <> p_owner then raise exception 'ingestion: caller does not own packet'; end if;
  if v_pstatus <> 'draft' then raise exception 'ingestion: packet is not draft (cannot finalize)'; end if;

  -- Content-change detection: refuse if the packet was edited since the run began,
  -- so a stale/concurrent finalize can't overwrite or silently combine with edits.
  select count(*) into v_cur_sections from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_cur_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  if v_cur_sections <> v_run.baseline_section_count or v_cur_items <> v_run.baseline_item_count then
    raise exception 'ingestion: packet content changed since the import began (expected %/% sections/items, found %/%)',
      v_run.baseline_section_count, v_run.baseline_item_count, v_cur_sections, v_cur_items;
  end if;

  -- Coverage/completeness over LEAF chunks (status <> 'split'), ordered by source_start.
  v_srclen := char_length(coalesce(v_run.source_text,''));
  for leaf in
    select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start
  loop
    if leaf.status <> 'completed' then raise exception 'ingestion: chunk % not completed', leaf.ordinal; end if;
    if leaf.source_start <> v_prev then raise exception 'ingestion: coverage gap/overlap at %', leaf.source_start; end if;
    v_prev := leaf.source_end;
  end loop;
  if v_prev <> v_srclen then raise exception 'ingestion: chunks do not cover the whole source (% of %)', v_prev, v_srclen; end if;

  -- ---- Apply to the canonical packet ----
  if v_run.entry_point in ('organize','append') then
    select coalesce(max(sort_order),-1)+1 into v_base_sort from public.sections where packet_id = v_run.packet_id;
    for leaf in
      select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start
    loop
      v_first_sec := true;
      for sec in select value from jsonb_array_elements(coalesce(leaf.result->'sections','[]'::jsonb))
      loop
        -- Recombine a heading group split across chunks by the DETERMINISTIC
        -- continuation flag from the plan — never by comparing titles. Only the
        -- FIRST section of a continuation chunk joins the previous group's section.
        if v_first_sec and leaf.is_continuation and v_last_section is not null then
          v_new_section := v_last_section;
        else
          insert into public.sections (packet_id, title, description, sort_order)
            values (v_run.packet_id, coalesce(nullif(sec->>'title',''),'Section'), coalesce(sec->>'description',''), v_base_sort)
            returning id into v_new_section;
          v_base_sort := v_base_sort + 1; v_sections := v_sections + 1;
        end if;
        v_last_section := v_new_section; v_first_sec := false;

        select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_new_section;
        for it in select value from jsonb_array_elements(coalesce(sec->'items','[]'::jsonb))
        loop
          insert into public.items (section_id, title, address, description, notes, sort_order)
            values (v_new_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                    coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base)
            returning id into v_new_item;
          v_item_base := v_item_base + 1; v_items := v_items + 1;
          di := 0;
          for d in select value from jsonb_array_elements(coalesce(it->'details','[]'::jsonb)) loop
            insert into public.item_details (item_id,label,value,sort_order)
              values (v_new_item, coalesce(d->>'label',''), coalesce(d->>'value',''), di); di := di+1;
          end loop;
          li := 0;
          for l in select value from jsonb_array_elements(coalesce(it->'links','[]'::jsonb)) loop
            if coalesce(l->>'url','') like 'http%' then
              insert into public.item_links (item_id,url,label,sort_order)
                values (v_new_item, l->>'url', coalesce(l->>'label',''), li); li := li+1;
            end if;
          end loop;
          pi := 0;
          for ph in select value from jsonb_array_elements_text(coalesce(it->'photos','[]'::jsonb)) loop
            if ph like 'http%' then
              insert into public.item_photos (item_id,url,storage_path,sort_order) values (v_new_item, ph, '', pi); pi := pi+1;
            end if;
          end loop;
          ci := 0;
          for ct in select value from jsonb_array_elements(
            coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)
          ) loop
            if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
              insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
                values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''),
                        coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
            end if;
          end loop;
        end loop;
      end loop;
    end loop;

    if v_run.entry_point = 'organize' then
      update public.packets set
        title = case when v_run.derived_title <> '' then v_run.derived_title else title end,
        client_name = case when v_run.derived_client_name <> '' then v_run.derived_client_name else client_name end,
        raw_input = coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    else
      update public.packets set raw_input = coalesce(raw_input,'') || E'\n\n--- Added ---\n\n' || coalesce(v_run.source_text,'')
        where id = v_run.packet_id;
    end if;

  else  -- section_append: items only, into the named section
    v_target_section := v_run.target_section_id;
    select packet_id into v_sec_packet from public.sections where id = v_target_section;
    if v_sec_packet is null or v_sec_packet <> v_run.packet_id then raise exception 'ingestion: target section no longer valid'; end if;
    select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_target_section;
    for leaf in
      select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start
    loop
      for it in select value from jsonb_array_elements(coalesce(leaf.result->'items','[]'::jsonb))
      loop
        insert into public.items (section_id, title, address, description, notes, sort_order)
          values (v_target_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                  coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base)
          returning id into v_new_item;
        v_item_base := v_item_base + 1; v_items := v_items + 1;
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
          coalesce(it->'contacts', case when jsonb_typeof(it->'contact')='object' then jsonb_build_array(it->'contact') else '[]'::jsonb end)
        ) loop
          if jsonb_typeof(ct)='object' and (coalesce(ct->>'name','')<>'' or coalesce(ct->>'phone','')<>'' or coalesce(ct->>'email','')<>'' or coalesce(ct->>'website','')<>'') then
            insert into public.item_contacts (item_id,name,role,phone,email,website,sort_order)
              values (v_new_item, coalesce(ct->>'name',''), coalesce(ct->>'role',''), coalesce(ct->>'phone',''), coalesce(ct->>'email',''), coalesce(ct->>'website',''), ci); ci := ci+1;
          end if;
        end loop;
      end loop;
    end loop;
    update public.packets set raw_input = coalesce(raw_input,'') || E'\n\n--- Added ---\n\n' || coalesce(v_run.source_text,'')
      where id = v_run.packet_id;
  end if;

  -- Finalize + privacy cleanup, same transaction.
  update public.ingestion_runs
    set status = 'finalized', finalized_at = now(), source_text = null,
        completed_chunks = total_chunks, updated_at = now()
    where id = p_run_id;
  update public.ingestion_chunks set result = null, segment_text = null, updated_at = now()
    where run_id = p_run_id;

  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. discard_ingestion_run — abandon an import. Clears staged material. Deletes
--    the packet ONLY when it was explicitly created for THIS run and still holds
--    no canonical content (draft, owner match, 0 sections/items/blocks).
-- ----------------------------------------------------------------------------
create or replace function public.discard_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_origin uuid; v_secs int; v_items int; v_blocks int;
  v_deleted_packet boolean := false;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.status = 'finalized' then raise exception 'ingestion: run already finalized'; end if;

  update public.ingestion_runs set status='discarded', source_text=null, updated_at=now() where id = p_run_id;
  update public.ingestion_chunks set result=null, segment_text=null, updated_at=now() where run_id = p_run_id;

  -- Safe orphan-draft deletion: ALL conditions must hold.
  select status, origin_ingestion_run_id into v_pstatus, v_origin from public.packets where id = v_run.packet_id for update;
  select count(*) into v_secs from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  select count(*) into v_blocks from public.packet_blocks where packet_id = v_run.packet_id;

  if v_run.entry_point = 'organize'
     and v_origin = p_run_id                 -- packet was created FOR this run
     and v_pstatus = 'draft'                 -- still a draft
     and v_secs = 0 and v_items = 0 and v_blocks = 0  -- no canonical / user content
  then
    delete from public.packets where id = v_run.packet_id;  -- run cascades away
    v_deleted_packet := true;
  end if;

  return jsonb_build_object('status','discarded','deletedPacket',v_deleted_packet);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: service-role only, matching the other content RPCs. (The trigger
-- function is invoked by the trigger, not called directly, so it is not granted.)
-- ----------------------------------------------------------------------------
revoke all on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, text, jsonb) to service_role;
revoke all on function public.stage_chunk_result(uuid, uuid, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.stage_chunk_result(uuid, uuid, int, text, jsonb) to service_role;
revoke all on function public.mark_chunk_failed(uuid, uuid, int, text) from public, anon, authenticated, service_role;
grant execute on function public.mark_chunk_failed(uuid, uuid, int, text) to service_role;
revoke all on function public.split_chunk(uuid, uuid, int, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.split_chunk(uuid, uuid, int, jsonb) to service_role;
revoke all on function public.finalize_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ingestion_run(uuid, uuid) to service_role;
revoke all on function public.discard_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.discard_ingestion_run(uuid, uuid) to service_role;

commit;
