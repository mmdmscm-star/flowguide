# Private Note semantics — hypothesis, not yet tested

*Held pending the spreadsheet and the known-bad list. No implementation.*

## Four categories, not two

An earlier draft of this analysis concluded that a Library import "structurally
cannot produce a legitimate private note". That was wrong, and it collapsed a
real category:

| # | content | reusable? | recipient sees it? | belongs |
|---|---|---|---|---|
| 1 | **Community fact** — pricing, capacity, care tiers, contacts | yes | yes | details / links / contacts, in the Library entry |
| 2 | **Internal community knowledge** — "their billing office is difficult", "the memory care wing is being renovated" | **yes** | no | **Private Note, in the Library entry** |
| 3 | **Client-specific commentary** — "five minutes closer to the family's home and closer to Lynn's doctor" | no | no | Private Note on the FlowGuide copy |
| 4 | **Reusable explanatory narrative** — Atria's paragraph on why published pricing varies by unit and date | yes | yes | with the pricing information, as prose — NOT a `Label: value` detail |

Category 4 was added after the professional's review and it matters more than it
looks. Atria Tamalpais Creek's note is a paragraph explaining that pricing is
published per-unit and changes with availability. It is long and narrative, which
is plainly why the model treated it as a note — but it is reusable, it is not
private, and it is part of the fee structure a recipient needs in order to read
the numbers correctly.

**So the fix is not "move everything out of notes into details."** A detail is a
`label` and a `value`; forcing a paragraph into that shape would destroy it. And
the professional's own point generalises past this dataset: another user in
another vertical may legitimately want a narrative paragraph — laundry, parking,
visiting policy — carried alongside the structured facts.

Category 2 is the one the earlier draft erased. A professional accumulates
private, reusable judgement about a community that should persist across many
FlowGuides. That is a legitimate Library concept, and any rule written here must
leave room for it.

## The hypothesis to test

> **Library AI import must not use Private Note as an uncertainty or overflow
> destination. It may populate Private Note only when the source explicitly
> identifies the information as internal, private, or professional commentary.**

The failure is not "the model wrote a note". It is "the model wrote a note
*because it could not decide where else something went*". Category 2 content is
welcome; category 1 content arriving there by default is the defect.

## What the surviving evidence already says

Of the 31 private notes in the 61-record import: 21 carry priced or labelled
facts, 10 carry facts without numbers, and **0 carry client context**. Every one
is category 1 — a community fact that belongs with the other details.

Zero are category 2 either, on inspection: none reads as internal professional
judgement about the community. They are extraction residue.

## The prediction the spreadsheet will settle

If the spreadsheet contains **no column marked internal/private**, then all 31
notes were produced with no source authority whatsoever — pure overflow, and the
hypothesis is confirmed at full strength.

If it **does** contain such a column, the sharper question is whether the model
used it: did the content of that column reach Private Note, and did anything
else reach it too? Overflow mixed with legitimate use is a different, and
harder, problem than overflow alone.

Either answer is informative. The prediction is recorded before the data arrives
so it cannot be adjusted afterwards to fit.


## Scored against the professional's own review

Their review of 23 entries — 11 wrong or partial, 10 correct, 2 uncertain —
scores the two structural predictors:

| predictor | catches known-bad | flags known-good |
|---|---|---|
| a known column sits **only** in notes | **5 / 11** | 0 / 10 |
| the entry has **any** private note at all | **11 / 11** | 1 / 10 |

The column scan is precise and half-blind: it cannot see residue (Mountain View,
Oakmont Gardens), narrative (Atria), or facts phrased without a known column
name (Cogir of Vallejo Hills, Varenna, Enso Village).

**Mere presence of a private note catches every known failure.** That is a strong
result, and it is exactly what the hypothesis predicts: with no private column in
the source, a note can only have come from overflow, so any note is suspect.

### Two verdicts settled from source truth

- **Friends House** and **Tamalpais Marin** have **empty** Profile & Pricing
  cells. Their missing pricing is **correctly absent**, not lost. The
  professional's instinct was right and is now proven from source.
- **Creekwood Senior Home** — resolved by the professional as a **known partial
  failure, MISCLASSIFIED**. Source: `Care Costs: Prices are all-inclusive (care
  costs included in price)`. Output: the same meaning, reworded, in the private
  note. Not lost, not fabricated — an explicitly labelled reusable fact routed to
  a private field. **The "any private note" predictor is therefore 12/12 with 0
  false positives against 9 known-good.**


## Two correlations, neither of them a rule

Creekwood produced the decisive pair. Its source cell holds two ADJACENT
labelled lines:

```
Community Fee: $2,500                                       -> details
Care Costs: Prices are all-inclusive (care costs included…)  -> PRIVATE NOTE
```

One line apart, same cell, same `Label: value` form, opposite destinations. That
single pair eliminates the host cell, the chunk boundary, line wrapping, and
narrative ambiguity as sufficient explanations.

What remains is the value. Measured across the joined dataset, excluding labels
whose correct home is `contacts` or `links`:

| value shape | facts | → detail | → notes | missing |
|---|---|---|---|---|
| scalar (`$2,500`, `AL, MC`, `58`) | 212 | 69% | 18% | 13% |
| prose (`Additional monthly fee based on level of care…`) | 69 | 43% | **41%** | 16% |

A prose value reaches the private note **2.3× more often**. Real effect — and
still not a rule: 43% of prose values became details anyway, and 18% of scalars
went to notes anyway.

**And then the pair that breaks it outright:**

```
Creekwood     Community Fee: $2,500  -> details
Vine Ridge    Community Fee: $2,400  -> PRIVATE NOTE
```

Same label. Same value shape. Same magnitude. Opposite destinations.

### What that means

**No property of the fact determines where it lands.** Host cell is a risk
factor (83% vs 57% detail). Value shape is a risk factor (69% vs 43%). Neither
is deterministic, and together they do not account for the residual.

The remaining explanation is that placement is decided per record, inconsistently
— which is a very different problem from a missing prompt rule. A missing rule
is fixed by writing the rule. Instability is not: a rule that is followed 70% of
the time still loses three facts in ten.

**The twice-run diagnostic is now the deciding experiment.** If the same record
lands the same way in both runs, placement is stable and driven by something in
the record we have not yet isolated. If it moves between runs, placement is
genuinely non-deterministic, and no prompt-level rule can be relied on without
accounting to catch what it misses.

Recorded before the runs so it cannot be reinterpreted afterwards.

### A measurement error worth recording

The first version of the value-shape table reported scalars as 65% "missing".
That number was meaningless: it counted `Email Address`, `Cell Phone` and
`Existing Website` as missing details when they had correctly become contacts.
Excluding contact- and link-destined labels changed scalar placement from
28% to 69% detail. The corrected table is above; the flawed one was never
reported as a finding.
