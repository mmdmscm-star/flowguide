-- 0024 — ingestion evidence retention, Library provenance, and scheduled expiry.
--
-- WHY. A completed Library import destroyed its own evidence. Finishing cleared
-- the source text, every segment and every model result — so when a real
-- 61-record import produced inconsistent field placement, there was nothing left
-- to compare an output against its input. The investigation that found this
-- could not be completed, and that is the defect this migration repairs.
--
-- The chain was broken in TWO places. Besides the clearing, library_items
-- carried no link to the run, chunk or proposal that produced it — so even with
-- nothing cleared, no output could be traced back to its input.
--
-- SCOPE. Retention, provenance and expiry ONLY. No prompt, routing, semantic
-- classification or photo-normalisation change. Nothing about how a fact is
-- classified moves in this migration; it exists so that question can be studied
-- at all.
--
-- RETAINED EVIDENCE IS TREATED AS POTENTIALLY SENSITIVE USER AND BUSINESS DATA.
-- Source text can carry contacts, pricing, private notes and customer
-- information. Every table holding it has RLS enabled with no policies, is
-- reachable only through the service role, and is touched by no recipient-facing
-- path. The safety argument here is the BOUNDED WINDOW, not any claim that the
-- data is harmless.
--
-- IDEMPOTENT THROUGHOUT: add column if not exists, drop-then-add for the
-- constraint, create or replace for functions, drop-then-create for the trigger,
-- create extension if not exists, and unschedule-then-schedule for the job.

begin;

-- ---------------------------------------------------------------------------
-- 1. Retention, made explicit per run.
--
--    A dedicated column rather than inferring from updated_at, which many
--    unrelated writes bump. This makes the policy inspectable: you can ask any
--    run when its evidence expires.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists evidence_purge_after timestamptz;

comment on column public.ingestion_runs.evidence_purge_after is
  'When retained source/segment/result evidence becomes eligible for purging. Set on finalize, cleared on discard and after purging. NULL means nothing is retained.';

-- ---------------------------------------------------------------------------
-- 2. The missing edge: which run, chunk and item produced a Library entry.
--
--    Named exactly as 0014 already names provenance on public.items, so the
--    concept means one thing across the codebase. They are NOT the same claim:
--    library_items.origin_* records where a SAVED ENTRY came from, while
--    items.origin_* records what a PACKET ITEM was ingested from and is what the
--    0016 ownership gate reads. library_copy_into_section must continue not to
--    copy one into the other.
-- ---------------------------------------------------------------------------
alter table public.library_items
  add column if not exists origin_run_id uuid references public.ingestion_runs(id) on delete set null,
  add column if not exists origin_chunk_ordinal int,
  add column if not exists origin_item_index int;

-- ALL THREE OR NONE. A half-recorded coordinate cannot locate anything, and
-- 0017 set the precedent for making that unrepresentable rather than merely
-- unlikely.
alter table public.library_items drop constraint if exists library_items_origin_coherent;
alter table public.library_items add constraint library_items_origin_coherent
  check ((origin_run_id is null) = (origin_chunk_ordinal is null)
     and (origin_run_id is null) = (origin_item_index is null));

create index if not exists library_items_origin_idx
  on public.library_items(origin_run_id) where origin_run_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Deleting a run clears the whole triplet, atomically.
--
--    The FK above says `on delete set null`, which alone would null ONE column,
--    violate the coherence CHECK, and make deleting a run FAIL — which would in
--    turn block deleting a user. This trigger clears all three first, so the
--    FK's own action is a no-op. That ordering is exactly why 0017 needed a
--    trigger rather than relying on the FK.
--
--    Note this fires on DELETE, not on purge: purging keeps the run and chunk
--    rows, so the coordinates stay meaningful even once the text is gone.
-- ---------------------------------------------------------------------------
create or replace function public.library_clear_origin_on_run_delete() returns trigger
language plpgsql security definer set search_path = '' as $lco$
begin
  update public.library_items
     set origin_run_id = null, origin_chunk_ordinal = null, origin_item_index = null
   where origin_run_id = old.id;
  return old;
end;
$lco$;

drop trigger if exists trg_library_clear_origin on public.ingestion_runs;
create trigger trg_library_clear_origin before delete on public.ingestion_runs
  for each row execute function public.library_clear_origin_on_run_delete();

-- ---------------------------------------------------------------------------
-- 4. The purge itself.
--
--    NEVER TOUCHES library_items. Purging removes the ability to reconstruct
--    content; it does not remove, alter or unlink anything a professional saved.
--    Idempotent: clearing evidence_purge_after means a purged run is never
--    selected again, and only runs still holding something are updated.
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
     set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
   where c.run_id in (
           select r.id from public.ingestion_runs r
            where r.evidence_purge_after is not null and r.evidence_purge_after <= now())
     and (c.result is not null or c.segment_text is not null);

  update public.ingestion_runs r
     set source_text = null, evidence_purge_after = null, updated_at = now()
   where r.evidence_purge_after is not null and r.evidence_purge_after <= now();
  get diagnostics v_runs = row_count;

  return v_runs;
end;
$pie$;

comment on function public.purge_ingestion_evidence() is
  'Clear retained import evidence whose retention window has passed. Never modifies library_items. Idempotent.';

-- ---------------------------------------------------------------------------
-- 5. Record the coordinates when an entry is saved.
--    Re-issued from 0021 with the insert extended; nothing else changed.
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
    (user_id, title, address, description, notes, details, links, photos, contacts,
     -- 0024: WHERE THIS ENTRY CAME FROM. Three values this function already
     -- holds, so recording them costs no extra read. They are the coordinates
     -- that make a finished import reconstructable:
     -- result->'items'->origin_item_index of the chunk at origin_chunk_ordinal.
     origin_run_id, origin_chunk_ordinal, origin_item_index)
  values (
    p_owner,
    v_title,
    coalesce(v_p.payload->>'address', ''),
    coalesce(v_p.payload->>'description', ''),
    coalesce(v_p.payload->>'notes', ''),
    case when jsonb_typeof(v_p.payload->'details')  = 'array' then v_p.payload->'details'  else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'links')    = 'array' then v_p.payload->'links'    else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'photos')   = 'array' then v_p.payload->'photos'   else '[]'::jsonb end,
    case when jsonb_typeof(v_p.payload->'contacts') = 'array' then v_p.payload->'contacts' else '[]'::jsonb end,
    p_run_id, v_p.ordinal, v_p.idx
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

-- ---------------------------------------------------------------------------
-- 6. Finishing keeps the evidence; discarding still clears it.
--    Re-issued from 0022 with the clearing block replaced; nothing else changed.
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
       set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
     where run_id = p_run_id;
  end if;

  return jsonb_build_object('status', p_status, 'droppedProposals', v_dropped, 'reused', false);
end;
$lci$;

-- ---------------------------------------------------------------------------
-- 7. Actual scheduled expiry.
--
--    pg_cron is preloaded on this server (confirmed in preflight row 3), which
--    is the only precondition SQL cannot create for itself. Scheduling in the
--    database rather than through an HTTP endpoint deliberately avoids exposing
--    an internet-reachable route whose job is destroying evidence.
--
--    Daily at 03:17 UTC — an odd minute so it does not coincide with the top of
--    the hour, when everything else on a host tends to run.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'flowguide-purge-ingestion-evidence') then
    perform cron.unschedule('flowguide-purge-ingestion-evidence');
  end if;
  perform cron.schedule('flowguide-purge-ingestion-evidence', '17 3 * * *',
                        'select public.purge_ingestion_evidence()');
end
$sched$;

-- ---------------------------------------------------------------------------
-- 8. Privileges — service role only, like every other write RPC here.
-- ---------------------------------------------------------------------------
revoke all on function public.purge_ingestion_evidence() from public, anon, authenticated, service_role;
grant execute on function public.purge_ingestion_evidence() to service_role;
revoke all on function public.library_clear_origin_on_run_delete() from public, anon, authenticated, service_role;
revoke all on function public.library_save_proposal(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.library_save_proposal(uuid, uuid, uuid) to service_role;
revoke all on function public.library_close_import_run(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.library_close_import_run(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof — that a finished import is still traceable end to end —
--    is Step 4, deliberately outside this transaction.
-- ---------------------------------------------------------------------------
do $verify$
declare v_def text; v_acl text; v_name text;
begin
  -- columns
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='ingestion_runs'
                    and column_name='evidence_purge_after') then
    raise exception '0024 verify: evidence_purge_after is missing';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='library_items'
         and column_name in ('origin_run_id','origin_chunk_ordinal','origin_item_index')) <> 3 then
    raise exception '0024 verify: the library_items origin triplet is incomplete';
  end if;

  -- coherence
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.library_items'::regclass and conname='library_items_origin_coherent';
  if v_def is null then raise exception '0024 verify: the origin coherence CHECK is missing'; end if;
  if v_def !~ 'origin_chunk_ordinal' or v_def !~ 'origin_item_index' then
    raise exception '0024 verify: the coherence CHECK does not cover all three columns: %', v_def;
  end if;

  -- the trigger that keeps deletion coherent, and its ordering
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname='ingestion_runs' and t.tgname='trg_library_clear_origin'
                    and not t.tgisinternal and (t.tgtype & 2) <> 0) then
    raise exception '0024 verify: trg_library_clear_origin is missing or is not BEFORE DELETE';
  end if;

  -- the purge must not be able to touch saved entries
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='purge_ingestion_evidence'
                and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'library_items') then
    raise exception '0024 verify: purge_ingestion_evidence references library_items';
  end if;

  -- finalize must no longer clear the source
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='library_close_import_run'
                    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'evidence_purge_after') then
    raise exception '0024 verify: library_close_import_run does not set a retention stamp';
  end if;

  -- and saving must record the coordinates
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='library_save_proposal'
                    and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'origin_run_id') then
    raise exception '0024 verify: library_save_proposal does not record provenance';
  end if;

  -- the schedule really exists
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception '0024 verify: pg_cron is not installed';
  end if;
  if not exists (select 1 from cron.job where jobname = 'flowguide-purge-ingestion-evidence' and active) then
    raise exception '0024 verify: the purge is not scheduled, so retention would be a claim rather than a policy';
  end if;

  -- privileges
  foreach v_name in array array['purge_ingestion_evidence','library_save_proposal','library_close_import_run'] loop
    select coalesce(array_to_string(p.proacl, ' '), 'DEFAULT') into v_acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=v_name;
    if v_acl = 'DEFAULT' or v_acl ~ '(^| )=X' or v_acl like '%anon=X%' or v_acl like '%authenticated=X%' then
      raise exception '0024 verify: % is executable beyond service_role: %', v_name, v_acl;
    end if;
  end loop;

  -- the posture that keeps evidence private must still hold
  if exists (select 1 from pg_policies
              where schemaname='public'
                and tablename in ('ingestion_runs','ingestion_chunks','library_items','library_import_proposals')) then
    raise exception '0024 verify: a policy appeared on an evidence table; it must stay service-role only';
  end if;

  raise notice '0024 verify: OK';
end
$verify$;

commit;
