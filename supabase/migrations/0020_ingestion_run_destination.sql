-- 0020 — ingestion runs gain an explicit DESTINATION.
--
-- WHY. The claim/lease/stage/split engine (claim_chunk, stage_chunk_result,
-- mark_chunk_failed, split_chunk) touches no packet table and authorizes purely
-- on ingestion_runs.user_id. It is already destination-agnostic. The packet
-- coupling lives only in the endpoints — create, finalize, discard — and in this
-- table's own NOT NULL. Widening the row lets a Library import reuse that engine
-- instead of maintaining a second copy of a lease protocol forever.
--
-- SCOPE. SCHEMA ONLY. This migration deliberately does NOT modify
-- finalize_ingestion_run or discard_ingestion_run. Their destination guards land
-- in 0021, alongside the RPCs that make a library run creatable in the first
-- place. Until then no library run can exist except by manual insert, and
-- finalize already fails closed on one: `select ... from packets where id = null`
-- returns no row and it raises 'ingestion: packet not found'. Re-issuing a
-- 167-line function to add four lines is a risk worth taking only when it buys
-- something, and here it would buy nothing.
--
-- BEHAVIOUR FOR EXISTING PACKET RUNS IS UNCHANGED. Every existing row takes
-- destination='packet' from the default, and the coherence CHECK makes the old
-- NOT NULL true by construction for every packet run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The discriminator.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  add column if not exists destination text not null default 'packet';

alter table public.ingestion_runs
  add constraint ingestion_runs_destination_check
    check (destination in ('packet','library'));

-- ---------------------------------------------------------------------------
-- 2. packet_id becomes nullable — and the old guarantee is restored exactly.
--
--    NOT a weakening: a packet run without a packet, and a library run WITH
--    one, are both unrepresentable after this.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs alter column packet_id drop not null;

alter table public.ingestion_runs
  add constraint ingestion_runs_destination_coherent
    check ((destination = 'packet') = (packet_id is not null));

-- ---------------------------------------------------------------------------
-- 3. entry_point gains 'library_import', and is tied to the destination.
--
--    The existing constraint is found by DEFINITION rather than by a guessed
--    auto-generated name.
-- ---------------------------------------------------------------------------
do $ep$
declare v_name text;
begin
  select conname into v_name from pg_constraint
   where conrelid = 'public.ingestion_runs'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%entry_point%';
  if v_name is null then
    raise exception '0020: could not find the entry_point check constraint';
  end if;
  execute format('alter table public.ingestion_runs drop constraint %I', v_name);
end
$ep$;

alter table public.ingestion_runs
  add constraint ingestion_runs_entry_point_check
    check (entry_point in ('organize','append','section_append','library_import'));

alter table public.ingestion_runs
  add constraint ingestion_runs_library_entry_point
    check ((destination = 'library') = (entry_point = 'library_import'));

-- ---------------------------------------------------------------------------
-- 4. ONE ACTIVE RUN — stated separately per destination.
--
--    A unique index on packet_id would constrain NOTHING for library runs:
--    Postgres treats NULLs as distinct, so every library row would be trivially
--    unique. Library runs are therefore keyed on user_id, and each index carries
--    an explicit destination predicate so neither rule depends on NULL semantics.
--
--    The packet predicate keeps ALL THREE statuses. 0013 added needs_review
--    because it is non-terminal; recreating this index without it would silently
--    let a second Organize start on a packet awaiting review.
-- ---------------------------------------------------------------------------
drop index if exists public.idx_ingestion_runs_one_active;

create unique index idx_ingestion_runs_one_active_packet
  on public.ingestion_runs(packet_id)
  where destination = 'packet' and status in ('active','finalizing','needs_review');

-- One non-terminal import per PROFESSIONAL. An import owns the review layer, and
-- two at once would put a professional in two review sittings with no way to
-- tell which proposals came from which paste.
create unique index idx_ingestion_runs_one_active_library
  on public.ingestion_runs(user_id)
  where destination = 'library' and status in ('active','finalizing','needs_review');

comment on column public.ingestion_runs.destination is
  'Where this run applies: a packet (the original path) or the Library. Library runs carry no packet_id and never enter packet finalization.';

-- ---------------------------------------------------------------------------
-- 5. Structural verification. Anything wrong rolls the whole migration back.
--    Behavioural proof (attempted inserts) is Step 3, deliberately outside this
--    transaction so its rollbacks cannot be confused with this one's.
-- ---------------------------------------------------------------------------
do $verify$
declare v int; v_def text;
begin
  -- every pre-existing row is a packet run with a packet
  select count(*) into v from public.ingestion_runs
   where destination <> 'packet' or packet_id is null;
  if v <> 0 then raise exception '0020 verify: % existing run(s) are not coherent packet runs', v; end if;

  -- packet_id really is nullable now
  select count(*) into v from information_schema.columns
   where table_schema='public' and table_name='ingestion_runs'
     and column_name='packet_id' and is_nullable='YES';
  if v <> 1 then raise exception '0020 verify: packet_id did not become nullable'; end if;

  -- all four constraints present
  foreach v_def in array array['ingestion_runs_destination_check',
                               'ingestion_runs_destination_coherent',
                               'ingestion_runs_entry_point_check',
                               'ingestion_runs_library_entry_point'] loop
    if not exists (select 1 from pg_constraint
                    where conrelid='public.ingestion_runs'::regclass and conname=v_def) then
      raise exception '0020 verify: constraint % is missing', v_def;
    end if;
  end loop;

  -- the old index is gone and both replacements exist
  if exists (select 1 from pg_indexes where schemaname='public'
              and indexname='idx_ingestion_runs_one_active') then
    raise exception '0020 verify: the old one-active index still exists';
  end if;

  -- the packet predicate must still carry needs_review; asserted on the
  -- PREDICATE, never on the index name
  select indexdef into v_def from pg_indexes
   where schemaname='public' and indexname='idx_ingestion_runs_one_active_packet';
  if v_def is null then raise exception '0020 verify: packet one-active index missing'; end if;
  if v_def not ilike '%needs_review%' then
    raise exception '0020 verify: packet one-active index lost needs_review — this is the 0013 regression';
  end if;
  if v_def not ilike '%destination%' then
    raise exception '0020 verify: packet one-active index has no destination predicate';
  end if;

  select indexdef into v_def from pg_indexes
   where schemaname='public' and indexname='idx_ingestion_runs_one_active_library';
  if v_def is null then raise exception '0020 verify: library one-active index missing'; end if;
  if v_def not ilike '%user_id%' then
    raise exception '0020 verify: library one-active index is not keyed on user_id';
  end if;
  if v_def not ilike '%needs_review%' then
    raise exception '0020 verify: library one-active index lost needs_review';
  end if;

  raise notice '0020 verify: OK';
end
$verify$;

commit;
