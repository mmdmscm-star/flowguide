# Private Note semantics — hypothesis, not yet tested

*Held pending the spreadsheet and the known-bad list. No implementation.*

## Three categories, not two

An earlier draft of this analysis concluded that a Library import "structurally
cannot produce a legitimate private note". That was wrong, and it collapsed a
real category:

| # | content | reusable? | recipient sees it? | belongs |
|---|---|---|---|---|
| 1 | **Community fact** — pricing, capacity, care tiers, contacts | yes | yes | details / links / contacts, in the Library entry |
| 2 | **Internal community knowledge** — "their billing office is difficult", "the memory care wing is being renovated" | **yes** | no | **Private Note, in the Library entry** |
| 3 | **Client-specific commentary** — "five minutes closer to the family's home and closer to Lynn's doctor" | no | no | Private Note on the FlowGuide copy |

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
