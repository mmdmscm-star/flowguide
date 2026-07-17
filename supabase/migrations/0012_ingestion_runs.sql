-- ============================================================================
-- 0012 — Resilient AI ingestion v1 (persisted, resumable ingestion runs)
--
-- A large source that would exceed the 60s Vercel function limit in one model
-- call (see docs/investigations/resilient-ai-ingestion.md) is processed as an
-- ordered set of bounded chunks. Chunk results are STAGED here (transient
-- processing state), never written to the canonical packet as they arrive; the
-- whole combined result is applied to the packet in ONE transaction at finalize.
-- The staged source + model results are cleared on finalize/discard so sensitive
-- material is not retained past the run.
--
-- The packet remains the sole canonical product record. ingestion_runs /
-- ingestion_chunks are temporary and are safe to delete after finalization.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Tables
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
  derived_title text not null default '',   -- organize: title captured from the lead chunk
  derived_client_name text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index if not exists idx_ingestion_runs_packet on public.ingestion_runs(packet_id);
create index if not exists idx_ingestion_runs_user on public.ingestion_runs(user_id);
-- At most ONE active/finalizing run per packet — prevents conflicting concurrent
-- imports and makes "resume" unambiguous.
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
  section_hint text not null default '',  -- nearest preceding heading (organize grouping)
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

alter table public.ingestion_runs enable row level security;
alter table public.ingestion_chunks enable row level security;
-- No anon/authenticated policies: reachable only via the service role (like the
-- rest of FlowGuide's server routes). Service role bypasses RLS.

-- ----------------------------------------------------------------------------
-- 2. create_ingestion_run — validate + persist the plan atomically.
--    p_chunks: ordered jsonb array of
--      { ordinal, source_start, source_end, segment_text, segment_hash, section_hint }
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
  v_sec_packet uuid;
  v_run_id uuid;
  c jsonb;
  n int;
begin
  if p_entry_point not in ('organize','append','section_append') then
    raise exception 'ingestion: bad entry_point %', p_entry_point;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  select user_id, status into v_user, v_status from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'ingestion: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'ingestion: packet % is not draft', p_packet_id; end if;

  if p_entry_point = 'section_append' then
    if p_target_section_id is null then raise exception 'ingestion: section_append needs a target section'; end if;
    select packet_id into v_sec_packet from public.sections where id = p_target_section_id;
    if v_sec_packet is null or v_sec_packet <> p_packet_id then
      raise exception 'ingestion: target section does not belong to packet';
    end if;
  end if;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, target_section_id, source_text, source_hash,
    segmenter_version, status, total_chunks, completed_chunks
  ) values (
    p_owner, p_packet_id, p_entry_point,
    case when p_entry_point = 'section_append' then p_target_section_id else null end,
    p_source_text, p_source_hash, p_segmenter_version, 'active', n, 0
  ) returning id into v_run_id;

  for c in select value from jsonb_array_elements(p_chunks)
  loop
    insert into public.ingestion_chunks (
      run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, status
    ) values (
      v_run_id,
      (c->>'ordinal')::int,
      (c->>'source_start')::int,
      (c->>'source_end')::int,
      c->>'segment_text',
      coalesce(c->>'segment_hash',''),
      coalesce(c->>'section_hint',''),
      'pending'
    );
  end loop;

  return v_run_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. stage_chunk_result — idempotent staging of one chunk's model result.
--    Re-staging an already-completed chunk returns the existing result and does
--    NOT double-count. Serialized by a run-row lock so concurrent posts are safe.
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
-- 4. mark_chunk_failed — record a failed attempt (before a split or a retry).
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
-- 5. split_chunk — adaptive subdivision. Marks the parent 'split' and inserts
--    child leaves (new ordinals) whose ranges tile the parent range. Raises past
--    a depth limit so a pathological block yields a recoverable error, not a loop.
--    p_children: ordered jsonb array of { source_start, source_end, segment_text, segment_hash }
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
      run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, status, split_depth
    ) values (
      p_run_id, v_next, (ch->>'source_start')::int, (ch->>'source_end')::int,
      ch->>'segment_text', coalesce(ch->>'segment_hash',''), v_hint, 'pending', v_chunk.split_depth + 1
    );
    v_next := v_next + 1; v_added := v_added + 1;
  end loop;

  -- total leaf count grows by (children - 1): the split parent stops being a leaf.
  update public.ingestion_runs set total_chunks = total_chunks + (v_added - 1), updated_at = now()
    where id = p_run_id;

  return jsonb_build_object('added', v_added);
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. finalize_ingestion_run — apply the combined staged result to the canonical
--    packet in ONE transaction, then mark finalized and CLEAR staged material.
--    Idempotent: a second call returns the stored outcome. Any failure rolls the
--    whole thing back (packet + run unchanged).
-- ----------------------------------------------------------------------------
create or replace function public.finalize_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record; v_pstatus text; v_puser uuid;
  v_srclen int; v_prev int := 0; leaf record;
  v_base_sort int; v_item_base int; v_target_section uuid;
  v_last_title text := null; v_last_section uuid := null;
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
      for sec in select value from jsonb_array_elements(coalesce(leaf.result->'sections','[]'::jsonb))
      loop
        if v_last_section is not null and coalesce(sec->>'title','') = coalesce(v_last_title,'') then
          v_new_section := v_last_section;  -- merge adjacent same-title section across chunks
        else
          insert into public.sections (packet_id, title, description, sort_order)
            values (v_run.packet_id, coalesce(nullif(sec->>'title',''),'Section'), coalesce(sec->>'description',''), v_base_sort)
            returning id into v_new_section;
          v_base_sort := v_base_sort + 1; v_sections := v_sections + 1;
          v_last_section := v_new_section; v_last_title := coalesce(sec->>'title','');
        end if;
        select coalesce(max(sort_order),-1)+1 into v_item_base from public.items where section_id = v_new_section;
        for it in select value from jsonb_array_elements(coalesce(sec->'items','[]'::jsonb))
        loop
          insert into public.items (section_id, title, address, description, notes, sort_order)
            values (v_new_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
                    coalesce(it->>'description',''), coalesce(it->>'notes',''), v_item_base)
            returning id into v_new_item;
          v_item_base := v_item_base + 1; v_items := v_items + 1;
          -- children (mirrors insert_items_into_section)
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
    select packet_id into v_puser from public.sections where id = v_target_section; -- reuse v_puser as scratch
    if v_puser is null or v_puser <> v_run.packet_id then raise exception 'ingestion: target section no longer valid'; end if;
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
-- 7. discard_ingestion_run — abandon an import. Clears staged material and, for
--    an 'organize' run whose packet is still empty, removes the orphan draft so
--    no unexplained empty packet is left behind.
-- ----------------------------------------------------------------------------
create or replace function public.discard_ingestion_run(
  p_run_id uuid, p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run record; v_secs int; v_deleted_packet boolean := false;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_run.status = 'finalized' then raise exception 'ingestion: run already finalized'; end if;

  update public.ingestion_runs set status='discarded', source_text=null, updated_at=now() where id = p_run_id;
  update public.ingestion_chunks set result=null, segment_text=null, updated_at=now() where run_id = p_run_id;

  if v_run.entry_point = 'organize' then
    select count(*) into v_secs from public.sections where packet_id = v_run.packet_id;
    if v_secs = 0 then
      -- run FK is ON DELETE CASCADE; deleting the empty draft removes the run too.
      delete from public.packets where id = v_run.packet_id and status = 'draft';
      v_deleted_packet := true;
    end if;
  end if;

  return jsonb_build_object('status','discarded','deletedPacket',v_deleted_packet);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: service-role only, matching the other content RPCs.
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
