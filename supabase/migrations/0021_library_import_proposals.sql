-- 0021 — the Library import review layer, and the packet-path guards.
--
-- Three things, in one migration because they are one guarantee:
--
--   1. library_import_proposals — durable review state, so a closed tab loses
--      neither the model's extraction nor the professional's edits.
--   2. library_save_proposal — the ONLY writer for an imported entry, doing the
--      library_items insert and the proposal delete in ONE transaction.
--   3. destination guards on finalize_ingestion_run and discard_ingestion_run,
--      deferred out of 0020 so the schema change could be verified alone.
--
-- HOW THE TWO REPLACED FUNCTIONS WERE PRODUCED. They were extracted verbatim
-- from the migrations that currently define them — finalize from 0014, discard
-- from 0012 — and one guard block was inserted after the ownership check in
-- each. The diff against the extracted originals contains additions only, and
-- the only non-comment additions are the four guard lines. Nothing was retyped.
--
-- NOT IN THIS MIGRATION: create/finish/discard RPCs for library runs. Those come
-- with the application code. Until then no library run can be created at all, so
-- the guards below are purely defensive — the packet path is closed before
-- anything can walk into it.

begin;

-- ---------------------------------------------------------------------------
-- 1. The review layer.
--
--    Deliberately minimal: the run it belongs to, stable ordering, the canonical
--    ItemContentPayload, and whether it is selected. No version history, no sync
--    semantics, no folders, no tags, no second Library model.
--
--    There is NO library_item_id column. A saved proposal is DELETED, which
--    makes this table self-draining and a partial save idempotent by
--    construction: the rows that remain are exactly the ones not yet saved. A
--    bookkeeping column would itself need writing atomically to be trustworthy;
--    a row's absence is a fact the transaction already guarantees.
-- ---------------------------------------------------------------------------
create table if not exists public.library_import_proposals (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.ingestion_runs(id) on delete cascade,

  -- (ordinal, idx) is the proposal's identity: the leaf chunk it came from and
  -- its position in that chunk's staged result. Stable across reconnects, which
  -- is what lets materialisation be idempotent.
  ordinal    int  not null,
  idx        int  not null,

  payload    jsonb not null check (jsonb_typeof(payload) = 'object'),
  selected   boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (run_id, ordinal, idx)
);

create index if not exists library_import_proposals_run_idx
  on public.library_import_proposals(run_id, ordinal, idx);

alter table public.library_import_proposals enable row level security;
-- No anon/authenticated policies: reachable only via the service role, exactly
-- like ingestion_runs and library_items.

comment on table public.library_import_proposals is
  'Durable review state for a Library AI import. A proposal becomes a library_items row only when the professional explicitly saves it, and is deleted in the same transaction.';

-- ---------------------------------------------------------------------------
-- 2. The atomic save.
--
--    THE WHOLE POINT IS THAT THESE TWO WRITES CANNOT SPLIT. As two independent
--    statements over PostgREST, a crash between them would leave the item
--    created and the proposal present, and a retry would create a second item.
--    The duplicate warning cannot cover that: it is a title/address heuristic
--    and advisory by design. A plpgsql body is one transaction, so the insert
--    and the delete commit together or not at all.
-- ---------------------------------------------------------------------------
create or replace function public.library_save_proposal(
  p_owner uuid, p_run_id uuid, p_proposal_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $lsp$
declare v_run record; v_p record; v_new uuid; v_title text;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'library: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'library: caller does not own run'; end if;
  if v_run.destination <> 'library' then
    raise exception 'library: run % is not a library import', p_run_id;
  end if;
  if v_run.status <> 'active' then
    raise exception 'library: run % is % — proposals save only from an active import', p_run_id, v_run.status;
  end if;

  select * into v_p from public.library_import_proposals
    where id = p_proposal_id and run_id = p_run_id for update;

  -- ALREADY SAVED. This is exactly what a retry after a crash looks like, and it
  -- must be a no-op returning nothing — never a second Library item. The
  -- `for update` above also serialises two concurrent saves of the same
  -- proposal: the second blocks, then lands here.
  if v_p.id is null then return null; end if;

  -- An untitled entry is unfindable, which defeats the point of saving it. Same
  -- rule the direct-write path already enforces.
  v_title := coalesce(trim(v_p.payload->>'title'), '');
  if v_title = '' then
    raise exception 'library: proposal % has no title', p_proposal_id;
  end if;

  -- jsonb `null` is not SQL NULL, so coalesce alone would let a literal null
  -- through into a NOT NULL column. Each collection is accepted only if it is
  -- actually an array.
  insert into public.library_items
    (user_id, title, address, description, notes, details, links, photos, contacts)
  values (
    p_owner,
    v_title,
    coalesce(v_p.payload->>'address', ''),
    coalesce(v_p.payload->>'description', ''),
    coalesce(v_p.payload->>'notes', ''),
    case when jsonb_typeof(v_p.payload->'details')  = 'array' then v_p.payload->'details'  else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'links')    = 'array' then v_p.payload->'links'    else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'photos')   = 'array' then v_p.payload->'photos'   else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'contacts') = 'array' then v_p.payload->'contacts' else '[]'::jsonb end
  )
  returning id into v_new;

  -- SAME TRANSACTION as the insert above. There is no window in which the
  -- Library item exists and the proposal still does.
  --
  -- source_packet_item_id is deliberately not written: an imported entry has no
  -- packet item, exactly as a directly-written one does not.
  delete from public.library_import_proposals where id = p_proposal_id;

  return v_new;
end;
$lsp$;

comment on function public.library_save_proposal(uuid, uuid, uuid) is
  'Atomically turn one reviewed proposal into a library_items row and remove the proposal. Returns the new id, or NULL if the proposal was already saved.';

-- ---------------------------------------------------------------------------
-- 3. The packet path refuses library runs.
--
--    Both function bodies below are the CURRENT definitions, extracted verbatim
--    (finalize from 0014, discard from 0012) with one guard block inserted after
--    the ownership check. Neither migration file was modified.
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
    set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
    where run_id = p_run_id;

  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

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
    set result=null, segment_text=null, section_hint='', error='', updated_at=now()
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
-- 4. Privileges. CREATE OR REPLACE preserves an existing ACL, but the two
--    replaced functions are re-granted explicitly so this migration states the
--    end result rather than depending on what was there before.
-- ---------------------------------------------------------------------------
revoke all on function public.library_save_proposal(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.library_save_proposal(uuid, uuid, uuid) to service_role;

revoke all on function public.finalize_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finalize_ingestion_run(uuid, uuid) to service_role;
revoke all on function public.discard_ingestion_run(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.discard_ingestion_run(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof — including the fault-injection that shows the save is
--    genuinely one transaction — is Step 3, deliberately outside this one.
-- ---------------------------------------------------------------------------
do $verify$
declare v int; v_def text; v_acl text;
begin
  if to_regclass('public.library_import_proposals') is null then
    raise exception '0021 verify: library_import_proposals is missing';
  end if;

  -- RLS on, and NO policy: service role only.
  select count(*) into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'library_import_proposals' and c.relrowsecurity;
  if v <> 1 then raise exception '0021 verify: RLS is not enabled on library_import_proposals'; end if;
  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'library_import_proposals';
  if v <> 0 then raise exception '0021 verify: library_import_proposals has % policy/policies', v; end if;

  -- the identity key
  select count(*) into v from pg_constraint
   where conrelid = 'public.library_import_proposals'::regclass and contype = 'u';
  if v <> 1 then raise exception '0021 verify: expected exactly one unique constraint, found %', v; end if;

  -- the guard is present in BOTH packet-path functions
  foreach v_def in array array['finalize_ingestion_run','discard_ingestion_run'] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_def
         and pg_get_functiondef(p.oid) ilike '%cannot use the packet path%'
    ) then
      raise exception '0021 verify: % did not get the destination guard', v_def;
    end if;
  end loop;

  -- and neither body lost anything it had before
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='finalize_ingestion_run'
                    and pg_get_functiondef(p.oid) ilike '%baseline_content_rev%'
                    and pg_get_functiondef(p.oid) ilike '%source_offset_base%') then
    raise exception '0021 verify: finalize_ingestion_run lost 0012/0014 content';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='discard_ingestion_run'
                    and pg_get_functiondef(p.oid) ilike '%deletedPacket%'
                    and pg_get_functiondef(p.oid) ilike '%origin_ingestion_run_id%') then
    raise exception '0021 verify: discard_ingestion_run lost 0012 content';
  end if;

  -- library_save_proposal is security definer with a pinned search_path
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='library_save_proposal'
                    and p.prosecdef
                    and coalesce(array_to_string(p.proconfig, ','), '') ilike '%search_path%') then
    raise exception '0021 verify: library_save_proposal is not security definer with a pinned search_path';
  end if;

  -- NOBODY but service_role may execute it. PUBLIC is a pseudo-role and cannot
  -- be passed to has_function_privilege, so the ACL is read directly; a NULL
  -- proacl would mean default privileges, which for a function INCLUDE PUBLIC.
  select coalesce(array_to_string(p.proacl, ' '), '(default — PUBLIC CAN EXECUTE)')
    into v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='library_save_proposal';
  if v_acl like '%default%' then
    raise exception '0021 verify: library_save_proposal has default privileges, so PUBLIC can execute it';
  end if;
  if v_acl ~ '(^| )=X' or v_acl like '%anon=X%' or v_acl like '%authenticated=X%' then
    raise exception '0021 verify: library_save_proposal is executable by PUBLIC/anon/authenticated: %', v_acl;
  end if;

  raise notice '0021 verify: OK';
end
$verify$;

commit;
