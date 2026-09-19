-- ============================================================================
-- 0060 — A RUN REMEMBERS WHICH DOCUMENTS ITS SOURCE CAME FROM, PAGE BY PAGE,
--        FOR EXACTLY AS LONG AS IT REMEMBERS THE SOURCE.
--
-- WHY. A professional can now drop a PDF on New Sendset. It is read in their
-- browser, its text lands in the same box a paste does, and the file itself is
-- never uploaded or stored. What organize receives is text, so nothing
-- downstream changes.
--
-- What IS lost without this column is the ability to debug fidelity. If a
-- price in a finished Sendset looks wrong, the question is "what did the PDF
-- say, and where in the source did page 4 land?" — and without a record, the
-- answer is gone the moment the tab closes.
--
-- SO: ONE NULLABLE COLUMN, `source_documents`, a small manifest per document:
--
--   kind       'pdf' — the only kind in v1.
--   name       the file's name, as the browser reported it.
--   bytes      its size, as reported.
--   sha256     the file's SHA-256, as the browser computed and reported it.
--   pageCount  pages in the file, as reported.
--   extractor  which pdf.js and which layout rules the browser says read it.
--   pages[]    per page: its number, its character count, the SHA-256 of the
--              text it contributed, and WHERE that text sits in source_text
--              (start/end, in the same UTF-16 offsets the chunks use) — or
--              null/null when the professional edited that page's text before
--              organizing, because an offset into edited text would be a lie.
--
-- WHAT IS CLIENT-REPORTED AND WHAT IS VERIFIED BY THE SERVER. The PDF is read
-- in the browser and never reaches the server, so the server cannot attest to
-- anything about the file itself. name, bytes, sha256, pageCount and extractor
-- are CLIENT-REPORTED provenance: organize bounds and shape-checks them, and
-- stores them as reported. The file hash in particular does not prove which
-- file was read, or that the text came from it; it only lets someone who later
-- holds a file see whether it matches what the browser reported.
--
-- The page SPANS are different: organize re-hashes every span against the
-- exact source_text it received and refuses the request if one does not match
-- (src/lib/source-documents.ts). So a stored span is VERIFIED BY THE SERVER to
-- be the text reported for that page — a fact about source_text, not about the
-- PDF. This migration's CHECK enforces the shape of all of it; it cannot, and
-- does not, re-check the hashes.
--
-- ITS LIFETIME IS THE SOURCE'S. The manifest names a client's file and maps
-- into source_text, so it is EVIDENCE, and it goes when source_text goes —
-- through the 30-day purge, a library discard, or any path added later.
--
-- THAT IS A TRIGGER, NOT A RE-ISSUED FUNCTION. 0045 and 0048 had to replace the
-- clearing functions (drift-guarded) to clear image pointers. Here a BEFORE
-- UPDATE trigger nulls the manifest whenever source_text becomes null, on every
-- path at once, and a CHECK makes the stale state — a manifest pointing into a
-- source that no longer exists — unrepresentable if the trigger were ever
-- dropped. Nothing live is replaced.
--
-- NOT CHANGED: source_origin. It means "an AI transcription of an image
-- attested this text" (0045), and a PDF's own text layer is not that. A PDF
-- run stays origin 'text', with this manifest saying which document.
--
-- ROLLBACK: supabase/rollbacks/0060_ingestion_source_documents_down.sql.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ingestion_runs') is null then
    raise exception 'MIGRATION 0060 ABORTED: ingestion_runs does not exist.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ingestion_runs'
                and column_name = 'source_documents') then
    raise exception 'MIGRATION 0060 ABORTED: source_documents already exists.';
  end if;
  if to_regprocedure('public.ingestion_source_documents_valid(jsonb)') is not null
     or to_regprocedure('public.ingestion_clear_source_documents()') is not null then
    raise exception 'MIGRATION 0060 ABORTED: a 0060 function already exists.';
  end if;
  -- What this is written against: 0048's shape rule and 0059 before it.
  if to_regprocedure('public.ingestion_source_images_valid(jsonb)') is null
     or to_regprocedure('public.purge_ingestion_evidence()') is null then
    raise exception 'MIGRATION 0060 ABORTED: the evidence spine is not the one this was written against.';
  end if;
end $$;

-- THE PRE-STATE of every existing run, for the proof in section 4: this
-- migration must not change one. The WHOLE row, as jsonb, so no column can
-- change unseen (an earlier draft listed columns, and missed one). After the
-- column is added, the comparison removes it — the only difference the
-- migration is allowed to make.
create temp table zz0060_pre on commit drop as
select count(*) as n_runs,
       md5(coalesce(string_agg(md5((to_jsonb(r) - 'source_documents')::text), ',' order by r.id), '')) as digest
  from public.ingestion_runs r;

-- ---------------------------------------------------------------------------
-- 1. THE SHAPE.
--
-- A CHECK cannot hold the subqueries this needs, so it calls a function — the
-- 0048 pattern. EXECUTE stays available to every writer, because a CHECK is
-- evaluated as whoever is writing.
-- ---------------------------------------------------------------------------
create function public.ingestion_source_documents_valid(v jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $sdv$
declare
  d jsonb;
  p jsonb;
  n int;
  k int;
begin
  if v is null then return true; end if;
  if jsonb_typeof(v) <> 'array' then return false; end if;
  n := jsonb_array_length(v);
  if n < 1 or n > 20 then return false; end if;

  for d in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(d) <> 'object' then return false; end if;
    if d->>'kind' is distinct from 'pdf' then return false; end if;
    if jsonb_typeof(d->'name') <> 'string'
       or char_length(d->>'name') not between 1 and 255 then return false; end if;
    if jsonb_typeof(d->'bytes') <> 'number'
       or (d->>'bytes')::numeric <> floor((d->>'bytes')::numeric)
       or (d->>'bytes')::numeric not between 1 and 20971520 then return false; end if;
    if coalesce(d->>'sha256', '') !~ '^[0-9a-f]{64}$' then return false; end if;
    if jsonb_typeof(d->'pageCount') <> 'number'
       or (d->>'pageCount')::numeric <> floor((d->>'pageCount')::numeric)
       or (d->>'pageCount')::numeric not between 1 and 50 then return false; end if;
    if jsonb_typeof(d->'extractor') <> 'string'
       or char_length(d->>'extractor') not between 1 and 120 then return false; end if;

    -- One entry per page, in order: pages[i].page = i + 1.
    if jsonb_typeof(d->'pages') <> 'array'
       or jsonb_array_length(d->'pages') <> (d->>'pageCount')::int then return false; end if;
    k := 0;
    for p in select * from jsonb_array_elements(d->'pages') loop
      k := k + 1;
      if jsonb_typeof(p) <> 'object' then return false; end if;
      if jsonb_typeof(p->'page') <> 'number' or (p->>'page')::numeric <> k then return false; end if;
      if jsonb_typeof(p->'chars') <> 'number'
         or (p->>'chars')::numeric <> floor((p->>'chars')::numeric)
         or (p->>'chars')::numeric < 0 then return false; end if;
      if coalesce(p->>'sha256', '') !~ '^[0-9a-f]{64}$' then return false; end if;
      -- A span is both ends or neither, and a real range when present. A page
      -- that contributed no text has nowhere to point.
      if jsonb_typeof(p->'start') = 'null' and jsonb_typeof(p->'end') = 'null' then
        continue;
      end if;
      if jsonb_typeof(p->'start') <> 'number' or jsonb_typeof(p->'end') <> 'number' then return false; end if;
      if (p->>'start')::numeric <> floor((p->>'start')::numeric)
         or (p->>'end')::numeric <> floor((p->>'end')::numeric) then return false; end if;
      if (p->>'start')::numeric < 0 or (p->>'end')::numeric <= (p->>'start')::numeric then return false; end if;
      if (p->>'chars')::numeric = 0 then return false; end if;
      -- The span covers exactly the page's text.
      if (p->>'end')::numeric - (p->>'start')::numeric <> (p->>'chars')::numeric then return false; end if;
    end loop;
  end loop;
  return true;
end;
$sdv$;

comment on function public.ingestion_source_documents_valid(jsonb) is
  'True when the value is null or a well-formed source-document manifest (0060) — SHAPE only; it verifies no hash: 1-20 documents, each a PDF with a reported name, size, SHA-256, page count, extractor, and one entry per page carrying its character count, the SHA-256 of its text, and a span into source_text that is either absent or exactly as long as that text.';

-- ---------------------------------------------------------------------------
-- 2. THE COLUMN AND ITS RULES.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs add column source_documents jsonb;

alter table public.ingestion_runs
  add constraint ingestion_runs_source_documents_shape
    check (public.ingestion_source_documents_valid(source_documents)),
  -- EVIDENCE OUTLIVES NOTHING: no manifest without the source it maps into.
  add constraint ingestion_runs_source_documents_with_source
    check (source_documents is null or source_text is not null);

comment on column public.ingestion_runs.source_documents is
  'Which documents this run''s source text came from, page by page (0060). Document fields (name, bytes, sha256, pageCount, extractor) are CLIENT-REPORTED, not server-attested: the PDF is read in the browser and never stored. Page spans were verified by organize against source_text before the row was written. EVIDENCE: names a client''s file and maps into source_text, so it is cleared whenever source_text is — by trigger, on every path.';

-- ---------------------------------------------------------------------------
-- 3. THE SHARED LIFETIME, ON EVERY PATH.
--
-- Whatever clears source_text clears this in the same statement: the 30-day
-- purge, a library discard, anything added later. BEFORE, so the CHECK above
-- sees the row already consistent.
--
-- ONLY WHEN THIS STATEMENT IS THE ONE CLEARING IT. A write that tries to attach
-- a manifest to a run whose source is ALREADY gone is a bug in the writer, and
-- it is refused by the CHECK — not quietly discarded by this trigger, which
-- would let the writer believe the manifest had been kept.
-- ---------------------------------------------------------------------------
create function public.ingestion_clear_source_documents()
returns trigger
language plpgsql
set search_path = ''
as $csd$
begin
  if new.source_text is null then
    new.source_documents := null;
  end if;
  return new;
end;
$csd$;

create trigger trg_ingestion_clear_source_documents
  before update on public.ingestion_runs
  for each row
  when (old.source_text is not null and new.source_text is null and new.source_documents is not null)
  execute function public.ingestion_clear_source_documents();

-- A trigger function is not callable as a function; nobody needs EXECUTE on it
-- beyond the table's own writes.
revoke all on function public.ingestion_clear_source_documents() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. PROOF, IN THIS TRANSACTION.
-- ---------------------------------------------------------------------------
do $$
declare
  pre record;
  n bigint; d text;
  u uuid; pk uuid; pk2 uuid; r uuid;
  ok boolean;
  h text := repeat('ab', 32);
  good jsonb;
  bad jsonb;
begin
  -- ---- NO EXISTING RUN MOVED ------------------------------------------------
  select * into pre from zz0060_pre;
  select count(*),
         md5(coalesce(string_agg(md5((to_jsonb(x) - 'source_documents')::text), ',' order by x.id), ''))
    into n, d
    from public.ingestion_runs x;
  if n <> pre.n_runs or d <> pre.digest then
    raise exception '0060 PROOF: an existing run changed';
  end if;
  if exists (select 1 from public.ingestion_runs where source_documents is not null) then
    raise exception '0060 PROOF: an existing run acquired a manifest';
  end if;

  -- ---- A FIXTURE RUN --------------------------------------------------------
  insert into public.users (email) values ('0060-proof@example.invalid') returning id into u;
  insert into public.packets (user_id, slug, title) values (u, '0060-proof-slug', 'proof') returning id into pk;
  insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version)
  values (u, pk, 'organize', 'Harbor House	$2,400', 'x', 19, 'seg-proof') returning id into r;

  good := jsonb_build_array(jsonb_build_object(
    'kind', 'pdf', 'name', 'prices.pdf', 'bytes', 1016, 'sha256', h, 'pageCount', 2,
    'extractor', 'pdfjs-dist@6.3.289+sendset-pdf-layout@1',
    'pages', jsonb_build_array(
      jsonb_build_object('page', 1, 'chars', 19, 'sha256', h, 'start', 0, 'end', 19),
      jsonb_build_object('page', 2, 'chars', 0, 'sha256', h, 'start', null, 'end', null))));
  update public.ingestion_runs set source_documents = good where id = r;

  -- ---- EVERY WRONG SHAPE IS REFUSED -----------------------------------------
  foreach bad in array array[
    '{}'::jsonb,                                                    -- not an array
    '[]'::jsonb,                                                    -- no documents
    jsonb_set(good, '{0,kind}', '"docx"'),                           -- not a pdf
    jsonb_set(good, '{0,sha256}', '"not-a-hash"'),                   -- bad file hash
    jsonb_set(good, '{0,pageCount}', '3'),                           -- pages do not match the count
    jsonb_set(good, '{0,pageCount}', '51'),                          -- over the page limit
    jsonb_set(good, '{0,bytes}', '20971521'),                        -- over the size limit
    jsonb_set(good, '{0,name}', '""'),                               -- no name
    jsonb_set(good, '{0,pages,0,page}', '2'),                        -- pages out of order
    jsonb_set(good, '{0,pages,0,end}', '0'),                         -- empty span
    jsonb_set(good, '{0,pages,0,end}', '18'),                        -- span shorter than its text
    jsonb_set(good, '{0,pages,0,start}', 'null'),                    -- half a span
    jsonb_set(good, '{0,pages,1,start}', '19'),                      -- a blank page pointing somewhere
    jsonb_set(good, '{0,pages,0,sha256}', '"xyz"')                   -- bad page hash
  ] loop
    ok := false;
    begin
      update public.ingestion_runs set source_documents = bad where id = r;
    exception when check_violation then ok := true; end;
    if not ok then raise exception '0060 PROOF: a malformed manifest was accepted: %', bad; end if;
  end loop;

  -- ---- NO MANIFEST WITHOUT ITS SOURCE ---------------------------------------
  -- On its own packet: one active organize run per packet is a unique rule,
  -- and this must be refused for its shape, not by that.
  insert into public.packets (user_id, slug, title) values (u, '0060-proof-slug-2', 'proof') returning id into pk2;
  ok := false;
  begin
    insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version, source_documents)
    values (u, pk2, 'organize', null, 'x', 0, 'seg-proof', good);
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0060 PROOF: a manifest was stored without a source'; end if;
  delete from public.ingestion_runs where packet_id = pk2;

  -- And a manifest cannot be attached AFTER the source is gone: refused, not
  -- silently dropped.
  insert into public.ingestion_runs (user_id, packet_id, entry_point, source_text, source_hash, source_len, segmenter_version)
  values (u, pk2, 'organize', null, 'x', 0, 'seg-proof');
  ok := false;
  begin
    update public.ingestion_runs set source_documents = good where packet_id = pk2;
  exception when check_violation then ok := true; end;
  if not ok then raise exception '0060 PROOF: a manifest was attached to a run with no source'; end if;
  delete from public.ingestion_runs where packet_id = pk2;

  -- ---- CLEARING THE SOURCE CLEARS THE MANIFEST ------------------------------
  update public.ingestion_runs set source_text = null where id = r;
  if (select source_documents from public.ingestion_runs where id = r) is not null then
    raise exception '0060 PROOF: the manifest outlived its source';
  end if;

  -- ---- AND THE REAL PURGE, AS SCHEDULED, DOES IT TOO ------------------------
  update public.ingestion_runs set source_text = 'Harbor House	$2,400', source_documents = good,
         evidence_purge_after = now() - interval '1 minute' where id = r;
  perform public.purge_ingestion_evidence();
  if (select source_documents from public.ingestion_runs where id = r) is not null
     or (select source_text from public.ingestion_runs where id = r) is not null then
    raise exception '0060 PROOF: the scheduled purge left a manifest behind';
  end if;

  -- ---- GRANTS UNCHANGED -----------------------------------------------------
  select count(*) into n from information_schema.role_routine_grants
   where specific_schema = 'public' and routine_name = 'ingestion_clear_source_documents'
     and grantee in ('PUBLIC', 'anon', 'authenticated');
  if n > 0 then raise exception '0060 PROOF: the trigger function is callable by an unprivileged role'; end if;

  -- ---- NOTHING LEFT BEHIND --------------------------------------------------
  delete from public.ingestion_runs where id = r;
  delete from public.packets where id in (pk, pk2);
  delete from public.users where id = u;
  if exists (select 1 from public.users where email = '0060-proof@example.invalid') then
    raise exception '0060 PROOF: the fixture survived';
  end if;
end $$;

commit;
