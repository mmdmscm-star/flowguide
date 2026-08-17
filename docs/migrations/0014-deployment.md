# Migration 0014 — deployment runbook

Applied **by hand** in the Supabase SQL Editor. Nothing in CI applies it.

File: `supabase/migrations/0014_item_ingestion_provenance.sql`

It adds `items.origin_run_id / origin_chunk_ordinal / origin_emit_index`,
`ingestion_runs.source_offset_base`, a `utf16_length()` helper, and replaces
`finalize_ingestion_run` so new items record their provenance transactionally.
**Nothing is backfilled.** NULL means "provenance unavailable" and recomputation
must decline rather than infer.

---

## 0. Blocking problems

None outstanding. Six issues found in review were fixed in the SQL before this
runbook was written: missing `lock_timeout`; a lock-upgrade deadlock window
(fixed by altering `ingestion_runs` *before* `items`); `utf16_length` exposed to
`anon` via PostgREST (revoked); no schema-cache reload (`notify pgrst`); the
`--- Added ---` delimiter duplicated in four places where a future edit could
silently desynchronise the measured and concatenated copies (now one
`v_delim` constant); and a missing `origin_emit_index` — see §5.

---

## 1. Preflight

Run these **before** applying. Each says what result means "safe to proceed".

```sql
-- (a) Nothing is mid-flight. This is the one genuinely risky moment: applying
--     while a run is finalizing can deadlock or abort it.
--     SAFE = zero rows.
select id, packet_id, status, created_at
from public.ingestion_runs
where status in ('active','finalizing','needs_review');

-- (b) The migration has not already been applied.
--     SAFE = zero rows.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (   (table_name = 'items'          and column_name in ('origin_run_id','origin_chunk_ordinal','origin_emit_index'))
       or (table_name = 'ingestion_runs' and column_name = 'source_offset_base'));

-- (c) The live finalize_ingestion_run is unmodified 0012 — no hand edits that
--     this migration would blindly overwrite.
--     SAFE = 40b2108ccbaa187e8712ef7ece21a4f1
select md5(prosrc) as live_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'finalize_ingestion_run';

-- (d) Server encoding must be UTF8 — utf16_length identifies non-BMP characters
--     by their 4-byte UTF-8 encoding.
--     SAFE = UTF8
show server_encoding;

-- (e) Baseline counts, to prove afterwards that nothing was backfilled or lost.
select (select count(*) from public.items)          as items,
       (select count(*) from public.sections)       as sections,
       (select count(*) from public.ingestion_runs) as runs;
```

If (c) returns anything else, **stop** and diff the live body against
`0012_ingestion_runs.sql` lines 527-687 before going further.

---

## 2. Impact

**Locks.** `alter table ... add column` with a nullable column and no default is
metadata-only in Postgres 11+ — no table rewrite, so the work is microseconds.
The exposure is the `ACCESS EXCLUSIVE` lock itself, which conflicts with
`ACCESS SHARE` and therefore blocks *reads* of `items` (the recipient renderer,
the editor, finalize's own media-ledger query) while held. `set local
lock_timeout = '3s'` means a contended run aborts and rolls back cleanly instead
of stalling the app; just run it again. The whole script is one transaction.

**In-flight runs.** Preflight (a) is what protects this. `create or replace
function` does not affect a call already executing; a call that starts after the
commit gets the new body. There is no state where one run half-applies.

**Applied, code NOT yet deployed** — safe. New columns stay NULL only if the old
`finalize` runs, but `finalize` is *in* the migration, so imports after applying
record provenance immediately. Nothing reads it yet.

**Code deployed, migration NOT applied** — also safe, provided the deployed code
only *reads* the columns defensively. Do not deploy code that writes them.

**Order: apply the migration first, then deploy.**

**Idempotent.** Every statement is `if not exists` / `or replace`. Re-running is
a no-op apart from re-running the `$verify$` self-check.

---

## 3. Rollback

```sql
begin;
set local lock_timeout = '3s';

drop trigger if exists trg_ingest_invalidate_offsets on public.packets;
drop function if exists public.ingest_invalidate_offsets();

drop index if exists public.items_origin_run_idx;

alter table public.items
  drop column if exists origin_emit_index,
  drop column if exists origin_chunk_ordinal,
  drop column if exists origin_run_id;

alter table public.ingestion_runs
  drop column if exists source_offset_base;

drop function if exists public.utf16_length(text);

commit;
notify pgrst, 'reload schema';
```

**Then restore the original `finalize_ingestion_run`** by pasting
`supabase/migrations/0012_ingestion_runs.sql` lines **527-687** (the whole
`create or replace function public.finalize_ingestion_run ... $$;` block) and
running it. Confirm with the §1(c) query that `live_md5` is back to
`40b2108ccbaa187e8712ef7ece21a4f1`.

**What cannot be recovered:** dropping the columns discards the provenance
recorded by any import that ran while 0014 was live. It cannot be reconstructed
afterwards — that is the whole point of the migration. Re-applying 0014 later
starts collecting again from that moment, and those older items stay NULL
forever, which is the honest state.

Nothing else is destructive: no data is rewritten, no constraint is added to
existing rows, and `raw_input` is untouched.

---

## 4. Verification

```sql
-- (a) Columns exist, all nullable, correct types.
--     EXPECT 4 rows, is_nullable = YES for every one.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and (   (table_name = 'items'          and column_name like 'origin_%')
       or (table_name = 'ingestion_runs' and column_name = 'source_offset_base'))
order by table_name, column_name;

-- (b) The partial index exists.
--     EXPECT 1 row.
select indexname, indexdef from pg_indexes
where schemaname = 'public' and indexname = 'items_origin_run_idx';

-- (c) utf16_length matches JavaScript String.length exactly.
--     EXPECT 3, 4, 1, 2, 4, 0, 0  — and all_correct = true.
select public.utf16_length('abc')     as ascii,      -- 3
       public.utf16_length('café')    as accented,   -- 4
       public.utf16_length('漢')       as cjk,        -- 1
       public.utf16_length('😀')       as non_bmp,    -- 2  (surrogate PAIR)
       public.utf16_length('😀漢a')    as mixed,      -- 4
       public.utf16_length('')        as empty,      -- 0
       public.utf16_length(null)      as null_in,    -- 0
       (public.utf16_length('abc')=3 and public.utf16_length('café')=4
        and public.utf16_length('漢')=1 and public.utf16_length('😀')=2
        and public.utf16_length('😀漢a')=4) as all_correct;

-- (d) utf16_length is NOT reachable from the API roles.
--     EXPECT false, false.
select has_function_privilege('anon',          'public.utf16_length(text)', 'execute') as anon_can,
       has_function_privilege('authenticated', 'public.utf16_length(text)', 'execute') as auth_can;

-- (e) finalize was replaced with the provenance-writing body.
--     EXPECT 81633731dcd07ca3fd2fdc3690bbeba4, and writes_provenance = true.
select md5(prosrc) as live_md5,
       (prosrc like '%origin_run_id, origin_chunk_ordinal, origin_emit_index%') as writes_provenance,
       (prosrc like '%source_offset_base = v_offset_base%')                     as writes_base
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'finalize_ingestion_run';

-- (f) NOTHING was backfilled. Every pre-existing row must still be NULL, and
--     the counts must match preflight (e) exactly.
--     EXPECT with_provenance = 0, runs_with_base = 0.
select (select count(*) from public.items)                                        as items_total,
       (select count(*) from public.items where origin_run_id is not null)        as with_provenance,
       (select count(*) from public.ingestion_runs)                               as runs_total,
       (select count(*) from public.ingestion_runs
          where source_offset_base is not null)                                   as runs_with_base;


-- (g) The offset-invalidation trigger exists and BEHAVES. This one is worth
--     proving rather than assuming, because it is what makes NULL mean
--     "unavailable" instead of "we hope nobody replaced the source".
--     EXPECT 1 row from the first query; append_kept = true, replace_voided = true.
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.packets'::regclass and tgname = 'trg_ingest_invalidate_offsets';

do $probe$
declare v_pkt uuid; v_run uuid; v_after_append int; v_after_replace int;
begin
  -- Disposable packet + run, rolled back at the end. Touches no real data.
  insert into public.packets (user_id, title, raw_input, status)
    select id, '0014 probe', 'AAAA', 'draft' from public.users limit 1
    returning id into v_pkt;
  insert into public.ingestion_runs
    (user_id, packet_id, entry_point, source_hash, source_len, segmenter_version, source_offset_base)
    select user_id, v_pkt, 'organize', 'x', 4, 'probe', 0 from public.packets where id = v_pkt
    returning id into v_run;

  update public.packets set raw_input = 'AAAA' || 'BBBB' where id = v_pkt;   -- append
  select source_offset_base into v_after_append from public.ingestion_runs where id = v_run;

  update public.packets set raw_input = 'ZZZZ' where id = v_pkt;             -- replace
  select source_offset_base into v_after_replace from public.ingestion_runs where id = v_run;

  raise notice 'append_kept = %, replace_voided = %',
    (v_after_append = 0), (v_after_replace is null);

  if v_after_append is null then raise exception '0014: trigger voided an APPEND — too aggressive'; end if;
  if v_after_replace is not null then raise exception '0014: trigger MISSED a replace — stale base survives'; end if;

  delete from public.packets where id = v_pkt;   -- cascades the run
end
$probe$;
```

The `do $probe$` block creates and then deletes its own packet, so it leaves
nothing behind. If either `raise exception` fires, do not deploy code that reads
provenance until it is understood.


---

## 5. After the first real import

Run one ordinary import, then:

```sql
-- Every item the run created carries run + chunk + emission index, and the run
-- carries a base. For an `organize` run the base must be exactly 0.
select r.id                    as run_id,
       r.entry_point,
       r.source_offset_base,
       r.source_len,
       count(i.id)                                            as items_created,
       count(i.id) filter (where i.origin_chunk_ordinal is null) as missing_chunk,
       count(i.id) filter (where i.origin_emit_index    is null) as missing_emit,
       count(distinct i.origin_chunk_ordinal)                 as distinct_chunks
from public.ingestion_runs r
left join public.items i on i.origin_run_id = r.id
where r.status = 'finalized'
group by r.id, r.entry_point, r.source_offset_base, r.source_len
order by r.id desc
limit 5;
-- EXPECT: missing_chunk = 0, missing_emit = 0, items_created > 0,
--         source_offset_base = 0 for entry_point='organize'.

-- The base actually points at this run's source inside raw_input. The slice must
-- be exactly source_len units long — if it is short, the base is wrong.
select r.id,
       r.source_offset_base                                       as base,
       r.source_len,
       public.utf16_length(p.raw_input)                           as raw_input_len,
       r.source_offset_base + r.source_len <= public.utf16_length(p.raw_input) as slice_fits
from public.ingestion_runs r
join public.packets p on p.id = r.packet_id
where r.source_offset_base is not null
order by r.id desc limit 5;
-- EXPECT: slice_fits = true for every row.
```

The definitive check is in the app, not SQL: `segmentHash(raw_input.slice(base,
base + source_len)) === ingestion_runs.source_hash`. That is the assertion the
recompute path must make before emitting any finding.

---

## 6. Known gaps this migration does NOT close

Recorded deliberately rather than silently accepted.

1. ~~`/structure` leaves a stale base~~ — **CLOSED** by the
   `trg_ingest_invalidate_offsets` trigger in §4 of the migration. Any write that
   makes `raw_input` stop being an extension of its previous value nulls every
   affected `source_offset_base`, so a stale base cannot be read as a valid one.
   This covers the append route's read-modify-write race as well, and any future
   writer, because the invariant lives with the data rather than with callers.

2. **`/api/packets/[id]/append` is still a read-modify-write across a 60s model
   call.** It reads `raw_input`, calls the model, then writes back a value
   computed from the stale read, so a concurrent finalize's append can be lost.
   The trigger now correctly voids the affected base (the write is not an
   extension), so recomputation declines instead of accusing — but the underlying
   lost-append bug is pre-existing and unfixed.

3. **`supabase/schema.sql` still carries the 0012 `finalize`.** Applying
   schema.sql to a database that already has 0014 would silently revert
   provenance writing. The parity test (`ingestion-rpc.test.mts`) compares
   schema.sql against 0012 and still passes, so this is latent, not broken.

4. **Deleting a section cascades its `section_append` run away**
   (`ingestion_runs.target_section_id ... on delete cascade`, 0012:53), which
   SET NULLs provenance on any item that had been moved out of that section. The
   result is NULL — "unavailable" — so it degrades to declining, never to a wrong
   answer.
