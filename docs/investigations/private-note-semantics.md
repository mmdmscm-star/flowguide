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
- **Creekwood Senior Home** was reviewed as correct, but its source cell carries
  a `Care Costs:` label and its Library entry holds "Care costs are all-inclusive
  (included in price)" in the private note. By the professional's own rule that
  is a reusable community fact in a private field. Raised as a question, not a
  correction — it may be a case that was not scrutinised, or one they consider
  acceptable. Which it is changes whether the "any note is suspect" rule holds at
  11/11 or 12/12.
