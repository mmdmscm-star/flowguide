-- 0045 — ingestion runs remember that their source was an IMAGE, and forget
--        the image itself when they forget the rest of the evidence.
--
-- WHY. A picture is transcribed, the professional CORRECTS the transcription,
-- and the corrected text becomes `source_text`. From that point the run is
-- indistinguishable from a paste and every guard downstream works exactly as it
-- always has — there is no second truth pipeline for images. What is lost is
-- that a price the gate accepted was attested by a transcription rather than by
-- a document the professional wrote, and that a finalized run cannot show what
-- was photographed.
--
-- TWO COLUMNS, WITH DIFFERENT LIFETIMES. This is the whole design:
--
--   source_origin     PROVENANCE. Durable. An image-origin run is still an
--                     image-origin run after its evidence is gone.
--   source_image_url  EVIDENCE. It points at the source document, so it lives
--                     exactly as long as `source_text` does and is cleared by
--                     the same operation. A purge must not leave a pointer to
--                     the thing it purged.
--
-- So the coherence rule is stated against the EVIDENCE, not against the origin:
--
--   text-origin                          -> no image URL, ever
--   image-origin, evidence retained      -> BOTH present
--   image-origin, evidence cleared       -> BOTH null
--
-- The image branch is an EQUALITY, not an implication: the two fields share one
-- lifetime, so `(source_text is null) = (source_image_url is null)`. An earlier
-- draft wrote it as `source_text is null or source_image_url is not null`, which
-- reads the same way in English and is not: it permits a cleared run that still
-- holds a pointer to the picture it just purged. That stale-pointer row is the
-- one state this column exists to make impossible, so it is asserted directly
-- and proved by a negative test rather than argued about.
--
-- SCOPE. No regions, no coordinates, no page model, no second image, no
-- generalized document-source table.
--
-- WHICH FUNCTIONS ACTUALLY CLEAR SOURCE TEXT. Only two, and both were read from
-- their live definitions rather than assumed:
--
--   library_close_import_run   (live in 0028) clears in its DISCARD branch only
--   purge_ingestion_evidence   (live in 0028) clears after the 30-day window
--
-- finalize_ingestion_run (live in 0034) and discard_ingestion_run (live in
-- 0026) no longer clear anything: since 0026 they stamp evidence_purge_after
-- and leave the evidence for the window. Re-issuing them would change nothing
-- and risk everything, so they are untouched.
--
-- The two that ARE re-issued are byte-for-byte their 0028 definitions with one
-- assignment added to each clearing UPDATE. Nothing else in them moves: not the
-- orphan delete, not the chunk clearing, not the idempotent close, and not the
-- finalize branch that deliberately KEEPS evidence.
--
-- AND THEY ARE CHECKED BEFORE THEY ARE REPLACED. A CREATE OR REPLACE pulled
-- from a migration file silently reverts any drift between that file and the
-- live catalog. Step 2 refuses to run if either function is not the definition
-- this migration was written against.

begin;

-- ---------------------------------------------------------------------------
-- 1. Provenance, and the evidence it points at.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists source_origin text not null default 'text';

alter table public.ingestion_runs
  add constraint ingestion_runs_source_origin_check
    check (source_origin in ('text','image'));

alter table public.ingestion_runs
  add column if not exists source_image_url text;

-- Tied to the EVIDENCE, not to the origin. This is what lets a purged image run
-- keep saying it was an image while holding no pointer to the picture.
alter table public.ingestion_runs
  add constraint ingestion_runs_source_image_coherent
    check (
      (source_origin = 'text'  and source_image_url is null)
      or
      (source_origin = 'image' and (source_text is null) = (source_image_url is null))
    );

comment on column public.ingestion_runs.source_origin is
  'Where this run''s source_text came from: ''text'' (pasted, or a .csv/.txt/.md file) or ''image'' (a creator-confirmed transcription of an uploaded picture). Durable provenance - it survives the evidence purge. Not a processing mode: the pipeline after source_text is identical for both.';

comment on column public.ingestion_runs.source_image_url is
  'The uploaded source image for an image-origin run, in packet-photos. EVIDENCE, not provenance: required while source_text is retained, and cleared by the same operation that clears source_text, so a purge leaves no database pointer to the source document. Never recipient-facing.';

-- ---------------------------------------------------------------------------
-- 2. DRIFT GUARD. Refuse to replace anything that is not what we read.
-- ---------------------------------------------------------------------------
do $guard$
declare v_def text; v_clause text; v_src text;
begin
  -- EVERY CLAUSE WE INTEND TO PRESERVE, named. A CREATE OR REPLACE pulled from
  -- a migration file silently reverts drift, so each function is checked
  -- against the shape this migration was written against before it is touched.
  --
  -- TWO CHECKS, and the first is exact. pg_proc.prosrc stores the function BODY
  -- verbatim — not normalised the way pg_get_functiondef reconstructs a header —
  -- so its md5 is a byte-exact fingerprint, and these two values were computed
  -- from the 0028 file and confirmed against Postgres itself. A body that has
  -- drifted by one character, in either direction including an ADDITION, fails
  -- here. The clause list below then says WHICH part is missing, because
  -- 'the hash differs' is true and useless.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'library_close_import_run';
  if v_def is null then raise exception '0045 guard: library_close_import_run does not exist'; end if;
  if position('source_image_url' in v_def) > 0 then
    raise exception '0045 guard: library_close_import_run already references source_image_url';
  end if;
  select md5(p.prosrc) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'library_close_import_run';
  if v_src <> 'ba88545bd60fce56b73b484594b1886d' then
    raise exception '0045 guard: library_close_import_run body is % , not the 0028 body ba88545bd60fce56b73b484594b1886d this migration edits', v_src;
  end if;
  foreach v_clause in array array[
    'set status = p_status, source_text = null, derived_title',
    'derived_client_name = '''', error = '''', evidence_purge_after = null, updated_at = now()',
    'evidence_purge_after = now() + interval',
    'delete from public.library_import_proposals where run_id = p_run_id',
    'droppedProposals',
    'reused',
    'result = null, segment_text = null, section_hint = '''', error = '''', fact_ledger = null, review_units = null',
    'library: run % is not a library import',
    'library: close status must be finalized or discarded'
  ] loop
    if position(v_clause in v_def) = 0 then
      raise exception '0045 guard: library_close_import_run has drifted - missing clause: %', v_clause;
    end if;
  end loop;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purge_ingestion_evidence';
  if v_def is null then raise exception '0045 guard: purge_ingestion_evidence does not exist'; end if;
  if position('source_image_url' in v_def) > 0 then
    raise exception '0045 guard: purge_ingestion_evidence already references source_image_url';
  end if;
  select md5(p.prosrc) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purge_ingestion_evidence';
  if v_src <> 'ed227053d9ab686776226b4f37fd9188' then
    raise exception '0045 guard: purge_ingestion_evidence body is % , not the 0028 body ed227053d9ab686776226b4f37fd9188 this migration edits', v_src;
  end if;
  foreach v_clause in array array[
    'set source_text = null, error = '''', evidence_purge_after = null, updated_at = now()',
    'delete from public.ingestion_runs r',
    'r.packet_deleted_at is not null',
    'public.library_items li where li.origin_run_id = r.id',
    'result = null, segment_text = null, section_hint = '''', error = '''', fact_ledger = null, review_units = null',
    'return v_runs + v_orphans'
  ] loop
    if position(v_clause in v_def) = 0 then
      raise exception '0045 guard: purge_ingestion_evidence has drifted - missing clause: %', v_clause;
    end if;
  end loop;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 3. The two clearers, re-issued: their 0028 definitions plus one assignment.
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
       set status = p_status, source_text = null, source_image_url = null, derived_title = '',
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
     set source_text = null, source_image_url = null, error = '', evidence_purge_after = null, updated_at = now()
   where r.evidence_purge_after is not null and r.evidence_purge_after <= now();
  get diagnostics v_runs = row_count;

  -- Both kinds of work, so a scheduled run reports what it actually did.
  return v_runs + v_orphans;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof — that the CHECK refuses the incoherent rows, and that a
--    purge really nulls both fields — is deliberately outside this transaction,
--    as 0020 established, so its rollbacks cannot be confused with this one's.
-- ---------------------------------------------------------------------------
do $verify$
declare v int; v_def text; v_name text;
begin
  select count(*) into v from public.ingestion_runs
   where source_origin <> 'text' or source_image_url is not null;
  if v <> 0 then
    raise exception '0045 verify: % existing run(s) are not coherent text runs', v;
  end if;

  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='source_origin' and is_nullable='NO' and column_default like '%text%';
  if v <> 1 then raise exception '0045 verify: source_origin is not NOT NULL defaulting to text'; end if;

  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='source_image_url' and is_nullable='YES';
  if v <> 1 then raise exception '0045 verify: source_image_url is not nullable'; end if;

  foreach v_name in array array['ingestion_runs_source_origin_check',
                                'ingestion_runs_source_image_coherent'] loop
    select pg_get_constraintdef(oid) into v_def from pg_constraint
     where conrelid='public.ingestion_runs'::regclass and conname=v_name;
    if v_def is null then raise exception '0045 verify: constraint % is missing', v_name; end if;
  end loop;

  -- THE CLEARED STATE MUST BE REPRESENTABLE. A coherence rule that ignores
  -- source_text would make every purge of an image run fail — the exact bug
  -- this revision exists to avoid.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.ingestion_runs'::regclass
     and conname='ingestion_runs_source_image_coherent';
  if position('source_text' in v_def) = 0 then
    raise exception '0045 verify: the coherence CHECK ignores source_text, so a purged image run is unrepresentable: %', v_def;
  end if;
  -- IT MUST BE AN EQUALITY. An implication permits the stale pointer: evidence
  -- cleared, picture still referenced. Checked on the definition because the
  -- two spellings differ by one word and mean different things.
  if position('IS NULL) = (' in upper(v_def)) = 0 and position('IS NULL) = ((' in upper(v_def)) = 0 then
    raise exception '0045 verify: the image branch is not an equality of the two null-states: %', v_def;
  end if;

  -- both clearers now clear the image evidence
  foreach v_name in array array['library_close_import_run','purge_ingestion_evidence'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname=v_name;
    if v_def is null then raise exception '0045 verify: % is missing', v_name; end if;
    if position('source_image_url = null' in v_def) = 0 then
      raise exception '0045 verify: % does not clear source_image_url', v_name;
    end if;
  end loop;

  -- and everything they did before, they still do
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='library_close_import_run';
  if position('evidence_purge_after = now() + interval' in v_def) = 0 then
    raise exception '0045 verify: library_close_import_run lost its finalize retention branch';
  end if;
  if position('delete from public.library_import_proposals' in v_def) = 0 then
    raise exception '0045 verify: library_close_import_run lost its proposal cleanup';
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='purge_ingestion_evidence';
  if position('packet_deleted_at is not null' in v_def) = 0 then
    raise exception '0045 verify: purge_ingestion_evidence lost its orphan delete';
  end if;
  if position('library_items li where li.origin_run_id' in v_def) = 0 then
    raise exception '0045 verify: purge_ingestion_evidence lost its Library provenance guard';
  end if;
  if position('review_units = null' in v_def) = 0 then
    raise exception '0045 verify: purge_ingestion_evidence lost the 0028 chunk clearing';
  end if;

  raise notice '0045 verify: OK';
end
$verify$;

commit;
