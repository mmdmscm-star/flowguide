-- 0046 — the creator says whether the source is ONE thing or MANY.
--
-- WHY. A photographed pricing sheet — one community, many apartment rows —
-- produced twenty-six review cards from a single misunderstanding. Nothing in
-- the prompt says what "one item" is, so the model chose one item per row; the
-- deterministic side independently tiled the same table into one record per
-- row; and every proposal then failed to bind, because bindByProvenance needs
-- an anchor and anchorsOf recognises only emails, URLs and phone numbers. A
-- pricing table contains none of those. Twenty-six cards were not twenty-six
-- problems. They were one disagreement about scope, reported once per row.
--
-- MEASURED, on a fixture of that shape, through the real enforcement:
--
--   auto, 6 rows, 6 proposals            6 cards, 0 details survive
--   one item, source still tiles         1 card,  0 details survive
--   one item, source treated as 1 record 0 cards, 6 details survive
--
-- The middle row is why a prompt change alone would have been a trap: it looks
-- like a fix and still withholds every fact.
--
-- WHAT THIS IS NOT. It does not preserve record-level binding for sources like
-- this — that binding does not exist for them today and this migration does not
-- pretend otherwise. It changes ONE thing: how many records the source is taken
-- to contain, which is a fact the detector was previously guessing at and the
-- creator actually knows.
--
-- AND IT IS OFF BY DEFAULT. `auto` is the existing behaviour, exactly: every
-- row already in this table takes it, every current paste and file path keeps
-- it, and no guard changes for any of them. The other two states are reachable
-- only by a creator explicitly saying so on screen.
--
-- TWO COLUMNS, because they are two different facts:
--
--   grouping_intent  what the creator said the source IS.
--   grouping_title   what they called the single item, when they said "one".
--
-- THE TITLE NEEDS ITS OWN COLUMN. derived_title is the model-derived PACKET
-- title, written from the model's own output and cleared as evidence — the
-- wrong meaning and the wrong lifetime. Overloading it would make a creator's
-- own words disappear at the first purge and collide with a value the pipeline
-- already writes.
--
-- NEITHER IS EVIDENCE. Both follow delimiter_hint (0031): a fact the
-- professional supplied about their own source, held for the life of the run
-- and untouched by every clearer. So no clearing function is re-issued here,
-- and the verification below asserts that none writes them — because a future
-- clearer that nulled grouping_title without also changing grouping_intent
-- would turn a routine purge into a hard constraint failure. That is the 0045
-- lesson, applied one migration later.

begin;

-- ---------------------------------------------------------------------------
-- 1. What the creator said the source is.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists grouping_intent text not null default 'auto';

-- THREE STATES, and 'auto' is not a synonym for 'split'. Today's behaviour is
-- inferred rather than chosen: the detector tiles when it can and declines when
-- it cannot. 'split' is a creator asserting many records, which is a different
-- claim from nobody having been asked — and a later change to what automatic
-- detection does must not silently rewrite what a creator once said.
alter table public.ingestion_runs
  add constraint ingestion_runs_grouping_intent_check
    check (grouping_intent in ('auto','keep_together','split'));

-- ---------------------------------------------------------------------------
-- 2. What they called it, when they said it was one thing.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists grouping_title text;

-- The pair cannot disagree. A keep_together run with no name would produce an
-- untitled item, which cannot be published; a name on a run that is not being
-- kept together names nothing. Blank is treated as absent, because a title of
-- spaces is an untitled item wearing a value.
alter table public.ingestion_runs
  add constraint ingestion_runs_grouping_title_coherent
    check (
      (grouping_intent = 'keep_together'
         and grouping_title is not null and btrim(grouping_title) <> '')
      or
      (grouping_intent in ('auto','split') and grouping_title is null)
    );

comment on column public.ingestion_runs.grouping_intent is
  'What the professional said this source IS: ''auto'' (nobody asked - automatic record detection, the historical behaviour), ''keep_together'' (one creator-declared record), or ''split'' (many). Read only by record attribution, never by segmentation. Not evidence: creator-supplied, and never cleared by a purge.';

comment on column public.ingestion_runs.grouping_title is
  'The professional''s own name for the single item, present exactly when grouping_intent=''keep_together''. Creator-authored, NOT the model-derived derived_title and not on its evidence lifecycle.';

-- ---------------------------------------------------------------------------
-- 3. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof — that the CHECKs refuse the incoherent rows — is
--    deliberately outside this transaction, as 0020 established.
-- ---------------------------------------------------------------------------
do $verify$
declare v int; v_def text; v_name text;
begin
  -- every pre-existing run is untouched: automatic, unnamed
  select count(*) into v from public.ingestion_runs
   where grouping_intent <> 'auto' or grouping_title is not null;
  if v <> 0 then
    raise exception '0046 verify: % existing run(s) did not stay on automatic grouping', v;
  end if;

  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='grouping_intent' and is_nullable='NO'
     and column_default like '%auto%';
  if v <> 1 then raise exception '0046 verify: grouping_intent is not NOT NULL defaulting to auto'; end if;

  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='grouping_title' and is_nullable='YES';
  if v <> 1 then raise exception '0046 verify: grouping_title is not nullable'; end if;

  foreach v_name in array array['ingestion_runs_grouping_intent_check',
                                'ingestion_runs_grouping_title_coherent'] loop
    select pg_get_constraintdef(oid) into v_def from pg_constraint
     where conrelid='public.ingestion_runs'::regclass and conname=v_name;
    if v_def is null then raise exception '0046 verify: constraint % is missing', v_name; end if;
  end loop;

  -- all three states, named. A CHECK that forgot one would make it
  -- unreachable, and the failure would look like an application bug.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.ingestion_runs'::regclass
     and conname='ingestion_runs_grouping_intent_check';
  foreach v_name in array array['auto','keep_together','split'] loop
    if position(v_name in v_def) = 0 then
      raise exception '0046 verify: the intent CHECK does not allow %: %', v_name, v_def;
    end if;
  end loop;

  -- the title rule must actually require a name, not merely mention the column
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid='public.ingestion_runs'::regclass
     and conname='ingestion_runs_grouping_title_coherent';
  if position('btrim' in lower(v_def)) = 0 then
    raise exception '0046 verify: the title rule accepts a blank name: %', v_def;
  end if;

  -- NOTHING THAT CLEARS EVIDENCE MAY WRITE EITHER COLUMN. These are creator
  -- facts, not source content. A clearer that nulled grouping_title without
  -- also changing grouping_intent would make every purge of a keep_together run
  -- fail the coherence CHECK.
  select count(*) into v from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('finalize_ingestion_run','discard_ingestion_run',
                       'library_close_import_run','purge_ingestion_evidence')
     and (pg_get_functiondef(p.oid) ilike '%grouping_intent%'
       or pg_get_functiondef(p.oid) ilike '%grouping_title%');
  if v <> 0 then
    raise exception '0046 verify: % evidence-clearing function(s) write the grouping columns', v;
  end if;

  raise notice '0046 verify: OK';
end
$verify$;

commit;
