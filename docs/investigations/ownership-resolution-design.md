# Ownership resolution — design (IMPLEMENTED; migration 0016 not yet applied)

> **Superseded numbering:** the resolution migration is now **0016**. Number 0015
> was taken by an urgent, unrelated security fix found during this design's
> review — see `supabase/migrations/0015_close_anon_write_and_enumeration.sql`.
>
> **Revised after adversarial review.** The changes below are folded into the
> plan: block only on `media_on_wrong_record`; drop `source_hash` from the
> override key; enumerate runs from `items.origin_run_id` rather than run status;
> carry `origin_emit_index` into binding. See "Review outcomes" at the end.

Goal: wrong ownership detected → publish blocked → the professional resolves it
visibly (**Move** or intentional **Keep**) → recomputation reflects the
resolution → publish succeeds.

## The central asymmetry

**Move changes reality. Keep records intent. Only Keep needs storage.**

This falls out of the recompute design. A finding is never stored — it is
re-derived from live rows. So when a photo is moved to the item the source
actually puts it on, the finding does not need to be "resolved"; it simply stops
being true on the next recompute. Nothing to mark, nothing to go stale.

Keep is different in kind. The professional is asserting *"I know the source puts
this elsewhere, and I want it here anyway."* That is new information which exists
nowhere in the data, so it has to be recorded. The founder's framing: the source
is evidence of original ownership, but it must not permanently outrank a
deliberate professional edit.

This is why the design needs exactly one new table and not two.

## What identifies an override, and why it can't go stale

An override says: *photo `url` on item `item_id` is intentional.*

- **`item_id`** is stable across renames, reorders, section moves and photo
  churn. It is the only stable handle in this system — `item_photos` rows are
  deleted and reinserted with new uuids on every save (0011), which is why
  provenance lives on `items` and why an override cannot key on a photo row.
- **`url`** matches the granularity findings are already deduped at, per
  `(url, item)`. A `media_on_wrong_record` finding only fires when the URL sits
  in exactly one source record, so every copy on that item is misplaced together
  — one decision covers them coherently. The genuinely ambiguous case (one URL in
  two different records) is `ownership_unverifiable` and offers no Move, so it
  cannot be Kept by mistake either.
- **`source_hash`** binds the decision to the source it was made against. If the
  source is later replaced, recompute declines outright and overrides are never
  consulted; if a new run appends different content, its findings carry a
  different hash and old overrides do not silently suppress them.

An override therefore expresses intent about a specific photo on a specific item
against a specific source. It is intentional state, not cached derivation.

## Migration 0015 — the narrowest coherent shape

```sql
create table public.item_media_decisions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  url         text not null,
  source_hash text not null,
  decision    text not null check (decision in ('keep')),
  created_at  timestamptz not null default now(),
  unique (item_id, url, source_hash)
);
```

`decision` is a CHECK-constrained text with one legal value today rather than a
boolean, so a future disposition (`reject`, `defer`) is an additive change rather
than a schema migration. `on delete cascade` because a decision about a deleted
item is meaningless.

No `content_rev` trigger. A decision is not packet content, and bumping the
revision would falsely trip an in-flight run's `baseline_content_rev` assertion.

Three RPCs, all owner-scoped and draft-only, mirroring 0012's posture (revoked
from `anon`/`authenticated`, reached through `SECURITY DEFINER`):

1. **`move_item_photos(p_owner, p_from_item, p_to_item, p_url)`** — moves every
   row with that URL from one item to the other, in one transaction, after
   asserting both items belong to the same packet, the caller owns it, and it is
   still a draft. Returns the number moved. Today this would be three
   non-atomic writes through `update_item_content`, with a window where the photo
   exists on neither item.
2. **`set_item_media_decision(p_owner, p_item_id, p_url, p_source_hash)`** —
   upserts a `keep`.
3. **`clear_item_media_decision(p_owner, p_item_id, p_url, p_source_hash)`** —
   the undo. A resolution the professional cannot reverse is a trap.

## Where blocking lives

**In the publish route, recomputed — not in the database trigger.**

The trigger blocks on run *status*, which is a stored value. Ownership is a
derived condition, so storing it would reintroduce exactly the staleness this
design exists to avoid: fix the photo, and a stored `needs_review` would still
block you.

So `POST /api/packets/[id]/publish` recomputes ownership and returns 409 with the
findings when any remain unresolved. That is the same place the friendly
`import_needs_review` message already lives.

The trade-off, stated plainly: this is an application-layer gate, not a database
one. `block_publish_during_ingest` remains the hard guard for run status and is
untouched. Ownership blocking is enforced at the only door the app actually opens.

## What recompute does with overrides

`recomputeOwnership` keeps deriving the discrepancy from source and provenance —
unchanged, and still declining when it cannot prove the source. A new thin layer
above it drops any finding matching a stored `keep` for its `(item_id, url,
source_hash)`.

The discrepancy is still *computed*; it is merely not *reported*. That preserves
the founder's requirement: recompute continues to derive from source/provenance,
and the override is an explicit user choice layered on top rather than a mutation
of the derivation. A future "show me what I overrode" view needs no new data.

## The professional's view

In the review panel, per finding:

> **The Reserve at Fountaingrove** — this photo came from Chanate's row in your
> source.
> `[Move to Brookdale Chanate]` `[Keep here]`

Move calls the RPC and the finding disappears because it is no longer true. Keep
records the decision and the finding disappears because it was intended. Both are
visible, both are reversible, and publishing unblocks when none remain.

`ownership_unverifiable` findings offer only Keep, because no single destination
is resolvable — the whole point of that code is that proposing one would be a guess.

## Open questions — as resolved in build

1. **Per-photo, as leaned to.** "Keep all on this item" stays additive; nothing
   in the schema or the RPC signature has to change to add it.
2. **Surfaced for the session that made them, not durably.** The panel lists
   every Keep made on screen with an Undo, and stays mounted after the last
   finding clears so the undo does not vanish at the moment a misclick is
   noticed. What does NOT exist is a durable "show me everything I ever kept"
   view: once the panel is dismissed, a Keep is only reachable through the API.
   That needs a home outside the publish-409 path — an editor-level surface —
   and is deliberately deferred rather than half-built. **This is the one part
   of the design that is not finished.**
3. **Confirmed, and one case corrected.** Moving all copies is right, but the
   destination may already hold the url — a model duplicating a photo rather
   than misfiling one copy. `item_photos` has no unique `(item_id, url)`, so the
   original SQL would have given the destination the same photo twice. It now
   deletes the misplaced copies in that case instead.


## Review outcomes (five lenses, 9 objections confirmed of 38 raised)

1. **Block only on `media_on_wrong_record`.** `continuation_fabrication` and the
   structural half of `ownership_unverifiable` carry no `url`, so neither button
   can act on them and neither can be written to a url-keyed table. Worse,
   deleting one of two sibling items — an ordinary edit — makes the survivor
   `ownership_unverifiable`, which under the original design would block
   publishing forever with two dead buttons on screen. The other codes become
   advisory. This also keeps `url not null` and removes the need for a
   `finding_code` column.

2. **Positional binding must verify emission completeness.** `verifyOwnership`
   infers "the nth item is the nth head" from surviving items, not emitted ones.
   Delete the *first* item of a chunk and every binding shifts by one, producing
   confident, wrong "Move to X" proposals. `origin_emit_index` already exists for
   this — `recomputeOwnership` currently drops it. Require a chunk's surviving
   emit indices to be exactly `0..n-1` before trusting positional binding.

3. **Enumerate runs from `items.origin_run_id`, never from run status.**
   `discard_ingestion_run` leaves `origin_run_id`, the offsets and the hashes
   intact, so filtering on `status='finalized'` would silently exempt exactly the
   incident case — mis-attributed content owned by a discarded run.

4. **Drop `source_hash` from the override key.** Overrides are only consulted
   after recompute returns `ok`, which already proves the source hashes to the
   run's `source_hash`. For a given `item_id` the run — and therefore the hash —
   is fixed, so the column can never discriminate but can silently lose a Keep.
   `unique (item_id, url)` is strictly equivalent and narrower. The `decision`
   column goes with it: the row's existence means kept.

5. **Discard does not clear ownership findings, and the copy must stop implying
   it does.** Discarding abandons the source, not the photos. `describeReviewExit`
   currently promises "Discard the import to unblock publishing."

Also adopted: log the `DeclineReason` at the publish gate (a packet that silently
stopped being checked must not look identical to a clean one), and name the
surface explicitly — an editor-level panel driven by the publish 409, **not**
`ImportProgress`, which only mounts on run status and will not be mounted when a
finalized run's finding fires.


## Build outcomes (a second review, of the implementation)

Six defects in the first implementation, one of them a publish trap:

1. **The overrides read failed CLOSED while every other read failed open.** A
   missing `item_media_decisions` — the state on ship day, before 0016 is
   applied — silently meant "no Keeps", blocking every affected packet, with the
   one action that clears the block writing to the absent table. A failed
   decisions read now withdraws blocking for the whole packet.
2. **Move could duplicate** — see open question 3 above.
3. **A missing run row was silently skipped**, so a run's items went unchecked
   while the packet reported itself as checked.
4. **`ownership-service.ts` was binary to git** — two raw NUL bytes used as
   composite-key delimiters. Now an escape.
5. **It was also unimportable by the test runner** (missing `.ts` extensions),
   which is why it had no tests. It now has 13, plus 9 route invariants.
6. **Review outcome #5 had never landed** — `describeReviewExit` still promised
   "Discard the import to unblock publishing."

The gate is inert until 0016 is applied, in either deploy order — see
[docs/migrations/0016-deployment.md](../migrations/0016-deployment.md).