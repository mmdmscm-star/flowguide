-- 0022 — the Library import lifecycle: create, materialise, close.
--
-- WHY THIS CANNOT BE APPLICATION-ONLY. Each of the three is here for a reason
-- that does not survive being moved into a route.
--
--   create_library_import_run — the run row AND every chunk must appear
--     together. The packet path already works this way: create_organize_run
--     takes p_chunks jsonb and inserts them in the same transaction. Done from
--     the app it is two PostgREST calls, and a crash between them leaves a run
--     with zero chunks — a run that can never complete, and which occupies the
--     one-active-import-per-professional slot, blocking every future import
--     until someone clears it by hand. That is the same split-write class 0021
--     eliminated for the save. Neither existing create RPC can be reused:
--     create_ingestion_run hard-refuses anything but append/section_append, and
--     create_organize_run is organize-only and creates a packet.
--
--   library_materialize_proposals — an INSERT ... SELECT out of
--     ingestion_chunks, which PostgREST cannot express. Done from the app it
--     would ship every extracted item out and straight back in, and would
--     duplicate the leaf-selection rule (completed chunks only; a split parent
--     is represented by its children, never itself).
--
--   library_close_import_run — three writes that must not split. A half-closed
--     run leaves proposals whose run is no longer active, which
--     library_save_proposal refuses: visible on screen, impossible to save.
--
-- WHAT IT DOES NOT DO. No packet, section, item or block is created anywhere in
-- this file. Library imports do not call packet finalize and never touch
-- composition. Nothing here writes to library_items either — that remains
-- library_save_proposal's job alone, so the Library keeps exactly one writer.

begin;

-- ---------------------------------------------------------------------------
-- 1. create_library_import_run — run + chunks, atomically.
--
--    Mirrors create_organize_run's shape deliberately, minus everything
--    packet-specific: no packet, no slug, no baselines, no origin marker.
-- ---------------------------------------------------------------------------
create or replace function public.create_library_import_run(
  p_owner uuid,
  p_source_text text,
  p_source_hash text,
  p_source_len int,
  p_segmenter_version text,
  p_chunks jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $clr$
declare v_run uuid; v_hash text; c jsonb; n int;
begin
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'library: chunks must be an array'; end if;
  n := jsonb_array_length(p_chunks);
  if n < 1 then raise exception 'library: at least one chunk required'; end if;

  -- ONE IMPORT PER PROFESSIONAL. A resubmit of the SAME paste reconnects to the
  -- run already in flight; a different paste is refused while one is open,
  -- because an import owns the review layer and two would leave a professional
  -- in two review sittings with no way to tell the proposals apart.
  select id, source_hash into v_run, v_hash
    from public.ingestion_runs
   where user_id = p_owner and destination = 'library'
     and status in ('active','finalizing','needs_review');
  if v_run is not null then
    if v_hash = p_source_hash then
      return jsonb_build_object('run_id', v_run, 'reused', true);
    end if;
    raise exception 'library: an import is already in progress';
  end if;

  begin
    insert into public.ingestion_runs (
      user_id, packet_id, destination, entry_point,
      source_text, source_hash, source_len, segmenter_version,
      status, total_chunks, completed_chunks
    ) values (
      p_owner, null, 'library', 'library_import',
      p_source_text, p_source_hash, p_source_len, p_segmenter_version,
      'active', n, 0
    ) returning id into v_run;

    for c in select value from jsonb_array_elements(p_chunks) loop
      insert into public.ingestion_chunks (
        run_id, ordinal, source_start, source_end, segment_text, segment_hash,
        section_hint, is_continuation, status
      ) values (
        v_run, (c->>'ordinal')::int, (c->>'source_start')::int, (c->>'source_end')::int,
        c->>'segment_text', coalesce(c->>'segment_hash',''), coalesce(c->>'section_hint',''),
        coalesce((c->>'is_continuation')::boolean, false), 'pending'
      );
    end loop;

    return jsonb_build_object('run_id', v_run, 'reused', false);
  exception when unique_violation then
    -- Lost the race for the one-active-import slot. Return the winner rather
    -- than surfacing a constraint error at a professional.
    select id, source_hash into v_run, v_hash
      from public.ingestion_runs
     where user_id = p_owner and destination = 'library'
       and status in ('active','finalizing','needs_review');
    if v_run is null then raise; end if;   -- some other unique conflict
    if v_hash <> p_source_hash then raise exception 'library: an import is already in progress'; end if;
    return jsonb_build_object('run_id', v_run, 'reused', true);
  end;
end;
$clr$;

-- ---------------------------------------------------------------------------
-- 2. library_materialize_proposals — staged model output becomes reviewable.
--
--    IDEMPOTENT BY CONSTRUCTION, and `do nothing` rather than `do update` is
--    load-bearing: re-running after a reconnect must never overwrite an edit the
--    professional has already made to a proposal.
--
--    Refuses to run while any chunk is still outstanding. That is what makes
--    (ordinal, idx) stable — once every chunk is completed or split, the chunk
--    set is final, so a repeat produces exactly the same pairs.
-- ---------------------------------------------------------------------------
create or replace function public.library_materialize_proposals(
  p_owner uuid, p_run_id uuid
) returns int
language plpgsql
security definer
set search_path = ''
as $lmp$
declare v_run record; v_outstanding int; v_inserted int;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'library: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'library: caller does not own run'; end if;
  if v_run.destination <> 'library' then raise exception 'library: run % is not a library import', p_run_id; end if;
  if v_run.status <> 'active' then
    raise exception 'library: run % is % — proposals materialise only on an active import', p_run_id, v_run.status;
  end if;

  select count(*) into v_outstanding from public.ingestion_chunks
   where run_id = p_run_id and status not in ('completed','split');
  if v_outstanding > 0 then
    raise exception 'library: % chunk(s) still outstanding', v_outstanding;
  end if;

  -- Only COMPLETED chunks contribute. A split parent is represented by its
  -- children and never by itself — the same rule finalize applies.
  with proposed as (
    select ch.ordinal,
           (it.ord - 1)::int as idx,
           it.value          as payload
      from public.ingestion_chunks ch
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(ch.result->'items') = 'array'
             then ch.result->'items' else '[]'::jsonb end
      ) with ordinality as it(value, ord)
     where ch.run_id = p_run_id
       and ch.status = 'completed'
       and jsonb_typeof(it.value) = 'object'
  )
  insert into public.library_import_proposals (run_id, ordinal, idx, payload)
  select p_run_id, ordinal, idx, payload from proposed
  on conflict (run_id, ordinal, idx) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$lmp$;

-- ---------------------------------------------------------------------------
-- 3. library_close_import_run — finish or abandon, in one transaction.
--
--    One function rather than two near-identical ones. Anything still unsaved is
--    discarded: nothing becomes a Library item except through an explicit save.
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

  update public.ingestion_runs
     set status = p_status, source_text = null, derived_title = '',
         derived_client_name = '', error = '', updated_at = now()
   where id = p_run_id;

  update public.ingestion_chunks
     set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
   where run_id = p_run_id;

  return jsonb_build_object('status', p_status, 'droppedProposals', v_dropped, 'reused', false);
end;
$lci$;

-- ---------------------------------------------------------------------------
-- 4. Privileges — service role only, like every other ingestion and Library RPC.
-- ---------------------------------------------------------------------------
revoke all on function public.create_library_import_run(uuid, text, text, int, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_library_import_run(uuid, text, text, int, text, jsonb) to service_role;
revoke all on function public.library_materialize_proposals(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.library_materialize_proposals(uuid, uuid) to service_role;
revoke all on function public.library_close_import_run(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.library_close_import_run(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Structural verification. Anything wrong rolls the whole migration back.
-- ---------------------------------------------------------------------------
do $verify$
declare v_name text; v_acl text;
begin
  foreach v_name in array array['create_library_import_run',
                                'library_materialize_proposals',
                                'library_close_import_run'] loop
    if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname = 'public' and p.proname = v_name
                      and p.prosecdef
                      and coalesce(array_to_string(p.proconfig, ','), '') like 'search_path=%') then
      raise exception '0022 verify: % is missing, or is not security definer with a pinned search_path', v_name;
    end if;

    select coalesce(array_to_string(p.proacl, ' '), 'DEFAULT') into v_acl
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = v_name;
    if v_acl = 'DEFAULT' then
      raise exception '0022 verify: % has default privileges, so PUBLIC can execute it', v_name;
    end if;
    if v_acl ~ '(^| )=X' or v_acl like '%anon=X%' or v_acl like '%authenticated=X%' then
      raise exception '0022 verify: % is executable by PUBLIC/anon/authenticated: %', v_name, v_acl;
    end if;
  end loop;

  -- Nothing in this migration may create packet composition.
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public'
                and p.proname in ('create_library_import_run','library_materialize_proposals','library_close_import_run')
                and (p.prosrc ilike '%insert into public.sections%'
                  or p.prosrc ilike '%insert into public.items%'
                  or p.prosrc ilike '%insert into public.packet_blocks%'
                  or p.prosrc ilike '%insert into public.packets%')) then
    raise exception '0022 verify: a library lifecycle function creates packet composition';
  end if;

  -- And nothing here may write library_items: that is library_save_proposal's
  -- job alone, so the Library keeps exactly one writer.
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public'
                and p.proname in ('create_library_import_run','library_materialize_proposals','library_close_import_run')
                and p.prosrc ilike '%insert into public.library_items%') then
    raise exception '0022 verify: a library lifecycle function writes library_items directly';
  end if;

  raise notice '0022 verify: OK';
end
$verify$;

commit;
