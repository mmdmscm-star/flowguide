-- ============================================================================
-- 0012 — Resilient AI ingestion v1 (persisted, resumable ingestion runs)
--
-- A large source that would exceed the 60s Vercel function limit in one model
-- call (see docs/investigations/resilient-ai-ingestion.md) is processed as an
-- ordered set of bounded chunks, STAGED here (transient processing state) and
-- applied to the canonical packet in ONE transaction at finalize. Staged +
-- source-derived material is cleared on finalize/discard.
--
-- Safety posture:
--   * Sections recombine by a DETERMINISTIC continuation flag (is_continuation),
--     never by matching displayed titles.
--   * Concurrency: at most one active run per packet; a trigger blocks publishing
--     while a run is active; every canonical content/composition mutation bumps
--     packets.content_rev (DB triggers, not the UI); finalize captures the rev at
--     run creation and requires an EXACT match under the packet lock (counts are
--     supplementary). Because each mutation bumps the rev via an `update packets`
--     that needs the packet-row lock, canonical edits and finalize are mutually
--     exclusive.
--   * Chunk work is claimed atomically (claim_chunk) so two requests can't both
--     invoke the model; an abandoned claim is recoverable after a lease.
--   * Organize creates the packet + run + plan + origin marker in ONE
--     transaction (create_organize_run) — no orphan draft on partial failure.
--   * Offsets are JavaScript UTF-16 code units end to end; the source length is
--     stored in that unit (source_len), never compared with char_length.
--   * Privacy: derived title/client-name, section hints, staged results, segment
--     text, and errors (which may hold source/model text) are cleared on
--     finalize/discard. Only hashes/timestamps/status/ordinals/counts remain.
--   * Discard deletes a packet ONLY when it was explicitly created for this run
--     (packets.origin_ingestion_run_id), is a draft owned by the caller, and has
--     no canonical content.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Packet columns: content revision + origin marker
-- ----------------------------------------------------------------------------
alter table public.packets add column if not exists content_rev bigint not null default 0;
alter table public.packets add column if not exists origin_ingestion_run_id uuid;

-- ----------------------------------------------------------------------------
-- 2. Tables
-- ----------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  packet_id uuid not null references public.packets(id) on delete cascade,
  entry_point text not null check (entry_point in ('organize','append','section_append')),
  target_section_id uuid references public.sections(id) on delete cascade,
  source_text text,                 -- resumable source; cleared on finalize/discard
  source_hash text not null,
  source_len int not null default 0, -- JS UTF-16 code-unit length (matches offsets)
  segmenter_version text not null,
  status text not null default 'active'
    check (status in ('active','finalizing','finalized','discarded','error')),
  total_chunks int not null default 0,      -- number of LEAF chunks (real work total)
  completed_chunks int not null default 0,
  baseline_section_count int not null default 0,  -- supplementary content assertions
  baseline_item_count int not null default 0,
  baseline_content_rev bigint not null default 0, -- authoritative change detector
  derived_title text not null default '',   -- source-derived; cleared on finalize/discard
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
  source_start int not null,        -- ORDER key; leaf ranges tile [0, source_len)
  source_end int not null,
  segment_text text,                -- cleared on finalize/discard
  segment_hash text not null,
  section_hint text not null default '',  -- source-derived; cleared on finalize/discard
  is_continuation boolean not null default false, -- spillover of the previous chunk's heading group
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','split')),
  attempt_count int not null default 0,
  split_depth int not null default 0,
  result jsonb,                     -- staged structured result; cleared on finalize/discard
  error text not null default '',   -- may hold model text; cleared on finalize/discard
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, ordinal)
);
create index if not exists idx_ingestion_chunks_run on public.ingestion_chunks(run_id, source_start);

alter table public.ingestion_runs enable row level security;
alter table public.ingestion_chunks enable row level security;
-- No anon/authenticated policies: reachable only via the service role.

-- ----------------------------------------------------------------------------
-- 3. content_rev bump triggers — every canonical content/composition mutation
--    bumps packets.content_rev (via an update that needs the packet-row lock).
--    Cascade-safe: a bump targeting an already-deleted packet updates 0 rows.
-- ----------------------------------------------------------------------------
create or replace function public.ingest_bump_by_packet() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  pid := case when tg_op = 'DELETE' then old.packet_id else new.packet_id end;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_section() returns trigger
language plpgsql security definer set search_path = '' as $$
declare sid uuid; pid uuid;
begin
  sid := case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  select packet_id into pid from public.sections where id = sid;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

create or replace function public.ingest_bump_by_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare iid uuid; pid uuid;
begin
  iid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  select s.packet_id into pid from public.items i join public.sections s on s.id = i.section_id where i.id = iid;
  if pid is not null then update public.packets set content_rev = content_rev + 1 where id = pid; end if;
  return null;
end;
$$;

-- Direct packet content/composition edits (title, client name, note, map,
-- identity, composition mode). A content_rev-only update (from a child trigger)
-- leaves these unchanged, so it does not double-count.
create or replace function public.ingest_bump_packet_self() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.title, new.client_name, new.personal_note, new.map_url, new.identity_mode, new.custom_identity, new.composition_mode)
     is distinct from
     (old.title, old.client_name, old.personal_note, old.map_url, old.identity_mode, old.custom_identity, old.composition_mode) then
    new.content_rev := old.content_rev + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ingest_rev_sections on public.sections;
create trigger trg_ingest_rev_sections after insert or update or delete on public.sections for each row execute function public.ingest_bump_by_packet();
drop trigger if exists trg_ingest_rev_blocks on public.packet_blocks;
create trigger trg_ingest_rev_blocks after insert or update or delete on public.packet_blocks for each row execute function public.ingest_bump_by_packet();
drop trigger if exists trg_ingest_rev_items on public.items;
create trigger trg_ingest_rev_items after insert or update or delete on public.items for each row execute function public.ingest_bump_by_section();
drop trigger if exists trg_ingest_rev_details on public.item_details;
create trigger trg_ingest_rev_details after insert or update or delete on public.item_details for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_links on public.item_links;
create trigger trg_ingest_rev_links after insert or update or delete on public.item_links for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_photos on public.item_photos;
create trigger trg_ingest_rev_photos after insert or update or delete on public.item_photos for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_contacts on public.item_contacts;
create trigger trg_ingest_rev_contacts after insert or update or delete on public.item_contacts for each row execute function public.ingest_bump_by_item();
drop trigger if exists trg_ingest_rev_packet_self on public.packets;
create trigger trg_ingest_rev_packet_self before update on public.packets for each row execute function public.ingest_bump_packet_self();

-- ----------------------------------------------------------------------------
-- 4. Publish guard trigger — a packet cannot be published while a run is active.
-- ----------------------------------------------------------------------------
create or replace function public.block_publish_during_ingest() returns trigger
language plpgsql security definer set search_path = '' as $$
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
create trigger trg_block_publish_during_ingest before update on public.packets
  for each row execute function public.block_publish_during_ingest();

-- Trigger functions must NOT be directly executable by anyone; the triggers
-- invoke them regardless of execute privilege.
revoke all on function public.ingest_bump_by_packet() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_by_section() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_by_item() from public, anon, authenticated, service_role;
revoke all on function public.ingest_bump_packet_self() from public, anon, authenticated, service_role;
revoke all on function public.block_publish_during_ingest() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. create_ingestion_run — append / section_append (packet already exists).
--    p_chunks: { ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation }
-- ----------------------------------------------------------------------------
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
  v_user uuid; v_status text; v_mode text; v_rev bigint;
  v_sec_packet uuid; v_run_id uuid; v_base_sections int; v_base_items int; c jsonb; n int;
begin
  if p_entry_point not in ('append','section_append') then
    raise exception 'ingestion: create_ingestion_run is for append/section_append (got %)', p_entry_point;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  select user_id, status, composition_mode, content_rev into v_user, v_status, v_mode, v_rev
    from public.packets where id = p_packet_id for update;
  if v_user is null then raise exception 'ingestion: packet % not found', p_packet_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own packet %', p_packet_id; end if;
  if v_status <> 'draft' then raise exception 'ingestion: packet % is not draft', p_packet_id; end if;
  if p_entry_point = 'append' and v_mode <> 'legacy' then
    raise exception 'ingestion: append requires legacy composition mode';
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
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev
  ) values (
    p_owner, p_packet_id, p_entry_point,
    case when p_entry_point = 'section_append' then p_target_section_id else null end,
    p_source_text, p_source_hash, p_source_len, p_segmenter_version, 'active', n, 0, v_base_sections, v_base_items, v_rev
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

-- ----------------------------------------------------------------------------
-- 6. create_organize_run — Organize: create the draft packet + run + plan +
--    origin marker in ONE transaction (no orphan draft on partial failure).
-- ----------------------------------------------------------------------------
create or replace function public.create_organize_run(
  p_owner uuid,
  p_packet_type text,
  p_slug text,
  p_source_text text,
  p_source_hash text,
  p_source_len int,
  p_segmenter_version text,
  p_chunks jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_packet uuid; v_run uuid; c jsonb; n int;
begin
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'ingestion: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'ingestion: at least one chunk required'; end if;

  insert into public.packets (user_id, slug, packet_type, status)
    values (p_owner, p_slug, coalesce(nullif(p_packet_type,''),'general'), 'draft')
    returning id into v_packet;

  insert into public.ingestion_runs (
    user_id, packet_id, entry_point, source_text, source_hash, source_len,
    segmenter_version, status, total_chunks, completed_chunks, baseline_section_count, baseline_item_count, baseline_content_rev
  ) values (
    p_owner, v_packet, 'organize', p_source_text, p_source_hash, p_source_len,
    p_segmenter_version, 'active', n, 0, 0, 0, 0
  ) returning id into v_run;

  for c in select value from jsonb_array_elements(p_chunks) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status)
    values (v_run, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
            c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
            coalesce((c->>'is_continuation')::boolean, false), 'pending');
  end loop;

  update public.packets set origin_ingestion_run_id = v_run where id = v_packet;

  return jsonb_build_object('packet_id', v_packet, 'run_id', v_run);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. claim_chunk — ATOMIC claim so two requests can't both invoke the model.
--    Locks run + chunk; moves pending / retryable-failed / lease-expired
--    processing to 'processing' and increments attempt exactly once. A live
--    'processing'/'completed'/'split' chunk returns claimed=false.
-- ----------------------------------------------------------------------------
create or replace function public.claim_chunk(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_lease_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_rstatus text; v_chunk record;
begin
  select user_id, status into v_user, v_rstatus from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_rstatus <> 'active' then raise exception 'ingestion: run is % (not active)', v_rstatus; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal for update;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;

  if v_chunk.status = 'completed' then return jsonb_build_object('claimed', false, 'status', 'completed'); end if;
  if v_chunk.status = 'split' then return jsonb_build_object('claimed', false, 'status', 'split'); end if;
  if v_chunk.status = 'processing'
     and v_chunk.updated_at + make_interval(secs => p_lease_seconds) > now() then
    return jsonb_build_object('claimed', false, 'status', 'processing');
  end if;

  update public.ingestion_chunks
    set status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
    where id = v_chunk.id;

  return jsonb_build_object(
    'claimed', true, 'status', 'processing', 'ordinal', v_chunk.ordinal,
    'segment_text', v_chunk.segment_text, 'segment_hash', v_chunk.segment_hash,
    'section_hint', v_chunk.section_hint, 'is_continuation', v_chunk.is_continuation,
    'source_start', v_chunk.source_start, 'source_end', v_chunk.source_end,
    'split_depth', v_chunk.split_depth
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. stage_chunk_result — idempotent staging (attempt is counted at claim).
-- ----------------------------------------------------------------------------
create or replace function public.stage_chunk_result(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_segment_hash text, p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_status text; v_chunk record;
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
  if v_chunk.status = 'completed' then
    return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',true);
  end if;
  if jsonb_typeof(p_result) <> 'object' then raise exception 'ingestion: chunk result must be an object'; end if;

  update public.ingestion_chunks
    set result = p_result, status = 'completed', error = '', updated_at = now()
    where id = v_chunk.id;
  update public.ingestion_runs set completed_chunks = completed_chunks + 1, updated_at = now() where id = p_run_id;

  return jsonb_build_object('status','completed','ordinal',p_ordinal,'reused',false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. mark_chunk_failed — record a failure (attempt already counted at claim).
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
    set status = 'failed', error = coalesce(p_error,''), updated_at = now()
    where run_id = p_run_id and ordinal = p_ordinal and status <> 'completed';
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. split_chunk — adaptive subdivision (idempotent if already split).
--     p_children: { source_start, source_end, segment_text, segment_hash, is_continuation }
-- ----------------------------------------------------------------------------
create or replace function public.split_chunk(
  p_run_id uuid, p_owner uuid, p_ordinal int, p_children jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid; v_status text; v_chunk record; v_next int; ch jsonb; v_added int := 0; v_hint text;
begin
  select user_id, status into v_user, v_status from public.ingestion_runs where id = p_run_id for update;
  if v_user is null then raise exception 'ingestion: run % not found', p_run_id; end if;
  if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
  if v_status <> 'active' then raise exception 'ingestion: run is % (not active)', v_status; end if;

  select * into v_chunk from public.ingestion_chunks where run_id = p_run_id and ordinal = p_ordinal for update;
  if v_chunk.id is null then raise exception 'ingestion: chunk % not found', p_ordinal; end if;
  if v_chunk.status = 'completed' then raise exception 'ingestion: chunk % already completed', p_ordinal; end if;
  if v_chunk.status = 'split' then return jsonb_build_object('added', 0, 'alreadySplit', true); end if;
  if v_chunk.split_depth >= 4 then raise exception 'ingestion: chunk % too small to subdivide further', p_ordinal; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) < 2 then
    raise exception 'ingestion: split needs >= 2 children';
  end if;

  v_hint := v_chunk.section_hint;
  update public.ingestion_chunks set status = 'split', updated_at = now() where id = v_chunk.id;

  select coalesce(max(ordinal),0) + 1 into v_next from public.ingestion_chunks where run_id = p_run_id;
  for ch in select value from jsonb_array_elements(p_children) loop
    insert into public.ingestion_chunks (run_id, ordinal, source_start, source_end, segment_text, segment_hash, section_hint, is_continuation, status, split_depth)
    values (p_run_id, v_next, (ch->>'source_start')::int, (ch->>'source_end')::int,
            ch->>'segment_text', coalesce(ch->>'segment_hash',''), v_hint,
            coalesce((ch->>'is_continuation')::boolean, false), 'pending', v_chunk.split_depth + 1);
    v_next := v_next + 1; v_added := v_added + 1;
  end loop;

  update public.ingestion_runs set total_chunks = total_chunks + (v_added - 1), updated_at = now() where id = p_run_id;
  return jsonb_build_object('added', v_added);
end;
$$;

-- ----------------------------------------------------------------------------
-- 11. finalize_ingestion_run — apply staged result to the canonical packet in
--     ONE transaction; refuse if content_rev changed; recombine by continuation
--     flag; then clear ALL source-derived staged material.
-- ----------------------------------------------------------------------------
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
          insert into public.items (section_id, title, address, description, notes, sort_order)
            values (v_new_section, coalesce(nullif(it->>'title',''),'Item'), coalesce(it->>'address',''),
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
    for leaf in select * from public.ingestion_chunks where run_id = p_run_id and status <> 'split' order by source_start loop
      for it in select value from jsonb_array_elements(coalesce(leaf.result->'items','[]'::jsonb)) loop
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
    update public.packets set raw_input = coalesce(raw_input,'') || E'\n\n--- Added ---\n\n' || coalesce(v_run.source_text,'')
      where id = v_run.packet_id;
  end if;

  -- Finalize + privacy cleanup (same transaction): drop ALL source-derived fields.
  update public.ingestion_runs
    set status = 'finalized', finalized_at = now(), completed_chunks = total_chunks,
        source_text = null, derived_title = '', derived_client_name = '', error = '', updated_at = now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
    where run_id = p_run_id;

  return jsonb_build_object('status','finalized','reused',false,'sections',v_sections,'items',v_items);
end;
$$;

-- ----------------------------------------------------------------------------
-- 12. discard_ingestion_run — abandon; clear ALL source-derived material; delete
--     the packet ONLY under strict explicit conditions.
-- ----------------------------------------------------------------------------
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
  if v_run.status = 'finalized' then raise exception 'ingestion: run already finalized'; end if;

  update public.ingestion_runs
    set status='discarded', source_text=null, derived_title='', derived_client_name='', error='', updated_at=now()
    where id = p_run_id;
  update public.ingestion_chunks
    set result=null, segment_text=null, section_hint='', error='', updated_at=now()
    where run_id = p_run_id;

  select status, origin_ingestion_run_id into v_pstatus, v_origin from public.packets where id = v_run.packet_id for update;
  select count(*) into v_secs from public.sections where packet_id = v_run.packet_id;
  select count(*) into v_items from public.items i join public.sections s on s.id = i.section_id where s.packet_id = v_run.packet_id;
  select count(*) into v_blocks from public.packet_blocks where packet_id = v_run.packet_id;

  if v_run.entry_point = 'organize' and v_origin = p_run_id and v_pstatus = 'draft'
     and v_secs = 0 and v_items = 0 and v_blocks = 0 then
    delete from public.packets where id = v_run.packet_id;
    v_deleted := true;
  end if;

  return jsonb_build_object('status','discarded','deletedPacket',v_deleted);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: callable RPCs are service-role only. (Trigger functions are revoked
-- above and never granted.)
-- ----------------------------------------------------------------------------
revoke all on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_ingestion_run(uuid, uuid, text, uuid, text, text, int, text, jsonb) to service_role;
revoke all on function public.create_organize_run(uuid, text, text, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_organize_run(uuid, text, text, text, text, int, text, jsonb) to service_role;
revoke all on function public.claim_chunk(uuid, uuid, int, int) from public, anon, authenticated, service_role;
grant execute on function public.claim_chunk(uuid, uuid, int, int) to service_role;
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
