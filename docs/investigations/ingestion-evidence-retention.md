# Step 1 — stop destroying semantic-ingestion evidence

Design only. **Nothing is implemented and nothing is applied.** No routing,
prompt or classification behaviour changes here.

---

## 1. What `library_close_import_run` currently clears

Eight things across two tables, plus a delete — on **both** `finalized` and
`discarded`, with no distinction between finishing and throwing away:

```sql
delete from public.library_import_proposals where run_id = p_run_id;

update public.ingestion_runs
   set status = p_status, source_text = null, derived_title = '',
       derived_client_name = '', error = '', updated_at = now()
 where id = p_run_id;

update public.ingestion_chunks
   set result = null, segment_text = null, section_hint = '', error = '', updated_at = now()
 where run_id = p_run_id;
```

| lost | was |
|---|---|
| `ingestion_runs.source_text` | the pasted source |
| `ingestion_chunks.segment_text` | each chunk's exact slice |
| `ingestion_chunks.result` | **the model's raw output** |
| `ingestion_chunks.error` | why a chunk failed or retried |
| `ingestion_chunks.section_hint`, `runs.derived_*` | minor, but part of the record |
| `library_import_proposals` rows | the reviewed intermediate, including any professional edits |

### The second gap, which matters more

**`library_items` carries no link to the run, chunk or proposal that produced
it.** Its only provenance column is `source_packet_item_id`, which belongs to the
packet-promotion path. So the chain is broken in *two* places:

```
source_text ─→ segment_text ─→ result ─→ proposal(run,ordinal,idx) ─→ library_items
   cleared        cleared       cleared        deleted                  NO LINK
```

Even if nothing were cleared, no output could be traced back to its input.
Retention alone does not make imports diagnosable; the missing edge has to be
added too.

---

## 2. Smallest change that preserves the evidence

Two changes, no new tables, no duplicated blobs.

### (a) Record where an entry came from — 3 columns on `library_items`

```sql
alter table public.library_items
  add column if not exists origin_run_id uuid references public.ingestion_runs(id) on delete set null,
  add column if not exists origin_chunk_ordinal int,
  add column if not exists origin_item_index int;
```

Deliberately the **same names 0014 already uses on `items`** for packet
ingestion, so provenance means one thing across the codebase.

`library_save_proposal` already reads the proposal row, which carries `run_id`,
`ordinal` and `idx` — so this is three values it already has in hand, written in
the same statement. No extra read, no behaviour change.

**This removes the need to retain `library_import_proposals` at all.** The
proposal's *coordinates* are enough: `result->'items'->origin_item_index` of the
chunk at `origin_chunk_ordinal` is exactly the model output that became this
entry. Delete-on-save — the idempotency mechanism proven in 0021 — is untouched.

*One boundary to keep:* `library_copy_into_section` must continue **not** to copy
these into `items.origin_*`. A Library copy has no ingestion origin as far as the
0016 ownership gate is concerned, and fabricating one there would make ownership
recomputation claim a source that does not exist. The distinction is that
`library_items.origin_*` records *where this saved entry came from*, while
`items.origin_*` records *what a packet item was ingested from*.

### (b) Keep the blobs where they already live

`ingestion_runs.source_text` and `ingestion_chunks.segment_text` / `result`
already hold everything needed. The change is to stop nulling them on
**finalize** — while continuing to clear on **discard**, where the professional
has explicitly thrown the import away.

Nothing is copied anywhere. Storage is what the run already used: the largest
real import so far is 116 KB of source, so on the order of a few hundred KB per
run once segments and results are counted.

---

## 3. Retention

**Evidence is kept for 30 days after an import finishes, then purged.**

Purge runs **lazily, at the start of the next import**, inside
`create_library_import_run`: before creating a run, clear evidence from this
professional's runs finalized more than 30 days ago. Plus an explicit
`purge_ingestion_evidence(p_owner, p_older_than)` for on-demand use.

Chosen over a scheduled job because it needs no `pg_cron` dependency, the work is
bounded and self-limiting, and it runs exactly when the feature is in use. The
honest cost: a professional who never imports again keeps their last import's
evidence until someone calls the explicit purge. That is a bounded, owner-scoped
amount of the professional's own text, and the explicit RPC covers it.

Purging sets the same columns the close currently sets, so "purged" and "closed
before this change" are indistinguishable states — no new shape to handle.

**Discard is unchanged: it clears immediately.** Retention is for imports that
finished, not for ones abandoned.

---

## 4. Security and RLS

No new exposure, and one reduction.

- `ingestion_runs` and `ingestion_chunks` have **RLS enabled with no policies** —
  reachable only through the service role. Unchanged.
- `library_items` is the same. The three new columns inherit that.
- `searchLibrary` and `getLibraryItem` select an explicit `COLUMNS` list, so the
  new columns are **not returned by any existing endpoint** until something asks
  for them. No API surface changes here.
- `/p/[slug]` touches none of these tables. A recipient cannot reach any of it by
  any path.
- The retained text is the professional's **own reference material** — the thing
  they pasted — not client data. It was already stored for the life of the import;
  this extends that window to a bounded 30 days rather than to the moment of
  finishing.
- The FK is `on delete set null`, so purging or deleting a run never cascades
  into a Library entry.
- **Reduction:** today, evidence for a *discarded* run and for a *finished* run
  are cleared by the same path with no policy attached. After this there is a
  stated retention period with an enforcing mechanism, rather than "cleared
  whenever close happens to run".

---

## 5. Numbering — this is 0024, photo normalization becomes 0025

Migration numbers follow **application order**, not the order things were
discussed. Reserving 0024 for work that has not been applied would leave a gap
that has to be explained forever, and would invite a second migration to claim
the same number.

So: **0024 = evidence retention** (this), **0025 = canonical photo
normalization + historical repair**. The roadmap entry for photo normalization
should be updated to say 0025 so the reservation does not resurface. Nothing
about that work changes — it is still bounded, still needs its own preflight and
row counts, and is still not urgent.

---

## The proof this must come with

A runtime proof, on disposable data, that **a finished import is still
traceable**:

1. run a real Library import to completion;
2. save some proposals, leave others, then **finish** it;
3. from a saved `library_items` row alone, walk
   `origin_run_id → ingestion_runs.source_text`,
   `origin_chunk_ordinal → ingestion_chunks.segment_text` and `.result`,
   `origin_item_index → result->'items'->idx`;
4. assert the reconstructed model output matches the saved entry's content for
   fields nothing has since edited;
5. assert the chunk's `source_start`/`source_end` slice of `source_text` is the
   `segment_text` — so the source span is recoverable, not merely stored;
6. assert an entry edited after saving still traces, and that its *current*
   content differing from the model output is visible rather than confusing;
7. assert **discard still clears everything**;
8. assert a run finalized beyond the retention window is purged by the next
   import, and that purging does not touch the Library entries;
9. assert the Library entry itself was never mutated by any of this.

Point 4 is the one that makes the corpus possible later: it is the source↔output
pair this investigation could not obtain.

---

## Explicitly not in this step

No routing, prompt, schema-of-content or classification change. No corpus. The
mixed import that seeds the corpus comes **after** this lands, because it is the
first import whose evidence will survive.
