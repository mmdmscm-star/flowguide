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

## 0b. Two invariants, settled explicitly

### One active import — stated separately for each destination

**The hazard is real and correctly identified.** In PostgreSQL a unique index
treats NULLs as *distinct* by default, so a unique index keyed on `packet_id`
constrains nothing once `packet_id` is nullable — a hundred library runs all
carrying `packet_id = null` would each be "unique". Relying on the existing index
to cover library runs would silently allow unlimited simultaneous imports.

The design therefore never keys a library run by `packet_id`. Two indexes, two
rules, neither inferring anything from the other:

| Destination | Key | Rule |
|---|---|---|
| `packet` | `packet_id` | one non-terminal run **per packet** — unchanged, including `needs_review` |
| `library` | `user_id` | one non-terminal import **per professional** |

The `where destination = '…'` predicate on each means correctness does not rest
on NULL semantics at all — the library index would behave identically even if
`packet_id` were never null.

**One import per professional is the intended rule**, not an incidental
consequence. An import owns the review layer, and a second concurrent import
would put a professional in two review sittings at once with no way to tell which
proposals belong to which paste. There is no product reason to allow it, and the
Library is not a per-destination resource the way a packet is — so the
professional is the correct key.

The create RPC catches the unique violation and **returns the existing run**
(`reused: true`), exactly as `create_organize_run` already does for a retried
POST, so a double-submit reconnects to the import in progress instead of
surfacing a constraint error.

Verified by **attempted inserts, not index names** — see §6.

### Per-proposal save atomicity

**This was a real gap in the previous draft.** "Create the Library item, then
delete the proposal" as two independent writes over PostgREST can split across a
failure boundary: a crash in between leaves the item created and the proposal
still present, and a retry creates a second item. The duplicate warning is not a
guarantee — it is title/address heuristic and advisory by design.

Fixed by making the pair a single transaction inside one function, the pattern
`library_save_as_new_from_item` (0017) already establishes:

```sql
create or replace function public.library_save_proposal(
  p_owner uuid, p_run_id uuid, p_proposal_id uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_run record; v_p record; v_new uuid;
begin
  select * into v_run from public.ingestion_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'library: run % not found', p_run_id; end if;
  if v_run.user_id <> p_owner then raise exception 'library: caller does not own run'; end if;
  if v_run.destination <> 'library' then raise exception 'library: run % is not a library import', p_run_id; end if;

  select * into v_p from public.library_import_proposals
    where id = p_proposal_id and run_id = p_run_id for update;

  -- ALREADY SAVED. This is exactly what a retry after a crash looks like, and it
  -- must be a no-op returning nothing — never a second item.
  if v_p.id is null then return null; end if;

  insert into public.library_items
    (user_id, title, address, description, notes, details, links, photos, contacts)
  values (
    p_owner,
    coalesce(v_p.payload->>'title', ''),   coalesce(v_p.payload->>'address', ''),
    coalesce(v_p.payload->>'description', ''), coalesce(v_p.payload->>'notes', ''),
    coalesce(v_p.payload->'details',  '[]'::jsonb), coalesce(v_p.payload->'links',    '[]'::jsonb),
    coalesce(v_p.payload->'photos',   '[]'::jsonb), coalesce(v_p.payload->'contacts', '[]'::jsonb)
  )
  returning id into v_new;

  delete from public.library_import_proposals where id = p_proposal_id;
  return v_new;
end;
$$;
```

A plpgsql function body is one transaction: the insert and the delete commit
together or not at all. **No crash window exists between them.** The `for update`
on the proposal row also serialises two concurrent saves of the same proposal —
the second blocks, then finds the row gone and returns null.

`source_packet_item_id` is deliberately not written: an imported entry has no
packet item, exactly as a directly-written one does not.

This keeps `library_import_proposals` free of any `library_item_id` column. The
idempotency comes from the row's *absence*, which is a fact the transaction
guarantees, rather than from bookkeeping that would itself need to be written
atomically.

The advisory duplicate scan stays in TypeScript, before the call. It is a
warning the professional answers, not a constraint, and a read-then-act race on
it is harmless: the worst outcome is two similar entries, which the Library
explicitly permits.

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

0021 also creates **`library_save_proposal`** (§0b) — the atomic per-proposal
save — with the same `revoke … from public, anon, authenticated` /
`grant execute … to service_role` treatment every other Library RPC gets.

**Deliberately absent: any link to `library_items`.** A saved proposal is
**deleted**, which makes the table self-draining and a partial save idempotent by
construction — the rows that remain are exactly the ones not yet saved, so a
retry after a failure at item 25 of 40 saves the other 15 and cannot duplicate
the first 25.

## 3. State machine

### What "waiting for human review" is, exactly

**`status = 'active'` with `completed_chunks = total_chunks` and
`total_chunks > 0`.** No new status is introduced.

Reopening the app during review reads the run row and derives the phase from
those three values — the same computation the packet drive loop already performs
before it finalizes. Materialisation is then always safe to call, because it is
idempotent, which also covers the narrow case of a crash between the last chunk
completing and the proposals being written.

**Why not a dedicated `awaiting_review` status.** It would have to be added to
the predicate of *both* one-active indexes, because a run awaiting review is
emphatically non-terminal — a professional must not be able to start a second
import while reviewing the first. Forgetting either predicate would silently
permit exactly that. This is the same failure 0013 had to repair for
`needs_review`, and the same one this design nearly reintroduced (§0). Deriving
the phase means there is no new non-terminal value that any predicate can forget.

`active` already appears in both predicates, so a library import holds its
one-active slot for its entire life — extraction *and* review.

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
4. `idx_ingestion_runs_one_active_library` forbids a second active import per
   user — proven by an aborted insert of a second `active` library run for one
   professional, and separately by inserting a second run for a DIFFERENT
   professional and confirming it succeeds, so the index is shown to constrain
   the right thing rather than everything.
4b. A unique index keyed on `packet_id` is shown NOT to constrain library rows —
   two library runs with null `packet_id` inserted under the old-style predicate
   in a rolled-back transaction — so the separate `user_id` index is proven
   necessary rather than assumed.
5. `finalize_ingestion_run` and `discard_ingestion_run` raise on a library run.
6. `block_publish_during_ingest` and `ingest_invalidate_offsets` are byte-identical
   to their current definitions.

**Post-apply, on 0021.**
7. `library_save_proposal` is atomic: with a deliberate fault injected between
   the insert and the delete (a raised exception inside the function), NEITHER
   the `library_items` row nor the proposal deletion survives — proving they
   share a transaction rather than merely running in sequence.
8. Calling it twice for the same proposal yields one Library item and a null on
   the second call.
9. It refuses a run whose destination is `packet`, and refuses a caller who does
   not own the run.

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
