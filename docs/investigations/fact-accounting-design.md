# Semantic reliability, fix 1 — fact accounting

Design only. **Nothing implemented, nothing applied.** Bounded to the two
failure classes Corpus v2 proved. It does **not** address the production
misclassification symptom, which has not been reproduced.

## The principle

Today the model is the only thing standing between a fact in the source and a
fact in the output. If it drops one, nothing notices. Every proposed mechanism
below exists to move responsibility off the model — not by asking it to try
harder, but by **counting**.

This codebase already contains the pattern, and its own comment states the case:

> *Counting is the only defense against a silent loss — a check that fires on
> absence, not on a malformed value.* — `media-ledger.ts`

It also contains the warning that shapes the response:

> *Website and reference links may legitimately be normalized, deduplicated or
> omitted by the model, so holding them to exact accounting would block imports
> for non-failures.*

So: account for everything detectable, but **surface** what is unaccounted rather
than blocking on it. A false positive must cost a professional a glance, never an
import.

---

## 1. What can be extracted deterministically, before the model

High precision by shape, no judgement required:

| kind | pattern | v2 loss rate |
|---|---|---|
| **key/value line** | `^Label: value$` | — the container for most of the below |
| **money** | `$1,234`, `$4,720/month` | low on its own |
| **range** | `$A to $B`, `$A–$B`, `between $A and $B`, `ranges from A to B` | **87%** |
| **phone** | NANP | 0% |
| **email** | RFC-ish | 0% |
| **url** | `https?://…` | 0% |
| **percentage** | `12%` | untested |

**Detection is deterministic for all of these. Destination is not.** The one case
where both are deterministic is the `Label: value` line: the source has literally
named the label, and `details` is a `{label, value}` container. Nothing needs to
be inferred.

That matters because it is also the highest-volume case, and — from the
production evidence — the one that failed there.

**What must stay with the model:** which prose is a description, which is a
private note, which person a phone belongs to, what the title is. Those are
judgement, and this design does not try to take them.

## 2. Provenance representation

A **fact ledger per chunk**, computed at stage time and stored beside the result
that 0024 now preserves:

```
ingestion_chunks.fact_ledger jsonb
```

```jsonc
{ "detected": [
    { "id": "c3:1180:range",           // chunk : offset : kind — stable, addressable
      "kind": "range",
      "text": "$600 to $2,400",
      "line": "Level of care pricing ranges from $600 to $2,400 per month…",
      "label": null,                    // set for Label: value lines
      "status": "unaccounted" }         // accounted | unaccounted | repaired
  ],
  "counts": { "detected": 24, "accounted": 21, "repaired": 2, "unaccounted": 1 } }
```

One column, mirroring how 0013 stores media accounting in `ingestion_runs.review`.
It inherits the same RLS posture and the same 30-day expiry, and `origin_*` on
`library_items` already points at the chunk — so a saved entry can be walked back
to the ledger that judged it.

## 3. Detecting that the model dropped a fact

After `processSegment` returns a validated result, reconcile: for each detected
fact, is its normalised value present anywhere in the result JSON?

Normalisation must tolerate legitimate reformatting — `$4,720/month` and
`$4,720 per month` are the same fact. The corpus scorer already does exactly this
and has been hardened twice against its own false positives (a name matching
inside its own domain; a two-digit number matching inside a postcode). **That
code is reused, not rewritten** — and it means the reconciler arrives with known
failure modes rather than fresh ones.

Reconciliation is **presence-based, not placement-based**: a fact found anywhere
counts as accounted. Misplacement is a different failure class and is out of
scope here.

## 4. When a fact is detected but has no confident destination

Two tiers, by how much judgement is required.

**Tier 1 — deterministic repair.** A `Label: value` line whose label is absent
from the output's details is inserted verbatim as `{label, value}`. The source
named the label; `details` is a label/value container; there is nothing to infer.
Recorded as `repaired`, so a repair is never invisible.

**Tier 2 — surfaced as unresolved.** Everything else — ranges in prose,
qualifiers, conditional fees — is attached to the proposal and shown in the
review step:

> *3 facts from this record weren't placed.*
> *"Level of care pricing ranges from $600 to $2,400 per month"*
> **[ Add as a detail ] [ Add to notes ] [ Ignore ]**

This is the design's centre of gravity, and it is cheap because the review layer
already exists, is durable, and is where human judgement already belongs. The
model is allowed to drop a fact; the ledger catches it; a professional decides.

**Nothing blocks the import.** Per the media-ledger warning, a detector that can
false-positive must not be able to stop work.

## 5. Fields that must be source-backed only

A validator, not a prompt instruction — verify the output rather than ask for
good behaviour:

| field | rule |
|---|---|
| `links[].url` | the URL must appear literally in the segment |
| `photos[].url` | must appear literally |
| `contacts.website` | must appear literally |
| `contacts.email` | must appear literally |
| `contacts.phone` | digits must appear in the segment |

Anything failing this is **stripped from the result and recorded**, not passed
through.

This kills the reproducible fabrication v2 found directly: B2 has no website, and
a website was synthesised in all three runs — almost certainly from the contact's
email domain. `example.com` never appeared as a URL in that segment, so the rule
removes it without needing to know how it was invented.

Deliberately **not** included: `address` and `title`. Both are legitimately
reformatted and normalised, and holding them to literal presence would produce
exactly the false-positive class the media ledger warns against.

## 6. Thresholds that block deployment

Measured on Corpus v2, three samples, against the v2 baseline. **The metric
changes from *correctly placed* to *accounted for*** — a fact surfaced as
unresolved counts as accounted, because that is the stated goal.

| metric | v2 baseline | gate |
|---|---|---|
| ranged accounted | 12.8% | **≥ 95%** |
| prose accounted | 82.3% | **≥ 95%** |
| qualified accounted | 92.6% | **≥ 98%** |
| simple accounted | 99.2% | **≥ 99%** — must not regress |
| FABRICATED | 3 | **0** |
| MISCLASSIFIED | 0 | **0** — must not regress |
| overall accounted | 93.0% | **≥ 98%** |

Plus, because this touches code shared with packet ingestion:

- **Corpus v1 must not regress** below 96%.
- **The seg-v4 incident proof must stay 21/21.**
- **Detector precision ≥ 98%** on both corpora — a detector that cries wolf will
  train professionals to ignore the unresolved list, which is worse than not
  having one.

## Minimum implementation path

Six steps, each measurable and independently reversible. **Steps 1–3 change no
behaviour at all.**

| # | step | risk |
|---|---|---|
| 1 | `fact-ledger.ts` — pure detection + reconciliation, unit-tested offline against both corpora with **no model calls** | none |
| 2 | `source-backed.ts` — pure validator, unit-tested | none |
| 3 | one migration: `ingestion_chunks.fact_ledger jsonb`; wire the ledger in **observe-only** — computed and stored, acts on nothing. Run the corpus to measure detector precision and recall against known ground truth | schema only |
| 4 | enable Tier-1 deterministic repair | low |
| 5 | enable Tier-2 unresolved surfacing in review | UI |
| 6 | enable the source-backed validator | low |

Step 3 is the important one: it produces the precision and recall numbers on
ground truth **before** anything depends on the detector. If precision is poor,
that is discovered while the ledger is inert.

Migration numbering is assigned at application time, not reserved in advance —
0024's experience showed a reserved number just has to be explained later.

## What this deliberately does not do

- It does not address **misclassification**, the production symptom. Corpus v2
  produced zero, so there is nothing here to design against yet, and the next
  real import will preserve the evidence needed.
- It does not change prompts, routing or the schema of item content.
- It does not make the model more reliable. It makes the model's failures
  **visible**, which is a different and more achievable goal.
