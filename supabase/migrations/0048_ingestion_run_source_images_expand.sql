-- ============================================================================
-- 0048 — MANY SOURCE IMAGES, IN ORDER. THE TRANSITIONAL HALF.
--
-- A professional photographs three pages of a brochure. All three are read, one
-- combined transcription is produced, and exactly ONE image is kept: the run
-- carries `source_image_url`, singular, and the browser overwrites its preview
-- on every new picture. On the Spring Lake run that is why a mis-transcribed
-- licence number could not be checked — two of the three pages no longer
-- existed anywhere by the time anyone looked.
--
-- So the evidence becomes an ORDERED LIST. This migration is the EXPAND half of
-- an expand/contract, and it is deliberately permissive: it must be applyable
-- to production BEFORE the code that writes the new column exists.
--
-- ---------------------------------------------------------------------------
-- THE COMPATIBILITY WINDOW IS THE WHOLE DESIGN
--
-- Between this migration and the deploy that dual-writes, the LIVE application
-- still writes only `source_image_url` and leaves the new array at its default
-- `[]`. A strict rule mirroring 0045 — "an image run with retained text has a
-- populated array" — would refuse that row, and every image ingestion in
-- production would fail from the moment this was applied until the deploy
-- landed. So the transitional rule permits BOTH writers:
--
--   old writer   source_image_url populated, source_image_urls = []
--   dual writer  source_image_url populated, source_image_urls = [that url, ...]
--
-- AND IT STILL REFUSES EVERY INCOHERENT SHAPE. A populated array whose first
-- element is not the singular URL is two different claims about which document
-- this run came from, and it is refused. A text-origin run carrying image
-- evidence is refused. A purged run that kept its images — the 0045 mistake,
-- one column over — is refused.
--
-- The strict rule arrives in the CONTRACT migration, which also backfills any
-- rows the old writer created during this window, proves every live image run
-- has a valid array, and drops the singular column. It is deliberately NOT
-- drafted yet: it must be written against what production actually looks like
-- after the dual-writer has run for a while.
--
-- ---------------------------------------------------------------------------
-- RETENTION IS THE POINT, NOT AN AFTERTHOUGHT
--
-- `source_image_urls` is EVIDENCE, exactly as `source_text` and
-- `source_image_url` are. It points at the professional's own documents, so it
-- must die when they do. Both clearers are re-issued below to reset it in the
-- SAME statement that nulls the singular column, and the verification asserts
-- both. An array that outlived the text it was transcribed from would be a
-- source document with no expiry, which is what 0024, 0026 and 0045 each exist
-- to prevent.
--
-- NOT SOLVED HERE, and deliberately: nothing deletes the objects themselves.
-- Clearing the pointer is retention of the RECORD; storage garbage collection
-- is its own package with its own refcounting question.
--
-- ---------------------------------------------------------------------------
-- DRIFT GUARDS. Both clearers are LIVE functions this migration rewrites, so
-- each is fingerprinted first. `pg_proc.prosrc` stores the body verbatim, so
-- md5(prosrc) catches a drift of one character in either direction, including
-- an addition. Expected — these are 0045's bodies, and both were confirmed
-- against Postgres itself rather than only computed from the file:
--
--   library_close_import_run(uuid, uuid, text)
--       md5 03ac3608e10aea4c540a8acd639568e5   2445 chars (2447 octets)
--   purge_ingestion_evidence()
--       md5 877597800bfbcba1be0997c49c34b74f   2141 chars (2143 octets)
--
-- The clause lists then say WHICH part is missing, because "the hash differs"
-- is true and useless.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. DRIFT GUARD. Refuse to replace anything that is not what we read.
-- ---------------------------------------------------------------------------
do $guard$
declare v_def text; v_src text; v_len int; v_clause text;
begin
  select pg_get_functiondef(p.oid), md5(p.prosrc), length(p.prosrc)
    into v_def, v_src, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'library_close_import_run'
     and oidvectortypes(p.proargtypes) = 'uuid, uuid, text';
  if v_def is null then raise exception '0048 guard: library_close_import_run(uuid, uuid, text) does not exist'; end if;
  if position('source_image_urls' in v_def) > 0 then
    raise exception '0048 guard: library_close_import_run already references source_image_urls';
  end if;
  if v_src <> '03ac3608e10aea4c540a8acd639568e5' or v_len <> 2445 then
    raise exception '0048 guard: library_close_import_run body is % (% chars), not the 0045 body 03ac3608e10aea4c540a8acd639568e5 (2445) this migration edits', v_src, v_len;
  end if;
  foreach v_clause in array array[
    'set status = p_status, source_text = null, source_image_url = null, derived_title',
    'derived_client_name = '''', error = '''', evidence_purge_after = null, updated_at = now()',
    'evidence_purge_after = now() + interval',
    'delete from public.library_import_proposals where run_id = p_run_id',
    'droppedProposals',
    'result = null, segment_text = null, section_hint = '''', error = '''', fact_ledger = null, review_units = null',
    'library: run % is not a library import',
    'library: close status must be finalized or discarded'
  ] loop
    if position(v_clause in v_def) = 0 then
      raise exception '0048 guard: library_close_import_run has drifted - missing clause: %', v_clause;
    end if;
  end loop;

  select pg_get_functiondef(p.oid), md5(p.prosrc), length(p.prosrc)
    into v_def, v_src, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purge_ingestion_evidence';
  if v_def is null then raise exception '0048 guard: purge_ingestion_evidence does not exist'; end if;
  if position('source_image_urls' in v_def) > 0 then
    raise exception '0048 guard: purge_ingestion_evidence already references source_image_urls';
  end if;
  if v_src <> '877597800bfbcba1be0997c49c34b74f' or v_len <> 2141 then
    raise exception '0048 guard: purge_ingestion_evidence body is % (% chars), not the 0045 body 877597800bfbcba1be0997c49c34b74f (2141) this migration edits', v_src, v_len;
  end if;
  foreach v_clause in array array[
    'set source_text = null, source_image_url = null, error = '''', evidence_purge_after = null, updated_at = now()',
    'delete from public.ingestion_runs r',
    'r.packet_deleted_at is not null',
    'public.library_items li where li.origin_run_id = r.id',
    'result = null, segment_text = null, section_hint = '''', error = '''', fact_ledger = null, review_units = null',
    'return v_runs + v_orphans'
  ] loop
    if position(v_clause in v_def) = 0 then
      raise exception '0048 guard: purge_ingestion_evidence has drifted - missing clause: %', v_clause;
    end if;
  end loop;

  -- 0045's own rule must still be there. This migration KEEPS it: during the
  -- window the singular column is still the one every writer sets.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ingestion_runs'::regclass
                    and conname = 'ingestion_runs_source_image_coherent') then
    raise exception '0048 guard: 0045 source-image coherence constraint is gone';
  end if;
  raise notice '0048 guard: both clearers match 0045';
end
$guard$;

-- ---------------------------------------------------------------------------
-- 2. The shape predicate.
--
-- A CHECK constraint may not contain a subquery, and "every element is a
-- non-empty string" needs one. So it lives in an IMMUTABLE function, which is
-- the ordinary way to express this.
--
-- DELIBERATELY NOT SECURITY DEFINER. It reads nothing, writes nothing and takes
-- its whole world from its argument, so it carries none of the risk 0043's
-- lesson is about — and EXECUTE must stay available to every writer, because a
-- CHECK is evaluated as whoever is doing the INSERT.
-- ---------------------------------------------------------------------------
create or replace function public.ingestion_source_images_valid(v jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $isv$
  select jsonb_typeof(v) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(v) e
        where jsonb_typeof(e) <> 'string' or btrim(e #>> '{}') = ''
     );
$isv$;

comment on function public.ingestion_source_images_valid(jsonb) is
  'True when the value is a JSON array whose every element is a non-empty string. Used by the shape constraint on ingestion_runs.source_image_urls; a CHECK cannot hold the subquery this needs.';

-- ---------------------------------------------------------------------------
-- 3. The column, then the backfill, then the rules — in that order, so the
--    constraints are validated against the state the backfill produced rather
--    than against the state that preceded it.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists source_image_urls jsonb not null default '[]'::jsonb;

-- EVERY EXISTING IMAGE RUN, as a one-element list. Idempotent: a row already
-- carrying an array is left alone, so a re-run cannot double it.
update public.ingestion_runs
   set source_image_urls = jsonb_build_array(source_image_url)
 where source_image_url is not null
   and source_image_urls = '[]'::jsonb;

alter table public.ingestion_runs
  add constraint ingestion_runs_source_image_urls_shape
    check (public.ingestion_source_images_valid(source_image_urls));

-- THE TRANSITIONAL RULE. Every state either writer can produce is allowed;
-- every state neither should produce is refused.
alter table public.ingestion_runs
  add constraint ingestion_runs_source_images_transitional
    check (
      case source_origin
        -- A TEXT RUN CARRIES NO IMAGE EVIDENCE. Not one, not a list, ever.
        when 'text' then source_image_url is null and source_image_urls = '[]'::jsonb
        else
          -- PURGED: the text went, so the pointers go with it. Both of them.
          -- This is the 0045 lesson one column over: a run that kept its images
          -- after losing its text is a stale pointer at a document nobody can
          -- read, and it is refused rather than tolerated.
          (source_text is null and source_image_url is null and source_image_urls = '[]'::jsonb)
          or
          -- RETAINED: the singular column is populated, because BOTH writers
          -- set it. The array is empty (the writer deployed today) or populated
          -- (the dual writer) — and when it is populated its FIRST entry must be
          -- that same singular URL, or the row is making two different claims
          -- about which document this run came from.
          (source_text is not null and source_image_url is not null
             and (source_image_urls = '[]'::jsonb
                  or source_image_urls ->> 0 = source_image_url))
      end
    );

comment on column public.ingestion_runs.source_image_urls is
  'EVIDENCE. The source images this run was transcribed from, in the order the professional supplied them, as an ordered array of storage URLs. Cleared by the same operations that clear source_text. Transitional: during the expand window the deployed writer sets only source_image_url and leaves this empty; when it is populated its first entry is that same URL.';

-- ---------------------------------------------------------------------------
-- 4. The two clearers, re-issued: their 0045 definitions plus one assignment
--    each, in the SAME statement that already nulls the singular column.
-- ---------------------------------------------------------------------------
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
       set status = p_status, source_text = null, source_image_url = null,
           source_image_urls = '[]'::jsonb, derived_title = '',
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
     set source_text = null, source_image_url = null, source_image_urls = '[]'::jsonb,
         error = '', evidence_purge_after = null, updated_at = now()
   where r.evidence_purge_after is not null and r.evidence_purge_after <= now();
  get diagnostics v_runs = row_count;

  -- Both kinds of work, so a scheduled run reports what it actually did.
  return v_runs + v_orphans;
end;
$function$;

-- BELT AND BRACES. CREATE OR REPLACE on an unchanged signature keeps the
-- existing ACL, so these are re-assertions rather than repairs.
revoke all on function public.library_close_import_run(uuid, uuid, text) from public;
revoke all on function public.library_close_import_run(uuid, uuid, text) from anon, authenticated;
grant execute on function public.library_close_import_run(uuid, uuid, text) to service_role;
revoke all on function public.purge_ingestion_evidence() from public;
revoke all on function public.purge_ingestion_evidence() from anon, authenticated;
grant execute on function public.purge_ingestion_evidence() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof - that the transitional rule admits the old writer and
--    refuses an incoherent row - is deliberately outside this transaction, as
--    0020 established, and is in the disposable-Postgres harness instead.
-- ---------------------------------------------------------------------------
do $v$
declare v int; v_def text; v_name text;
begin
  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='source_image_urls' and is_nullable='NO'
     and column_default like '%[]%';
  if v <> 1 then raise exception '0048 verify: source_image_urls is not NOT NULL defaulting to an empty array'; end if;

  -- Both new rules, and 0045's, which this migration KEEPS.
  foreach v_name in array array['ingestion_runs_source_image_urls_shape',
                                'ingestion_runs_source_images_transitional',
                                'ingestion_runs_source_image_coherent'] loop
    select pg_get_constraintdef(oid) into v_def from pg_constraint
     where conrelid='public.ingestion_runs'::regclass and conname=v_name;
    if v_def is null then raise exception '0048 verify: constraint % is missing', v_name; end if;
  end loop;

  -- The transitional rule must actually NAME the empty-array case, or it is the
  -- strict rule wearing a transitional name and production breaks on apply.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.ingestion_runs'::regclass
     and conname='ingestion_runs_source_images_transitional';
  if position('[]' in v_def) = 0 then
    raise exception '0048 verify: the transitional rule does not admit an empty array: %', v_def;
  end if;
  if position('->> 0' in v_def) = 0 and position('->>0' in v_def) = 0 then
    raise exception '0048 verify: the transitional rule does not pin the first entry to the singular URL: %', v_def;
  end if;

  -- The shape predicate is immutable, or the constraint is not stable.
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='ingestion_source_images_valid' and p.provolatile='i';
  if v <> 1 then raise exception '0048 verify: the shape predicate is missing or not IMMUTABLE'; end if;

  -- EVERY EXISTING IMAGE RUN WAS BACKFILLED. A retained image run with an empty
  -- array is PERMITTED by the transitional rule - that is the old writer's
  -- state - so nothing else would have caught a backfill that silently did
  -- nothing, and the contract migration would then find rows it cannot fix.
  select count(*) into v from public.ingestion_runs
   where source_image_url is not null and source_image_urls = '[]'::jsonb;
  if v <> 0 then raise exception '0048 verify: % existing image run(s) were not backfilled', v; end if;

  -- BOTH CLEARERS RESET THE ARRAY, in the same breath as the singular column.
  foreach v_name in array array['library_close_import_run','purge_ingestion_evidence'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname=v_name;
    if position('source_image_url = null' in v_def) = 0 then
      raise exception '0048 verify: % no longer clears source_image_url', v_name;
    end if;
    if position('source_image_urls = ''[]''::jsonb' in v_def) = 0 then
      raise exception '0048 verify: % does not reset source_image_urls, so images would outlive their text', v_name;
    end if;
  end loop;

  -- AND NOTHING ELSE CLEARS EVIDENCE. If a third function learns to null
  -- source_text without resetting the array, the array becomes a pointer at a
  -- document whose text is gone - the failure this column's retention exists to
  -- prevent.
  -- prokind = 'f' ONLY. pg_get_functiondef raises on an aggregate or a window
  -- function, and `public` is not guaranteed to hold ordinary functions alone —
  -- an extension installed there would make this scan throw rather than answer.
  -- Found by the disposable-Postgres harness, which had exactly that shape.
  select count(*) into v from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname not in ('library_close_import_run','purge_ingestion_evidence')
     and pg_get_functiondef(p.oid) ilike '%source_text = null%';
  if v <> 0 then
    raise exception '0048 verify: % other function(s) clear source_text without resetting source_image_urls', v;
  end if;

  raise notice '0048 verify: OK';
end
$v$;

commit;
