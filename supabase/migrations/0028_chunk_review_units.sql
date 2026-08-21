-- 0028 - A DEDICATED CHANNEL FOR REVIEW-REQUIRED UNITS.
--
-- WHY THIS EXISTS
-- 0027 shipped the review path by carrying held units through
-- `ingestion_chunks.fact_ledger`. That worked, and it was wrong: the ledger was
-- introduced as observe-only evidence, with a source invariant asserting it had
-- no reader at all. Product behaviour reading it made evidence load-bearing, so
-- a change to what we record for diagnosis could change what a professional is
-- asked to decide. Those are different lifecycles and they need different
-- columns.
--
-- WHAT GOES IN IT
-- ONLY review-required units: a known contract violation where source content
-- would otherwise be silently hidden, lost or treated unsafely, and a human
-- decision is required. Today that is exactly `privacy_rejected`.
--
-- What does NOT go in it: observed-unresolved telemetry - material the
-- deterministic layer recognizes but cannot prove enough about to demand a
-- specific decision, such as ambiguous unlabelled pricing. That stays in the
-- ledger. Promoting it here to make the accounting visible would produce review
-- fatigue and teach people to click through warnings, which costs more than it
-- buys.
--
-- LIFECYCLE
-- This column holds VERBATIM SOURCE TEXT, so it is governed exactly like the
-- other evidence: the same clearers null it, and a chunk holding only
-- review_units is still eligible for purge. The PERSISTED review state that a
-- professional acts on lives in `ingestion_runs.review` and follows the separate
-- lifecycle 0027 proved - finalize aggregates from here to there, and the copy
-- here is a transport buffer, not the record.
--
-- The two functions below are the LIVE definitions, pulled from the catalog and
-- edited by rule rather than retyped. The only changes are the two shown in the
-- migration notes: `review_units = null` alongside `fact_ledger = null`, and
-- `review_units` added to the purge-eligibility predicate.

begin;

alter table public.ingestion_chunks
  add column if not exists review_units jsonb;

comment on column public.ingestion_chunks.review_units is
  'Review-REQUIRED units produced by the semantic contract for this chunk: [{id, code, kind, record, title, text, reason, status}]. Product state, aggregated into ingestion_runs.review at finalize. Not telemetry - observed-unresolved material stays in fact_ledger. Cleared by the same evidence clearers, because it holds verbatim source text.';

CREATE OR REPLACE FUNCTION public.library_close_import_run(p_owner uuid, p_run_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
       set result = null, segment_text = null, section_hint = '', error = '', fact_ledger = null, review_units = null, updated_at = now()
     where run_id = p_run_id;
  end if;

  return jsonb_build_object('status', p_status, 'droppedProposals', v_dropped, 'reused', false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.purge_ingestion_evidence()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_runs int := 0; v_orphans int := 0;
begin
  -- 0026: ORPHAN RUNS DO NOT ACCUMULATE FOR EVER.
  --
  -- Three lifecycles, deliberately different:
  --   * a run whose packet still exists keeps operational metadata after its
  --     evidence is purged — status, timings, chunk counts, hashes. No content.
  --   * a run whose packet was DELETED keeps full diagnostic evidence for the
  --     same 30-day window, which is the whole point of 0026.
  --   * after that window an orphan has no product or provenance reason to
  --     exist, so the row itself goes rather than leaving permanent metadata
  --     about a draft nobody can see.
  --
  -- Guarded on provenance: a run still referenced by a saved Library entry is
  -- never deleted, because that reference is a product fact, not diagnostics.
  -- Chunks and proposals cascade from the run.
  --
  -- This runs BEFORE the clearing below: the clearing nulls evidence_purge_after,
  -- which is the very marker this predicate needs.
  delete from public.ingestion_runs r
   where r.packet_deleted_at is not null
     and r.evidence_purge_after is not null
     and r.evidence_purge_after <= now()
     and not exists (select 1 from public.library_items li where li.origin_run_id = r.id);
  get diagnostics v_orphans = row_count;

  update public.ingestion_chunks c
     set result = null, segment_text = null, section_hint = '', error = '', fact_ledger = null, review_units = null, updated_at = now()
   where c.run_id in (
           select r.id from public.ingestion_runs r
            where r.evidence_purge_after is not null and r.evidence_purge_after <= now())
     and (c.result is not null or c.segment_text is not null or c.fact_ledger is not null
          or c.review_units is not null);

  update public.ingestion_runs r
     set source_text = null, error = '', evidence_purge_after = null, updated_at = now()
   where r.evidence_purge_after is not null and r.evidence_purge_after <= now();
  get diagnostics v_runs = row_count;

  -- Both kinds of work, so a scheduled run reports what it actually did.
  return v_runs + v_orphans;
end;
$function$;

commit;
