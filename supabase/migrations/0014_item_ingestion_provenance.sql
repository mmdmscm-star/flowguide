-- 0014 — item ingestion provenance: which source record produced which item.
--
-- WHY. Migration 0012 destroys the chunk -> item link in the same transaction
-- that creates the items: finalize captures `returning id into v_new_item`, uses
-- it for child rows, records it nowhere, and then nulls ingestion_chunks.result.
-- Two hops of the chain survive (packets.raw_input, and every chunk's ordinal +
-- source_start/source_end); the third is gone. After finalize there is no way to
-- ask "which source record produced this item" — the exact question both photo
-- ownership incidents turned on.
--
-- Not even per-chunk item COUNTS survive, and insertion order cannot be
-- re-partitioned into chunks because continuation spillover merges a chunk's
-- first section into the previous one. There is no derivation. The link has to
-- be written down at the moment it exists.
--
-- SHAPE. Three nullable columns on `items`, one on `ingestion_runs`. Provenance
-- lives on ITEMS and never on item_photos, because update_item_content (0011)
-- deletes every photo row for an item and reinserts from a {url}-only payload on
-- each save — per-photo provenance would be erased by the professional's next
-- edit. On items, ownership is recomputed against LIVE photo rows, so a
-- professional who moves a photo to the right item makes the finding disappear
-- by fixing the thing itself, with no resolution bookkeeping to go stale.
--
-- ADDITIVE AND HONEST. Nothing is backfilled. NULL means "provenance
-- unavailable" and recomputation must DECLINE rather than infer. Every existing
-- item and every historical run keeps NULL forever, because their provenance
-- cannot be proven — only guessed, and guessing is what caused the incidents.
--
-- ORDER OF OPERATIONS IS DELIBERATE. ingestion_runs is altered FIRST. The new FK
-- on items references it, which takes SHARE ROW EXCLUSIVE on ingestion_runs and
-- would then need escalation to ACCESS EXCLUSIVE for its own ALTER — a lock
-- upgrade, which is a deadlock class. Taking the strong lock first removes it.
--
-- SAFE TO APPLY BEFORE THE CODE DEPLOYS. Every column is nullable with no
-- default and no constraint, so the ALTERs are metadata-only (no table rewrite).
-- Code that predates this migration simply leaves the new columns NULL.

begin;

-- Fail FAST instead of queueing behind a live transaction. The ALTERs take
-- ACCESS EXCLUSIVE on items, which blocks even SELECTs — so the danger is not
-- how long the lock is held (the work is trivial) but how long it is WAITED for
-- while every packet read piles up behind it. On timeout the whole script rolls
-- back cleanly; just run it again.
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Where a run's source begins inside packets.raw_input.
--
-- Chunk source_start/source_end tile [0, source_len) of the RUN's source_text,
-- which finalize nulls. raw_input is the durable copy, but for append runs it is
-- `prior || delimiter || source_text`, so chunk offsets mean nothing against it
-- without the prefix length. The two append paths do not even agree on the
-- delimiter: finalize uses a constant, while /api/packets/[id]/append writes a
-- timestamped one of variable length. Hence stored, not derived.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists source_offset_base int;

comment on column public.ingestion_runs.source_offset_base is
  'Offset into packets.raw_input (JS UTF-16 code units) at which this run''s source begins. 0 for organize, where raw_input IS the source. NULL for runs finalized before 0014, and for any run whose base could not be established — recomputation must decline rather than assume.';

-- ---------------------------------------------------------------------------
-- 2. UTF-16 code-unit length.
--
-- Every offset in this system is a JS UTF-16 code unit: segmentation computes
-- ranges with String.prototype.slice, segmentHash walks charCodeAt, and
-- source_len is stored in those units. Postgres length() counts CODE POINTS, and
-- the two diverge at the first non-BMP character — one emoji before an offset
-- would shift every later record by one and silently misattribute media. A
-- 4-byte UTF-8 character is exactly a non-BMP code point, which is exactly one
-- surrogate pair, hence exactly one extra UTF-16 unit.
--
-- The ASCII fast path (bytes = characters) covers essentially every real paste.
-- ---------------------------------------------------------------------------
create or replace function public.utf16_length(s text) returns int
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when s is null or s = '' then 0
    when octet_length(s) = length(s) then length(s)
    else length(s) + (
      select count(*)::int
      from regexp_split_to_table(s, '') as ch
      where octet_length(ch) = 4
    )
  end;
$fn$;

comment on function public.utf16_length(text) is
  'Length in JS UTF-16 code units. Matches String.length, unlike length() which counts code points. Every ingestion offset is in these units.';

-- Match 0012's posture: functions are revoked from the API roles and reached
-- only through SECURITY DEFINER callers. Without this, PostgREST would expose
-- POST /rest/v1/rpc/utf16_length to anon.
revoke all on function public.utf16_length(text) from public;
revoke all on function public.utf16_length(text) from anon, authenticated;

-- SELF-VERIFYING. The non-ASCII path depends on regexp_split_to_table(s, '')
-- yielding one row per CHARACTER. If that is ever untrue, the function silently
-- returns code-point length — precisely the bug it exists to prevent, and it
-- would corrupt offsets with nothing failing. So the migration proves it here
-- and REFUSES TO APPLY otherwise.
do $verify$
begin
  if public.utf16_length('abc') <> 3 then
    raise exception '0014: utf16_length ASCII path wrong (got %)', public.utf16_length('abc');
  end if;
  if public.utf16_length('café') <> 4 then
    raise exception '0014: utf16_length BMP accented wrong (got %)', public.utf16_length('café');
  end if;
  if public.utf16_length('漢') <> 1 then
    raise exception '0014: utf16_length BMP CJK wrong (got %)', public.utf16_length('漢');
  end if;
  if public.utf16_length('😀') <> 2 then
    raise exception '0014: utf16_length non-BMP wrong (got %) — empty-pattern split is not per-character on this server; DO NOT PROCEED', public.utf16_length('😀');
  end if;
  if public.utf16_length('😀漢a') <> 4 then
    raise exception '0014: utf16_length mixed wrong (got %)', public.utf16_length('😀漢a');
  end if;
  raise notice '0014: utf16_length verified (ascii / accented / cjk / non-bmp / mixed)';
end
$verify$;

-- ---------------------------------------------------------------------------
-- 3. Provenance columns. Nullable, unbackfilled, no default.
--
-- origin_emit_index is NOT redundant with sort_order. Ownership binding matches
-- the nth item a chunk emitted to the nth record that chunk begins, so emission
-- ORDER is load-bearing — and sort_order belongs to the professional:
-- /api/reorder rewrites it directly from the editor's drag handles. After one
-- reorder, sort_order no longer reflects what the model emitted, and binding by
-- it would silently attribute photos to the wrong item. Recording the index
-- makes emission order a fact, not an inference from a column the user owns.
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists origin_run_id uuid
    references public.ingestion_runs(id) on delete set null,
  add column if not exists origin_chunk_ordinal int,
  add column if not exists origin_emit_index int;

comment on column public.items.origin_run_id is
  'The ingestion run that created this item, or NULL when unknown (created manually, or before migration 0014). Never backfilled. ON DELETE SET NULL: losing the run must lose the provenance, never the item.';
comment on column public.items.origin_chunk_ordinal is
  'ingestion_chunks.ordinal of the chunk that produced this item; NULL when unknown. With origin_run_id this identifies the exact source range, since chunk ordinals are stable within a run and never reused.';
comment on column public.items.origin_emit_index is
  'Zero-based position of this item within its chunk''s output, as emitted. NULL when unknown. Distinct from sort_order, which the professional may reorder freely.';

-- Partial: only provenanced rows are ever scanned, and they are the minority.
-- Also serves the FK ON DELETE SET NULL lookup instead of a seq scan.
create index if not exists items_origin_run_idx
  on public.items(origin_run_id, origin_chunk_ordinal)
  where origin_run_id is not null;

-- ---------------------------------------------------------------------------
-- 4. finalize_ingestion_run: record provenance in the same statement that
--    creates the row, and the offset base where raw_input is assembled.
--
--    Reproduced verbatim from 0012 apart from those additions, so the diff is
--    auditable. Behaviour is otherwise byte-identical.
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

-- ---------------------------------------------------------------------------
-- 5. Offsets are void the moment raw_input stops being an EXTENSION of the text
--    they were measured against.
--
-- Appending preserves every prior offset, which is why both append paths are
-- safe. Replacing or truncating voids all of them at once —
-- /api/packets/[id]/structure does exactly that, unconditionally, on an existing
-- packet. Relying on the consumer's later hash mismatch would work, but it
-- leaves a non-NULL base sitting in the table that is simply wrong, which
-- contradicts this migration's own contract that NULL means "unavailable".
--
-- A trigger rather than a fix in that one route, because the invariant belongs
-- to the data: it holds for every writer, including ones added later and the
-- read-modify-write race in the append route. Invalidation is a fact about
-- raw_input, not a courtesy each caller must remember.
--
-- Note the interaction with finalize, which is safe by ordering: finalize writes
-- raw_input during the apply phase and its own source_offset_base afterwards, so
-- a replacing organize run correctly voids PRIOR runs' bases without touching
-- the one it is about to record.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_invalidate_offsets() returns trigger
language plpgsql
security definer
set search_path = ''
as $inv$
begin
  -- position(old in new) = 1 means new still STARTS WITH old: an append.
  -- Anything else — replace, truncate, edit in place — voids every offset.
  -- An empty/NULL old is trivially a prefix, so first-write is not invalidation.
  if new.raw_input is distinct from old.raw_input
     and position(coalesce(old.raw_input, '') in coalesce(new.raw_input, '')) <> 1 then
    update public.ingestion_runs
      set source_offset_base = null, updated_at = now()
      where packet_id = new.id and source_offset_base is not null;
  end if;
  return null;
end;
$inv$;

comment on function public.ingest_invalidate_offsets() is
  'Nulls ingestion_runs.source_offset_base for a packet whose raw_input was replaced or truncated rather than appended to, so a stale base can never be read as a valid one.';

drop trigger if exists trg_ingest_invalidate_offsets on public.packets;
create trigger trg_ingest_invalidate_offsets
  after update of raw_input on public.packets
  for each row execute function public.ingest_invalidate_offsets();

commit;

-- PostgREST caches the table schema; until it reloads, selecting the new columns
-- returns PGRST204 "column not found in schema cache". Most Supabase projects
-- reload automatically on DDL, but a hand-applied migration is exactly where not
-- to assume it.
notify pgrst, 'reload schema';
