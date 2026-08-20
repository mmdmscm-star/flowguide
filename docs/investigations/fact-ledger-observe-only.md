# The fact ledger, observe-only — Steps 1–3 results

*2026-08-20. Nothing in this document has been applied to Supabase. The
migration is written and proven in-repo; it awaits step-by-step approval.*

## What was built

Three pure pieces and one inert wiring.

| Piece | File | What it does |
|---|---|---|
| Matching | `src/lib/fact-match.ts` | The single hardened implementation, shared by the ledger and the corpus scorer so they cannot drift |
| Detection + reconciliation | `src/lib/fact-ledger.ts` | Finds shaped facts in a segment; marks each accounted or unaccounted against the model's items |
| Fabrication control | `src/lib/source-backed.ts` | Finds URLs, emails and phones in output that are not in the source |
| Wiring | chunk route + migration 0025 | Writes the ledger to `ingestion_chunks.fact_ledger`. Nothing reads it |

## Detector precision and recall

Measured offline by `scripts/ingestion-runtime/measure-detector.mts` — no model
calls, no database.

| | Corpus v1 | Corpus v2 |
|---|---|---|
| Ground-truth facts | 230 (132 in scope) | 377 (265 in scope) |
| Detected | 154 | 357 |
| **Precision** | **100.0%** | **100.0%** |
| **Recall (in scope)** | **99.2%** | **100.0%** |

The approved gate was ≥98% precision on both. The first measurement did not
meet it — v2 scored 93.0% — and **all three causes were mine, not the
detector's**:

1. **The corpora under-declared their own facts.** Both sources contain contact
   email addresses that the ground truth never listed (`bea@`, `chris@` in v1;
   the second contact of every v2 clone; `ivy@` in v2's hand-written record).
   The detector found real facts and was scored wrong for it. 16 of the 23 v2
   false positives were this. *The earlier v2 correctness baseline of 93.0% was
   therefore computed over an incomplete fact set.*
2. **A sentence lead-in was being read as a field label.** `Notes from the tour
   on 4 March: the dining room was busy…` is literally `Label: value` shaped.
   A genuine detector weakness — see *The label rule* below, because the first
   fix for it was wrong.
3. **Precision was being scored against the in-scope subset.** In-scope
   filtering says what the detector is *required* to find; it says nothing about
   what is *real*. Detections matching genuine out-of-scope prose facts were
   being counted as false positives — the detector was penalised for exceeding
   its own remit. Precision now scores against the whole ground truth; recall
   still scores against the in-scope subset.

### The label rule, and the fix that was overfitted

The first fix banned digits from labels. It reached 100% precision on both
corpora — by silently dropping facts neither corpus happened to contain.
`2nd Person Fee`, `Level 2 Care`, `24-Hour Support`, `Studio 1` and `Room 214
Monthly` are labels professionals genuinely type, and that rule would have lost
every one of them while reporting a perfect score. A number bought that way is
worse than a lower number, because it hides the loss it caused.

**Digits are not the signal. Grammar is.** A label is a short noun phrase; a
lead-in is a clause, and clauses carry determiners and verbs that labels do not.
Two independent tests, either sufficient to reject: more than five words, or a
**lowercase** determiner/auxiliary (`the`, `was`, `is`). The lowercase
requirement is load-bearing — `Care Level A` and `Building B` are real labels,
and a case-blind stop-word test would eat them.

Proven against `scripts/ingestion-runtime/fixtures/label-shapes.mts`, a fixture
built for this question and deliberately kept out of v1/v2 (those are joined to
persisted model runs; adding records would move chunk boundaries and invalidate
the join):

```
LABEL SHAPES — 31 lines
  real labels kept ............ 23/23  (100.0%)
  digit-bearing labels kept ... 8/8
  prose lead-ins rejected ..... 7/8  (87.5%)
```

**The one leak is declared, not curated away.** `One thing to remember:` is four
words with no determiner and no verb — grammatically it *is* a label. Fixing it
means adding `to` to the marker set, which breaks `Fee for Second Person` style
labels for a rarer case. It is left detected, with a test pinning it so the
tradeoff is revisited deliberately rather than drifted into. Its cost is bounded:
a spurious unresolved entry, never a lost fact.

**The one honest miss.** A fee written as `six thousand dollars` is not found.
The detector matches *shapes*, and a number spelled in words has none. This is
recorded as a limitation rather than papered over.

## What the ledger would have caught

`scripts/ingestion-runtime/measure-ledger-catch.mts` joins the detector to the
three persisted corpus v2 runs — real model output, no new calls.

```
LOST outcomes ............... 68  (26 distinct facts)
LEDGER WOULD FLAG ........... 25/26  (96.2%)

  by shape                        by expected destination
    ranged      12/12  100%         details   25/25  100%
    prose        9/10   90%         notes      0/1     0%
    qualified    4/4   100%
```

**Ranged values — the shape that scored 12.8% in corpus v2 — are caught 100% of
the time.** The failure the investigation set out to explain is the failure the
ledger sees best.

The single silent loss is `waitlist for memory care`, a fragment of a prose
note. It is out of scope by design.

Of the 25 flagged losses, **14 are Tier-1 eligible** under the refined rule: a
detected key/value fact with no more specific source-backed destination that is
otherwise missing from output. The other 11 fall to Tier-2 — surfaced, never
auto-placed. `details` is not being used as a universal sink: a value that
probes as a URL, email or phone is never Tier-1 eligible.

**The bound worth stating.** This inference holds for LOST facts, which are
absent from output by definition. It says nothing about MISCLASSIFIED facts —
those are present, just in the wrong field, and the ledger is silent on them by
design. Corpus v2 scored MISCLASSIFIED = 0, so nothing hides in that gap *here*.
The production symptom that started this investigation was field placement, and
a ledger built on presence will not see it. That is a real limit, not an
oversight, and Steps 4–6 must be designed knowing it.

## Inertness

`src/lib/fact-ledger-wiring.test.mts` asserts, against the source itself:

- `fact_ledger` appears in exactly one application file and is only ever written
- nothing outside the chunk route imports `fact-ledger`
- the ledger runs *after* the staging failure guard, so an unstaged chunk never
  gets one
- the write sits inside a `try`/`catch` with no throw, no early return and no
  status change between it and the route's success response
- the write is guarded on the claim generation, like every other chunk write
- **every live SQL function that clears chunk evidence also clears the ledger**
- purge treats a ledger-only chunk as still holding evidence

## The ledger is evidence

It stores verbatim fragments of the professional's source text — contacts,
pricing, private notes. It is held to the same rules as `segment_text`.

Four live functions clear chunk evidence. A ledger left behind by any one of
them would outlive the source it quotes: a discarded import would wipe the
source and keep the quotations. 0025 re-issues all four with `fact_ledger =
null` added to their existing clearing statement and **nothing else changed** —
each body extracted programmatically from the migration that last defined it,
with a diff proving one line per function.

A test proves the negative directly: strip the ledger additions back out of
0025's bodies and what remains is byte-identical to the definition live today.
`finalize_ingestion_run` composes sections and items; `library_close_import_run`
ends a Library import. Re-issuing them is exactly where a recipient-facing or
saved-Library change could slip in, so it is proven rather than asserted.

## Incidental finding — not fixed here

`finalize_ingestion_run` (the **packet** path) still clears every segment and
result on success. 0024 stopped that for the Library path only. A packet import
therefore remains undiagnosable after it finishes. This is recorded, not acted
on: it is outside the approved scope and would be a production behaviour change.

---

## Deployed, and proven at runtime — 2026-08-20

0025 verified clean in Supabase: **33 pass, 0 fail, 2 info**. The application
wiring is deployed. `scripts/ingestion-runtime/proof-fact-ledger.mts` — real
routes, real segmentation, real model calls, real database, disposable user,
cleanup verified by id — passes **15/15 in production**.

```
ledger totals on a real 2-record import: {"detected":16,"accounted":13,"unaccounted":3}
```

**How inertness is proven.** Not by re-running and diffing: the model is not
deterministic, so two runs of the same paste differ for reasons unrelated to the
ledger. Instead the stored ledger is **recomputed offline from that chunk's own
`segment_text` and `result`, and must match exactly**. A value reproducible from
(segment, result) alone cannot have influenced either of them — it observed the
output, it did not shape it. A cross-chunk control confirms the binding
discriminates: the same ledger must *fail* to reproduce against a different
chunk's segment.

Alongside that: every proposal traces to a title in the model's own staged
result, no ledger field appears in any proposal payload or saved Library entry,
and finalize retains the ledger unchanged beside the 0024 evidence with the
expiry stamped.

### Three defects the proof found — all mine

1. **jsonb does not preserve key order** (it sorts by length, then bytewise), so
   a raw `JSON.stringify` comparison called every chunk a mismatch. Both sides
   are canonicalised now.
2. **Proposals materialize on an explicit POST** the proof never made.
3. **Two selects named columns that do not exist** (`chunk_ordinal`, `content`).
   PostgREST returns an *error object*, not an exception — so discarding it
   turned a typo into "zero rows", which surfaced as three phantom failures and
   would just as easily have been three vacuous passes. Every read now goes
   through a helper that throws.

That last one is the same shape as the verifier's row 52, which passed while
exercising nothing. **Absence reads as success unless a check is built to
notice.** Both are now guarded by asserting the fixture size inside the
comparison.

### Production smokes

`smoke-post-deploy` 10/10, `smoke-library-prod` 20/20, `smoke-firstuse-prod`
21/21. The first run of the last one showed one failure — a race in the *smoke*,
where an earlier anonymous page load's fire-and-forget `viewed` write landed
after the test's reset. Green twice on re-run; the smoke now settles and asserts
its precondition. This deploy changed exactly one runtime file, the chunk route.
