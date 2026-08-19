# Library → Import with AI — bounded plan

Supersedes the recommendation in
[library-ai-import-assessment.md](library-ai-import-assessment.md). That
assessment assumed a Library import is "a handful of things" and proposed a
non-resumable path. **That assumption was wrong** — a realistic import is 20–40+
reusable items, which is squarely in the range that made packet ingestion need
persistence in the first place. This plan is designed for that scale.

Reading the ingestion internals rather than assuming also inverted the
architectural conclusion. It is written here in full because the earlier document
argued the opposite.

## What the code actually shows

The claim/lease/stage/split engine — `claim_chunk`, `stage_chunk_result`,
`mark_chunk_failed`, `split_chunk` — **touches no packet table at all**, and
authorizes purely on `ingestion_runs.user_id`:

```sql
select user_id, status into v_user, v_rstatus
  from public.ingestion_runs where id = p_run_id for update;
if v_user <> p_owner then raise exception 'ingestion: caller does not own run'; end if;
```

That is the hardest concurrency code in the product — the lease recovery, the
attempt-count claim generation that rejects a stale claimant, the idempotent
staging, the mid-record split tiling — and it is **already destination-agnostic**.

The packet coupling is confined to the endpoints:

| Packet-coupled | Why |
|---|---|
| `ingestion_runs.packet_id` | `not null references packets(id)` |
| `create_ingestion_run` / `create_organize_run` | baselines, packet checks |
| `finalize_ingestion_run` | writes sections/items into the packet |
| `discard_ingestion_run` | the delete-the-empty-draft rule |
| `idx_ingestion_runs_one_active` | one active run **per packet** |
| `block_publish_during_ingest` | a packet-only concern |
| chunk route reading `packets.packet_type` | one lookup, for the prompt |

Client-side, `useIngestion` (152 lines) is packet-coupled only at **start** and
**finalize**; the drive loop already speaks `runId` and nothing else.

## Recommendation: widen the run row, do not fork the engine

The alternative — separate `library_import_runs` / `library_import_chunks` tables
with their own copies of the four engine RPCs — has zero blast radius on the
packet path, and that is its only advantage. It costs a **permanent second copy
of a lease protocol that must stay in sync forever**. A bug found in claim
semantics would have to be fixed twice, and the second copy is the one nobody
looks at. That is precisely the divergence AGENTS.md exists to prevent.

Widening the run row is a one-time migration whose CHECK restores the old
invariant exactly.

### Migration 0020, in outline

```sql
alter table public.ingestion_runs alter column packet_id drop not null;

alter table public.ingestion_runs add column destination text not null default 'packet'
  check (destination in ('packet','library'));

-- The old NOT NULL, preserved exactly, for every packet run.
alter table public.ingestion_runs add constraint ingestion_runs_destination_coherent
  check ((destination = 'packet') = (packet_id is not null));

-- One active run per packet becomes: per packet, and separately per professional.
drop index if exists idx_ingestion_runs_one_active;
create unique index idx_ingestion_runs_one_active_packet on public.ingestion_runs(packet_id)
  where destination = 'packet' and status in ('active','finalizing');
create unique index idx_ingestion_runs_one_active_library on public.ingestion_runs(user_id)
  where destination = 'library' and status in ('active','finalizing');

-- entry_point gains 'library_import'
```

Every existing row takes `destination='packet'` from the default, and the CHECK
makes a packet run without a packet id unrepresentable. **No existing behaviour
changes.**

`entry_point = 'library_import'` maps to the existing `itemsOnlyPrompt()` and to
the existing `"items"` result shape in `ingest-validate.ts`. No new prompt, no new
validator, no new result shape — the `section_append` output already carries the
same eight fields as `ItemContentPayload`.

### The honest cost

Making `packet_id` nullable means **every read of `run.packet_id` must now be
destination-guarded**: the chunk route (which reads `packets.packet_type`), the
finalize route's pre-read, discard, the run-status route, and `ImportProgress`.
That is the real work of this change and the place a mistake would hide. It gets
source-level invariant tests asserting that no `packet_id` read is unguarded —
the same technique used for the ownership and Library wiring.

## What the Library does NOT inherit

**No finalize RPC that writes content.** This is the load-bearing decision.

In the packet path, finalize applies staged results into the packet. The Library
path never does that. The run's job ends at *proposing*; the professional
reviews, and the entries are written through the **existing** `createLibraryItem`
path — so the duplicate warning, the normaliser, and the single-writer property
all stay exactly where they are. `finalize_library_import_run` only marks the run
finished and clears `source_text` / `segment_text` / `result`.

Also not inherited: `content_rev`, baselines, composition invariants,
`block_publish_during_ingest`, and the delete-the-empty-draft discard rule.

## Flow

1. **`POST /api/library/import`** — paste text. Creates a `destination='library'`
   run, segments and tiles it exactly as today. Returns a `runId`.
2. **Drive** — the existing `/api/ingest/:runId/chunks/:ordinal` loop, unchanged.
   Resumable and reconnectable: close the tab at item 30 of 40 and reopen to find
   the work still there.
3. **Review** — proposals are read from the staged chunk results. Nothing
   preselected, same rule as bulk promotion. Each opens in `BlockItemEditor`.
4. **Save** — `POST /api/library/import/:runId/save` with the selected proposals.
   Loops server-side through the same `createLibraryItem` + duplicate check and
   returns a per-item outcome, so 40 items is one request rather than 40, and one
   duplicate does not fail the batch.
5. **Finish** — finalize (or discard) the run, clearing the staged text.

## The one open decision, which I would like your call on

**Where review edits live.** The extraction is durable either way. The question is
what happens to *selections and edits* if the tab closes during review.

- **Client-side (simpler)** — a tab close loses selections and any edits, but not
  the extraction. Re-review from the staged proposals.
- **A small `library_import_proposals` table** — `(run_id, ordinal, idx, payload,
  selected, edited)`. Makes the review step itself resumable.

For 20–40 items, review is not a moment — it is a sitting. Losing twenty minutes
of edits to a closed tab is the same class of failure that made ingestion
persistent in the first place, so I lean to the table. But it is one more table
for a step that only exists between extraction and save, and it is fair to call
that scope creep. **I have not built either; say which.**

## Explicitly out of scope

- No AI import into a *packet* changes. This adds a destination; it removes none.
- No live binding. An import seeds Library entries and disconnects, as
  `product-direction.md` requires of every input.
- No groups, tags, views, or workflow machinery on the Library.
