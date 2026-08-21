# Persisted creator-visible unresolved source units — design

*Design only. Nothing implemented. Enforcement remains OFF.*

## The substrate already exists

I looked before designing, and 0013 built this for the same reason:

> `needs_review` is a NON-TERMINAL state entered on an OBJECTIVE accounting
> failure … "the content was applied, but it provably does not match the source."

That is our case exactly. Four pieces are already in place:

| piece | what it does today | fits? |
|---|---|---|
| `ingestion_runs.review` jsonb | `{ok, summary, failures:[{code, url, offset, itemIds}]}` — per-failure, with a **source offset** and the **items** it concerns | **yes**, with two fields added |
| `needs_review` run status | non-terminal; holds the one-active-run slot | yes |
| `block_publish_during_ingest()` (0013) | a run in `needs_review` **blocks publishing** | yes |
| `ImportProgress.tsx` | already renders a review panel with summary + exit | yes, needs a list |

0013's own comment says the shape is *"structured so the editor can render each
unresolved item WITH the source offset it came from — a professional cannot
adjudicate ownership from a count, only from seeing where the media sat."*
That is the same argument, for prose instead of photos.

**No second review system.** The media-accounting failures and the semantic
unresolved units are the same kind of thing: objective, source-anchored, and
requiring a human decision.

## 1. Persistence — extend the existing shape

`review.failures[]` gains what semantic units need and photos never did:

```jsonc
{
  "code": "privacy_rejected",        // | source_unresolved | attribution_unresolved
  "text": "Why it made the list: …", // the exact source prose, verbatim
  "offset": 4213, "len": 168,        // source span — already the 0013 convention
  "record": 3,                       // envelope index (source record identity)
  "itemIds": ["…"],                  // the packet item, when known
  "status": "unresolved"             // | resolved | ignored
}
```

`text` and `record` are new; `status` is new and is what makes a unit
*actionable* rather than merely reported.

**Lifetime.** `review` lives on `ingestion_runs`, and `purge_ingestion_evidence`
does **not** touch it — verified: 0026's purge clears `source_text`, `error`,
segments, results and ledgers, and never mentions `review`. So unresolved units
outlive the 30-day diagnostic window, exactly as required, while the evidence
they point at expires on schedule. The `offset`/`len` remain meaningful for
provenance even after the source text is purged; the `text` copy is what keeps
the unit actionable.

## 2. Creator-visible — extend, don't build

`ImportProgress` already shows a `needs_review` panel. It gains a list: one row
per unresolved unit, showing the item it belongs to and the source text
verbatim, so the decision is made **in context** rather than from a count.

Wording target: *"FlowGuide organized this item, but there is source information
that needs your decision."*

## 3. Resolution is a human choice

Four actions, none of them automatic:

- **incorporate into Description** — the creator edits; FlowGuide inserts nothing
- **add as a Detail** — creator supplies the label
- **make it a Private Note** — deliberate, and now the *only* way prose becomes private
- **Ignore** — explicit, recorded as `ignored`, never silent

FlowGuide picks none of these to clear an exception. That is the whole point:
the model choosing `notes` and FlowGuide choosing `description` are the same
error wearing different clothes.

## 4. What it blocks

Items **materialize normally** — finalize is unchanged, and other records in the
same import are unaffected. What is held is **publishing**, through the existing
0013 trigger, until every unit is `resolved` or `ignored`.

**Stated plainly:** this is packet-level, not item-level. A packet with one
unresolved item cannot be published. True per-item "complete" state would need a
column on `items` and a migration, and I am not proposing that here — the
existing gate already prevents an item silently appearing fully accounted-for,
which is the property that matters. If you want strict per-item granularity, say
so and it becomes a migration.

## 5. The write path — one open choice

Setting `status` needs a write. Two options:

- **A. Route + service-role, ownership-checked.** No migration. Consistent with
  how the Library review screen saves proposals.
- **B. An RPC** (`set_review_unit_status`), consistent with how *run* mutations
  are done elsewhere. Needs a migration, which would take **0027** and push photo
  normalization to 0028 again.

I lean **A**: it is smaller, and this is a status field on a jsonb the app
already owns, not a lifecycle transition.

## 6. Control test to add

An injected model result that deliberately puts ordinary recipient prose into
`notes`, proving: rejected · not lost · not auto-placed into Description ·
persisted as an unresolved unit on the correct record · still visible after
reload · cleared only by an explicit resolve or ignore.

The live ice-cream run produced `privacyRejected: 0` because the prompt fix
worked, so this path needs a deliberate control rather than a hopeful one.

## Not in this patch

The first-class reusable public narrative/content type. These units are the
honest interim: the content is preserved, attached, visible, and awaiting a
decision — rather than being placed somewhere convenient.

## RPC invariants (added before apply)

**Security.** `SECURITY DEFINER` with `search_path = ''` and every object
schema-qualified. `EXECUTE` is revoked from `PUBLIC` explicitly — that is the
grant that matters, since a new function grants it by default and every
authenticated visitor inherits it — then from `anon` and `authenticated` by
name, and granted only to `service_role`. Preflight row 18 confirms this
matches every other ingestion lifecycle function rather than inventing a posture
for one function.

**`p_owner` is not a credential.** It is an assertion the caller must already
have earned. The route MUST derive it from the authenticated session and MUST
NOT accept an owner id from the request body — otherwise resolving anyone's
review reduces to guessing a uuid. The function does the half it can: it refuses
when the run does not belong to the owner passed. This is a standing constraint
on the route that has not been written yet, and the route's own gate must assert
it.

**Mutation contract.** `p_status ∈ {resolved, ignored}`. The run must be in
`needs_review`. A unit id must match exactly one unit: zero raises not-found,
and duplicates raise rather than mutate one of two units the caller cannot tell
apart. An already-handled unit is idempotent, never overwritten by a stale
client. Unrelated units and unrelated `review` keys pass through untouched, and
array order is preserved.

**Legacy failures.** Entries written before `status` existed have no such key.
Every unresolved test reads `coalesce(f->>'status', 'unresolved')`, so a legacy
unit counts as outstanding. The opposite reading would silently finalize a run
with real work still in it — absence reading as success, again.

**Last-unit transition.** Only at zero remaining, in one `UPDATE`: status
becomes `finalized` (the run had already applied its content before entering
review), `finalized_at` is stamped with `coalesce` so an earlier stamp is not
clobbered, `review.ok` becomes true and the stale failure `summary` is cleared
so the JSON cannot read "failed" while the run reads finalized. The publish
block and the one-active-run index both key off `status`, so both clear in that
same transaction.

**Retention.** `text` is removed on resolve *and* on ignore; id, code, item
reference, status and `resolved_at` remain.

**Blast radius.** The function mutates `ingestion_runs` and nothing else. A
source gate enumerates every table named in an `UPDATE`/`INSERT`/`DELETE` and
fails if the set is anything other than `{ingestion_runs}`.

### Where each invariant is proven

| Gate | File | When |
| --- | --- | --- |
| Statically provable from the SQL text | `scripts/sql/0027-source-gates.py` | before apply |
| Environment preconditions | `scripts/sql/0027-preflight.sql` | before apply |
| Catalog security posture | `scripts/sql/0027-verify.sql` part A | after apply |
| Behaviour against a fixture run | `scripts/sql/0027-verify.sql` part B | after apply |

Part B calls the function for real and asserts what it did. It is
`BEGIN … ROLLBACK` with no `COMMIT`, so the fixture leaves nothing behind.
There is no local Postgres on this machine and no Docker, so behavioural
verification cannot run before the function exists on the linked database —
which is why the statically provable invariants were pulled forward into a
separate source-gate pass rather than waiting for it.

## Applied — 2026-08-21

`0027_resolve_review_unit.sql`, sha256
`948aab0b5cc647c7996f68f793f3729fbb56f4bfdd06fc26484796263c221640`, pushed
through the linked Supabase CLI. History shows `0027` in both Local and Remote;
`db push --dry-run` reports the remote database up to date.

`scripts/sql/0027-verify.sql` — **36 PASS / 0 FAIL**, then confirmed from
*outside* its own transaction that no fixture run survived the rollback.

Two verifier expectations were wrong on first run and were corrected, not the
schema: `pg_get_function_identity_arguments` carries parameter names, so it can
never equal a bare type list — the argument types are the identity, and that is
what is compared now; and Postgres stores the empty pin as `search_path=""`,
which is asserted exactly, because merely finding the word `search_path` would
also accept `search_path=public`.

Rows 35–36 prove the grant by EFFECT: the verifier becomes `authenticated`, then
`anon`, and calls the function. Both are refused. An ACL that reads correctly and
a call that is actually refused are different claims.

Production smokes after apply: post-deploy 10/10, Library v1 20/20, first-use
22/22, every one cleaning up its own disposable data.

## The app-side path, built 2026-08-21

Enforcement remains OFF for normal traffic.

**Which units block.** Only `privacy-rejected`. That unit is content the model
tried to route into a private field with no authority from the source, so
publishing without a decision means a recipient silently never sees something
the source said. `source-unresolved` is a value the reconciler could not bind to
a claim; it stays in the fact ledger with the other evidence. Blocking on it
would put nearly every import into review and teach people to click through the
block, which is worse than not having one.

**Media failures keep their own exit.** A missing photo is not a decision these
controls can make, so it is not given a Resolve button. Because the RPC counts
any failure lacking `status` as outstanding, a run carrying one can never be
cleared unit-by-unit and still exits only through discard - exactly today's
behaviour. That is a fail-closed boundary, not an oversight, and `Discard
import` stays the primary action whenever such a blocker is present.

**Two decisions that deserve a second look**

1. *Finalize now reads `ingestion_chunks.fact_ledger`.* The ledger was built
   observe-only, with a source invariant asserting it had no reader at all.
   Unresolved units are produced per chunk and consumed once per run, and the
   ledger is the only per-chunk channel that already exists - so finalize reads
   `unresolved` from it and nothing else, and never writes to it. The invariant
   was NARROWED to say exactly that rather than deleted. If units ever earn a
   column of their own, the exception should go with that migration.

2. *The summary sentence is derived live in the panel.* `review.summary`
   describes what finalize FOUND. Once decisions start landing it is history,
   and leaving it up meant the banner read "2 pieces" above a list of one. The
   stored sentence still speaks for blockers these controls cannot clear.

**A pre-existing bug this surfaced.** `GET /api/ingest/:runId` selected `review`
from the database and never returned it. Every reload of a held run therefore
dropped the summary and the exit sentence, and would have dropped the units
themselves. Fixed here; a panel that cannot say what it is holding, after the
one event most likely to bring someone back to it, reads as a malfunction.

**Proof.** `scripts/ingestion-runtime/proof-review-units.mts` - 34 PASS / 0 FAIL.
Phase 1 runs the real enforcement chain in-process; phase 2 drives the real
finalize route, RPC, resolve route and publish gate against a disposable packet.
The model is deliberately not in the loop in phase 2: a proof of the persistence
and resolution path must not be able to fail because a provider had an off day.
What phase 2 does NOT cover is how often a model actually proposes an
unauthorized private placement - the flagged-enforcement proof measured that.

Verified in the browser as well: the panel lists both units with their verbatim
text, a decision clears one and leaves the other, a full reload preserves what
remains, and the last decision removes the panel and unblocks Publish.

## 0028 — the dedicated channel, applied 2026-08-21

`0028_chunk_review_units.sql`, sha256
`a7bd2719ef3d30ce80dc4d49333758124c1d43363da64a2009e8570d65b25d52`. History
shows 0028 in both Local and Remote; `db push --dry-run` reports up to date.

**Structural verifier** — 16 PASS / 0 FAIL, `BEGIN … ROLLBACK`. Part B makes the
clearers actually run: a chunk holding ONLY `review_units` (result, segment and
ledger all null - invisible to the pre-0028 purge predicate) is cleared by
`purge_ingestion_evidence`, and `library_close_import_run` clears it too.

**The channel, through the LIVE route** — 16 PASS / 0 FAIL. Units are written by
the real chunk route with stable ids, record provenance and verbatim text;
finalize aggregates them BY ID; observed-only telemetry never appears as a
question; publishing is blocked until they are decided.

**The decoy.** `proof-review-units.mts` plants a unit in `fact_ledger.unresolved`
that exists nowhere else and asserts it never reaches the run's review. Source
scanning proves nobody typed `fact_ledger`; the decoy proves nobody reads it.
37 PASS / 0 FAIL.

### Why the live proof needed a forced proposal

The first live run produced no units at all — and the honest diagnosis was
MODEL, not wiring: enforcement governed 4 items and rejected nothing, because
the NOTES_RULE prompt fix means the model no longer routes recipient-intended
prose into the private field on demand.

That is good product behaviour and a bad test dependency. The behaviour the
semantic contract exists to catch cannot be summoned from the provider, which is
the same reason `test-faults.ts` already exists for retries, truncation and
wrong shapes. A `privateNote` fault was added there, applied to the REAL model
result so it travels the real validation, enforcement, staging and finalize
path, and held to the same inertness rule as every other fault: production-inert,
opt-in key required, guarded at the call site by a literal NODE_ENV comparison
so the branch is eliminated from the production build. Seven tests pin that.

The proof now reports its own diagnosis rather than just failing: it prints
`privacyRejected` and `itemsGoverned` alongside the unit count, so "the wiring
broke" and "the model behaved this run" can never be confused again.
