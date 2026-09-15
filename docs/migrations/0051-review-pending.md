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
