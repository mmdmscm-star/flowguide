# Deploy package — Library AI import

**Prepared, not pushed.** The runtime proof exposed two defects in *existing*
production code, so what ships is no longer only the new feature. That is worth
a decision rather than an assumption.

| | |
|---|---|
| Rollback point | `3e95889` — redeploy from the Vercel dashboard |
| Commits since | 8 (`aab4e45` → `80402ab`), fast-forward |
| Database | 0020, 0021, 0022 **already applied and verified** — this deploy adds no schema |
| Unit tests | 353 pass |
| Runtime proof | 35/35, disposable data only, cleanup verified by re-query |
| Lint | 2 errors / 14 warnings — unchanged pre-existing baseline |

## What ships

**Library → Import with AI.** Paste → chunked resumable extraction → durable
proposals → review/edit/select → save selected → finish or abandon. No FlowGuide
is created at any point.

The claim/lease/stage/split engine is shared with packet ingestion, unchanged.
`library_import` reuses the items-only prompt and result shape `section_append`
already had, so there is no second prompt and no second content model. Every
saved entry goes through `library_save_proposal`, which creates the
`library_items` row and consumes the proposal in **one transaction** — there is no
window in which an item exists and its proposal still does.

Also shipping: `+ Create an item` and `Import with AI` in the Library, and the
three-way empty state.

## The two defects the proof found

Both are in code shared with packet ingestion. Neither was found by reasoning.

**1. `splitRange` could produce a one-character child.** Boundary preference
outranked placement with nothing requiring the cut to actually divide the range,
and the blank line separating one record from the next sits at the range's edge.
An oversized record followed by a blank line — every oversized record in an
ordinary paste — split into a head barely smaller than the parent and a tail of
one character. The tail reached the model as whitespace (`messages: at least one
message is required`); the head split the same way again, so the import failed.

This affected **packet imports identically** and has presumably been live since
0012. The same input that produced 11704 / 1 now produces 5853 / 5852.

**2. Both drive loops treated a transient provider failure as terminal.** The
server already recovered correctly — marking the chunk failed and tagging it
`[transient]` so the next attempt retries the same segment instead of
subdividing — and both clients discarded that recovery. The rule now lives once,
in `chunk-outcome.ts`, keyed on the `permanent` flag the server computes rather
than on client-side status sniffing, and `useIngestion` uses it too.

**Why this matters for the deploy decision:** fix 1 changes how *packet* imports
split oversized records. It is a strict improvement and it is covered by the
packet regression in the runtime proof, but it is a change to a proven path that
was not part of what was approved.

## Runtime proof — 35/35

Real HTTP routes, real segmentation, real model calls, production database,
disposable users only.

| Covered | |
|---|---|
| Real chunked extraction | 3 chunks, driven through the live model |
| Forced split | natural presplit on an oversized record — no fault injection |
| Source ordering | split children carry higher ordinals but sort mid-source; asserted to differ from ordinal order |
| Reconnect mid-extraction | open run discoverable with no pasted text, then resumes |
| Reconnect mid-review | edit and selection restored exactly |
| Materialisation idempotency | second call inserts 0, reviewed edit untouched |
| Save | through `library_save_proposal`; proposal consumed; retry creates no duplicate; no packet lineage |
| Finish protection | refuses while a selected proposal is unsaved, names the count, completes on acknowledgement |
| Abandon | requires its own confirmation; run discarded; a new import can start immediately |
| One active import | different paste refused and names the open run; same paste reconnects |
| Packet regression | Organize → drive → finalize still produces sections and items |
| Cleanup | 0 rows remaining, verified by re-query |

## Post-deploy smoke

`scripts/ingestion-runtime/proof-library-import.mts` runs against any origin.
After deploy, run it with `FLOWGUIDE_BASE_URL=https://flowguide-ruddy.vercel.app`.
It creates only disposable users and verifies its own cleanup.

## Not in this release

Block-mode Library insertion (a composition project). No categories, groups, tags
or Library expansion of any kind. `SEGMENTER_VERSION` is deliberately **not**
bumped: it versions the chunk *plan*, which `splitRange` does not affect, and
bumping it would invalidate in-flight runs for no reason.
