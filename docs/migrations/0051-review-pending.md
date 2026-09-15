# 0051 — the review-pending marker

## The gap it closes

`finalize_ingestion_run` commits an import's content and sets the run
`finalized`. Only afterwards does the finalize route work out whether that
content needs a decision (media accounting, held review units, an empty run),
and before this change it wrote `needs_review` in a separate call. Between those
two commits the run was `finalized`, so a publish landing in that gap skipped the
review gate. No lock can close that: the intermediate state was committed.

## The fix, in two independently deployed parts

**1. Route and client (deployed first; correct with or without 0051).**

- `lib/import-blocking.ts` is the one TypeScript definition of "this import
  blocks publishing": status `active`, `finalizing` or `needs_review`, **or**
  `finalized` with `review.pending = true`. The ingest reconnect lookup, the
  existing-run check and the publish gate all use it.
- The finalize route records **both** verdicts (`{ok: true, …}` for a clean run,
  `needs_review` otherwise), and only onto an undecided review: `finalized` with
  no `review.ok`, which is the pending marker or the `{}` every run held before.
  A replay can never overwrite a decision.
- **Fail closed.** If the check throws, a read it depends on errors, or its
  verdict cannot be written, the route returns `503 review_not_recorded` and
  writes nothing.
- The client treats a pending run as unfinished: it calls finalize again, which
  returns `reused` and re-runs the check. That replay is the recovery path, and
  reconnecting on reload finds the pending run because the lookup uses the same
  definition.
- The publish gate refuses a pending run (`409 import_finishing`) and refuses
  when it cannot read runs at all (`503 import_check_unavailable`).

**2. Migration 0051.** `finalize_ingestion_run` sets `review = {"pending": true}`
in the same UPDATE that sets `finalized`; one SQL definition of "blocks
publishing" backs the publish-ingest trigger; the one-active-run index counts a
pending run as holding the slot.

Between the two deploys, runs never carry the marker, so behaviour is today's
except that clean verdicts are now recorded and failures refuse.

## Known limitation: a deterministic check failure leaves a run pending

If the review check fails the same way every time — a bug in accounting, or a
source the check cannot process — the run stays `finalized` + pending and the
Sendset **cannot be published**. Discard refuses finalized runs, and this change
deliberately adds no bypass.

What it looks like: the import panel keeps offering a retry that returns
`review_not_recorded`, and Publish answers "Sendset is still checking the
import."

What recovers it: fixing the fault and letting the client replay finalize.
There is no user-facing exit until that happens. A manual operator exit, if one
is ever needed, is a separate reviewed change — not a quiet edit to `review`.

## Verification before applying

- **Unit/source tests** (`src/lib/import-blocking.test.mts`): which runs block,
  what counts as undecided, the route's conditional verdict write, fail-closed
  paths, the client replay, and that the SQL helper, index and CHECK in 0051
  compare the marker exactly as the PostgREST filter does. 14 mutants of the
  route/client code, all caught.
- **Real PostgreSQL 17** (`scripts/pg-harness/test-0051.mjs`, schema replayed
  from the migrations; see `scripts/pg-harness/README.md`):
  - a real `finalize_ingestion_run` commits `{pending: true}`; publishing is
    refused until the route's verdict is recorded; a second import cannot start;
    replays neither re-mark nor overwrite a decision; a run finalized before 0051
    does not block;
  - **before 0051**, the gap is real: straight after finalize, publishing
    succeeds with no verdict recorded;
  - **two connections**: with finalize in flight, publish waits on its lock
    (observed in `pg_stat_activity`). Before 0051 it then goes through; after
    0051 it sees the marker and is refused. With the clean verdict written but
    uncommitted, publish is still refused, and succeeds once it commits;
  - the rollback refuses while a run is pending, then restores the exact 0034 /
    0013 / 0020 definitions, and 0051 re-applies;
  - 10 mutants of the migration abort and leave nothing.
