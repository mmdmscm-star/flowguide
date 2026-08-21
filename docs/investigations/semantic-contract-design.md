# Semantic contract enforcement — design

*Design only. Nothing implemented. 2026-08-20.*

> **The model may propose semantic placement; FlowGuide must enforce the
> semantic contract.**

## What the evidence forces

The Bluffs at Hamilton Hills, chunk 6, idx 0, byte-identical input: run 1 placed
Type, Capacity, Community Fee, Second Person Fee and Care Costs in `details`;
run 2 placed all five in the private note. Placement is **probabilistic**, and
the unit of variation is the **record**, not the fact — records come out
mostly-clean (`7d/0n`) or mostly-diverted (`0d/5n`), rarely mixed.

A prompt rule cannot fix a coin flip. It can only change the odds. Anything that
must always be true has to be checked after the model, not requested before it.

Two defects, deliberately kept apart:

| | behaviour | fix class |
|---|---|---|
| **Record-level placement instability** | whole label block diverted to `notes`, varies run to run | enforcement |
| **Long-prose value loss** | `Care Costs: Additional monthly fee…` dropped entirely, **reproducibly in both runs** | deterministic repair |

The second is not a coin flip. Vine Ridge, The Vincent and Pine Ridge Terrace
lost it in both runs. It is the cheapest real win available.

## Architecture — three stages

```
   SEGMENT ──▶ [1] CLAIM ──▶ [2] PROPOSE ──▶ [3] RECONCILE ──▶ proposal
             deterministic     model          deterministic
             (pre-model)     (unchanged)      (post-model)
```

**[1] Claim.** Parse the segment for what it demonstrably contains: explicit
`Label: value` lines, URLs, emails, phones. This is `fact-ledger.ts`, already
built and measured at **100% precision / 99–100% recall** on both corpora. The
claim set is computed *before* the model runs and does not depend on it.

**[2] Propose.** Unchanged. The model keeps the work it is genuinely needed for.

**[3] Reconcile.** Every claim is resolved to exactly one of:

- **ACCEPTED** — landed where the contract says
- **REPAIRED** — moved deterministically to where the contract says
- **UNRESOLVED** — no deterministic destination; surfaced to the professional

Counted, never silent. `accepted + repaired + unresolved = detected`, asserted.

A fourth outcome applies only to fabrication: **STRIPPED**, for source-backed
fields whose value is not in the segment.

## The contract

### Class A — deterministic destination. Enforce.

| claim | destination | note |
|---|---|---|
| URL, image extension | `photos` | source-backed only |
| URL, map host | `links`, label "View on Map" | |
| URL, other | `links` | |
| email | `contacts.email` | *which* contact stays model's call |
| phone | `contacts.phone` | same |
| `Label: value`, value is **scalar** | `details` | ≤6 words, no clause verb |

97 of the diagnostic's labelled facts are Class A. Replaying enforcement over
the two captured runs collapses run-to-run destination flips from **8 to 1**,
and the survivor is a prose value — out of Class A by construction.

### Class B — recipient-visible required, destination open.

`Label: value` where the value is a **paragraph** (Atria's 989-character
explanation of why published pricing varies). The contract can state that this
must reach the recipient. It cannot yet state *where*, because no field fits —
see *Content model* below. Until that is resolved these are **UNRESOLVED**, not
forced into `details`.

**`details` is not the fallback.** A label/value row renders a paragraph badly,
and the professional was explicit that another vertical may legitimately want
narrative carried with the structured facts.

### Class C — model judgment. Not enforced.

Entity boundaries · titles · descriptions · which contact owns which phone ·
detail ordering · label normalisation (`Community Fee AL` from a merged cell) ·
recognising that a line is a room type rather than a field. These are the
reasons the model is here at all.

### Class D — requires source authority.

`notes` is populated **only** from source text carrying an explicit privacy
marker (`private`, `internal`, `do not share`, `confidential`, or a column the
professional designates). The diagnostic spreadsheet contains **no such marker
anywhere** — all 53 "private" matches are room types — so under this rule every
one of the 31 historical notes would have been rejected.

Two sub-cases:

- note content that **matches a source claim** → re-placed per its own class
- note content that is **model-generated prose** (The Bluffs run 1: *"Designed
  to foster connection, comfort and purpose…"*) → **not accepted**. The
  accounting guarantee covers *source facts*; it does not oblige us to keep
  model inventions in a private field.

## Content model — where reusable narrative lives

**Recommendation: a new first-class, recipient-visible item field.** Staged
*after* the deterministic core is proven, not bundled with it.

Why the existing fields do not work:

- **`description`** is *what this place is*. Atria's paragraph is *how to read
  the other numbers*. Merging them means no renderer can treat them differently
  and the professional cannot remove one without the other.
- **`details`** is `label` + `value`, rendered as a row. A paragraph in a value
  cell is a layout failure, and forcing it there is exactly the "universal
  fallback" the professional ruled out.
- **`notes`** is private. That is now load-bearing.

Cost, stated honestly: a migration, editor UI, the Library payload, ingestion
validation, the save-back diff, `library_canonical_*`, and every renderer. It is
not small, which is why it should follow rather than lead.

**Interim:** Class B claims surface as UNRESOLVED. The review state is the
honest temporary home — the professional decides, and nothing disappears.

## Care Costs — the separate, deterministic track

Reproducible in both runs: a labelled value of moderate length and prose form is
dropped entirely. Both label and value are known from source, so repair is
mechanical: reinsert as a detail, verbatim.

The boundary between "prose value that belongs in `details`" and "paragraph that
needs the narrative field" is a length/structure heuristic, and heuristics at a
boundary are where silent damage happens. So: a value under a stated threshold
repairs into `details`; above it, UNRESOLVED. The threshold is a tunable with a
review escape, never a silent truncation.

## How this uses what already exists

- **0024 evidence retention** keeps `segment_text` and `result`, so
  reconciliation can be **recomputed and audited after the fact**, and so
  single-record retry becomes possible later without re-pasting anything.
- **0025 `fact_ledger`** becomes a **reconciliation ledger**: claims, their
  placement, and their outcome. This is the necessary complement — the fact
  ledger answers *is it present*, which is structurally blind to `details →
  notes`, the exact production symptom. `placement.ts` already computes
  `locate()`, `hiddenFromRecipient` and a prompt-derived contract, with 12 tests.
- The ledger stays evidence: same retention window, same purge, service-role only.

## Deployment gates

| gate | measurement | threshold |
|---|---|---|
| placement stability | 3 runs of the 20-record paste; identical recipient-visible placement for Class A claims | **100%** |
| no unauthorised privacy | Library-import facts landing in `notes` without a source privacy marker | **0** |
| accounting completeness | `accepted + repaired + unresolved == detected` for explicit labelled facts | **100%** |
| fabrication | unbacked source-backed field values | **0** |
| no regression | corpus v1/v2, seg-v4 proofs, production smokes, full unit suite | all green |

Detector precision must also hold at **≥98%** on v1, v2 and the label-shapes
fixture, or the unresolved list trains professionals to ignore it.

## Minimum sequence to prove the approach

Steps 1–2 require **no production change and no model calls** — they replay
against the preserved run 1 / run 2 evidence.

1. **Reconciliation ledger, observe-only.** Extend the chunk ledger with
   placement outcomes. Inert, as 0025 was.
2. **Encode the contract + tests**, and replay it offline over the captured
   evidence. Report: flips before/after, repairs, unresolved, and every Class B
   case by name. **This is the gate. If it does not converge the two runs here,
   the design is wrong and nothing ships.**
3. **Enable Class A repair for one class only** — labelled scalar → `details` —
   behind a flag, proven by three runs against the stability gate.
4. **Class D notes rule**, with rejected content surfaced rather than dropped.
5. **Unresolved review state** in the import review screen.

Steps 3–5 each ship separately, each behind its own gate.

## Secondary safeguards — roadmap, not substitutes

1. **Batch consistency checking.** After extraction, compare records within an
   import and flag structural outliers: if most records put `Community Fee` in
   details and one puts it in the private note, surface that record. **Detect,
   never auto-rewrite.** Note that this would have caught The Bluffs in run 2 —
   it was the outlier among twenty. It is a good net and a bad foundation,
   because it fails exactly when a whole import drifts together.
2. **Single-record retry.** Re-run one questionable proposal from its preserved
   source, keep both results, let the professional compare. 0024 already retains
   what this needs.

Neither replaces deterministic first-pass guarantees.

## Open questions for review

- The scalar/prose boundary threshold, and whether it is per-label configurable.
- Whether the narrative field is one field or a typed `details` entry with a
  `prose` kind — the second avoids a migration but constrains rendering.
- Whether Class D should apply to packet ingestion too, where `ambiguous ->
  notes` is still in the prompt and `notes` is now genuinely private.
- Whether UNRESOLVED blocks saving a proposal or merely annotates it.
