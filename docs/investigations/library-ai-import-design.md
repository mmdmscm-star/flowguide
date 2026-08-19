# Library → Import with AI — migration, schema, and state machine

Implementation-ready design. Supersedes the flow section of
[library-ai-import-plan.md](library-ai-import-plan.md); the architectural
reasoning there still stands. Nothing here is built yet.

Decided: reuse the claim/lease/chunk/stage engine, widen `ingestion_runs` with an
explicit destination, and **persist the review layer** so a closed tab loses
neither the model's work nor the professional's.

## 0. One thing the inventory caught

Migration **0013 replaced `idx_ingestion_runs_one_active`** to include
`needs_review`, because that state is non-terminal and must occupy the
one-active-run slot:

```sql
create unique index idx_ingestion_runs_one_active on public.ingestion_runs(packet_id)
  where status in ('active', 'finalizing', 'needs_review');
```

The sketch in the previous plan recreated it with only `('active','finalizing')`.
That would have applied cleanly, passed every obvious check, and **silently
undone 0013** — letting a second Organize start on a packet awaiting review. The
migration below carries all three statuses, and the post-apply verification
asserts the predicate rather than the index's existence.

## 1. Migration 0020 — widen the run row

Additive except for one index replacement. No data migration: every existing row
takes `destination='packet'` from the default.

```sql
begin;

alter table public.ingestion_runs
  add column if not exists destination text not null default 'packet'
    check (destination in ('packet','library'));

alter table public.ingestion_runs alter column packet_id drop not null;

-- The old NOT NULL, preserved SEMANTICALLY for every packet run. A packet run
-- without a packet, or a library run with one, is unrepresentable.
alter table public.ingestion_runs
  add constraint ingestion_runs_destination_coherent
    check ((destination = 'packet') = (packet_id is not null));

alter table public.ingestion_runs drop constraint if exists ingestion_runs_entry_point_check;
alter table public.ingestion_runs
  add constraint ingestion_runs_entry_point_check
    check (entry_point in ('organize','append','section_append','library_import'));

-- A library run has no packet, so 'library_import' must be the only entry point
-- that can carry a null packet_id, and vice versa.
alter table public.ingestion_runs
  add constraint ingestion_runs_library_entry_point
    check ((destination = 'library') = (entry_point = 'library_import'));

-- One active run per packet (all THREE statuses, per 0013) AND, separately,
-- one active import per professional.
drop index if exists idx_ingestion_runs_one_active;
create unique index idx_ingestion_runs_one_active_packet
  on public.ingestion_runs(packet_id)
  where destination = 'packet' and status in ('active','finalizing','needs_review');
create unique index idx_ingestion_runs_one_active_library
  on public.ingestion_runs(user_id)
  where destination = 'library' and status in ('active','finalizing','needs_review');

commit;
```

### The guard strategy: refuse, do not adapt

`finalize_ingestion_run` and `discard_ingestion_run` gain, immediately after the
ownership check:

```sql
if v_run.destination <> 'packet' then
  raise exception 'ingestion: run % has destination % and cannot use the packet path', p_run_id, v_run.destination;
end if;
```

This is deliberately stronger than tolerating a null. A library run must be
**incapable** of entering packet finalization — not merely unlikely to. Today
`finalize_ingestion_run` would fail on a null `packet_id` with
`ingestion: packet not found`, which is fail-closed but indistinguishable from a
deleted packet; the explicit guard is the difference between a safe accident and
a stated rule.

Two objects need **no** change, and the verification asserts that rather than
assuming it: `block_publish_during_ingest` and `ingest_invalidate_offsets` both
match `where packet_id = new.id`, which never matches a null.

## 2. Migration 0021 — the review layer

```sql
begin;

create table if not exists public.library_import_proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingestion_runs(id) on delete cascade,
  ordinal int not null,           -- the leaf chunk this came from
  idx int not null,               -- position within that chunk's result
  payload jsonb not null,         -- canonical ItemContentPayload; an edit overwrites in place
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, ordinal, idx)   -- stable identity; makes materialisation idempotent
);

create index if not exists idx_library_import_proposals_run
  on public.library_import_proposals(run_id, ordinal, idx);

alter table public.library_import_proposals enable row level security;
-- No anon/authenticated policies: reachable only via the service role, like
-- ingestion_runs and library_items.

commit;
```

**No version history, no sync, no folders, no tags, no second Library model.**
`payload` is the same `ItemContentPayload` the Library and both editors already
speak. There is no `edited` flag because an edit is just a payload it holds; the
row's existence means "proposed and not yet saved".

**Deliberately absent: any link to `library_items`.** A saved proposal is
**deleted**, which makes the table self-draining and a partial save idempotent by
construction — the rows that remain are exactly the ones not yet saved, so a
retry after a failure at item 25 of 40 saves the other 15 and cannot duplicate
the first 25.

## 3. State machine

The run reuses the existing statuses. Processing and review are **derived**, not
new states — `completed_chunks = total_chunks` is what already drives the client
loop, and adding a status would mean two places to keep in sync.

```
                POST /api/library/import
   [none] ─────────────────────────────────▶ active · extracting
                                                   │
                    existing chunk loop, unchanged │ all leaf chunks completed
                                                   ▼
                                            active · review
                                       (proposals materialised, idempotently)
                                                   │
       PATCH a proposal (edit / select) ◀──────────┤  durable; survives a closed tab
                                                   │
                     POST …/save  ─────────────────┤  writes ONLY selected, via
                    (deletes saved proposals)      │  createLibraryItem; run stays open
                                                   │
                     POST …/finish ────────────────▶ finalized
                              (clear source_text, segment_text, result; drop remaining proposals)
                     POST …/discard ───────────────▶ discarded  (same cleanup, nothing saved)
```

Reopening at any point re-derives the phase from the run row plus chunk
completion, exactly as the packet path already does. **Nothing becomes a Library
item until the professional explicitly saves it.**

## 4. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/library/import` | paste text → create a `destination='library'` run; returns `runId`, `totalChunks` |
| `GET` | `/api/ingest/:runId` | **reused unchanged**; gains `destination` in its response |
| `POST` | `/api/ingest/:runId/chunks/:ordinal` | **reused unchanged** except for skipping the `packet_type` lookup |
| `POST` | `/api/library/import/:runId/proposals` | materialise from staged results; idempotent |
| `GET` | `/api/library/import/:runId/proposals` | restore review state on reopen |
| `PATCH` | `/api/library/import/:runId/proposals/:id` | `{ payload?, selected? }` |
| `POST` | `/api/library/import/:runId/save` | save all selected through `createLibraryItem`; per-item outcomes; deletes saved rows |
| `POST` | `/api/library/import/:runId/finish` | finalize and clear staging |
| `POST` | `/api/library/import/:runId/discard` | abandon and clear staging |

Materialisation inserts with `on conflict (run_id, ordinal, idx) do nothing` —
**never `do update`**, so re-running it after a reconnect can never overwrite an
edit the professional already made. Only leaf chunks with `status='completed'`
contribute; a chunk that was split is represented by its children, the same rule
finalize already uses.

`POST …/save` loops server-side through the **existing** `createLibraryItem` and
duplicate check, so 20–40 items is one request rather than forty, one duplicate
does not fail the batch, and the Library keeps exactly one writer.

`entry_point='library_import'` maps to the existing `itemsOnlyPrompt()` and the
existing `"items"` result shape — no new prompt, no new validator. Because that
prompt takes no `packetType`, the chunk route's `packets.packet_type` lookup is
simply skipped for library runs rather than needing a substitute.

## 5. Every `packet_id` read, and its guard

The complete inventory. This is the real work of the change and the place a
mistake would hide.

| Site | Today | After |
|---|---|---|
| `finalize_ingestion_run` | dereferences `v_run.packet_id` | explicit destination refusal |
| `discard_ingestion_run` | dereferences `v_run.packet_id` | explicit destination refusal |
| `create_ingestion_run`, `create_organize_run` | take `p_packet_id` | write `destination='packet'` explicitly |
| `block_publish_during_ingest` | `where packet_id = new.id` | **unchanged** — never matches null |
| `ingest_invalidate_offsets` | `where packet_id = new.id` | **unchanged** — never matches null |
| `api/ingest/[runId]/route.ts:33` | returns `packetId` | also returns `destination`; `packetId` null for library |
| `api/ingest/[runId]/chunks/[ordinal]/route.ts:119` | `packets.packet_type` lookup | skipped when `destination='library'` |
| `api/ingest/[runId]/finalize/route.ts:26,68` | pre-reads `packet_id` | refuses a library run early, pointing at `…/finish` |
| `useIngestion.ts:135` | `POST /api/packets/:id/ingest` | start and finalize become parameters |

A source-level test asserts that no read of a run's `packet_id` is unguarded, in
the style of `ownership-route.test.mts`.

## 6. Proving packet ingestion is behaviourally unchanged

Required before shipping, applied one step at a time with your approval.

**Preflight.** Capture, as text: the definitions of every index and constraint on
`ingestion_runs`, the signatures of the six ingestion RPCs, current row counts by
status, and the count of runs with a null `packet_id` (must be zero).

**Post-apply, on the migration.**
1. Every pre-existing run has `destination='packet'` and a non-null `packet_id`.
2. The coherence CHECK **rejects** a packet run with a null `packet_id`, and a
   library run with one — proven by two aborted inserts, not by reading the DDL.
3. `idx_ingestion_runs_one_active_packet` carries all three statuses. Asserted by
   comparing the index predicate, and by an aborted insert of a second
   `needs_review` run on one packet — the regression this design nearly shipped.
4. `idx_ingestion_runs_one_active_library` forbids a second active import per user.
5. `finalize_ingestion_run` and `discard_ingestion_run` raise on a library run.
6. `block_publish_during_ingest` and `ingest_invalidate_offsets` are byte-identical
   to their current definitions.

**Runtime proof, on disposable data, before and after.** A full Organize run
(create → chunks → finalize), an `append` run, and a `section_append` run, each
end to end, with identical resulting section/item structure and identical
`content_rev` deltas. Plus a discard that deletes the empty draft it created, and
a publish blocked while a run is active. These are the paths that must not move.

## 7. Two consequences, named rather than discovered later

**Photos carry no ingestion provenance.** A proposal may contain photo URLs the
model found in the pasted text, exactly as the packet `append` path already can.
Saved into the Library and later inserted into a packet, such an item has
`origin_run_id = null`, so the 0016 ownership gate yields
`no_ingestion_provenance` — a **decline**, which is nonblocking, not a block and
not a claim of a clean check. That is the existing, correct behaviour for every
Library item today; this feature does not change it, and must not be built in a
way that fabricates provenance to avoid the decline.

**`needs_review` does not apply to library runs.** It exists for exact media
accounting against a packet at finalize. Library imports never call packet
finalize, so the status is simply unreachable for them — but the one-active index
still lists it, so a future change that does reach it cannot quietly break the
one-run-per-professional rule.
