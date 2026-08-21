# Overfitting audit — is the reliability layer horizontal?

*2026-08-20. Audit and evidence only. No rule was changed to make the test pass.*

## Method

Every rule in `claim-parser.ts`, `reconcile.ts`, `attribution.ts` and
`placement.ts` classified, then the **unmodified** logic run over four
non-senior-living verticals built with the same structures: tab-separated rows,
quoted multiline cells, labelled facts, unlabelled price/descriptor pairs in
both orders, the wrapped/orphaned shape, repeated amounts, contacts, addresses,
URLs, image URLs, a blank field, narrative paragraphs, and deliberately
ambiguous fragments.

## Classification

### A — structurally horizontal

| rule | why it is horizontal |
|---|---|
| record envelopes (`detectSourceRecords`) | delimiter + quote state; no vocabulary |
| `LABEL_RE`, `MAX_LABEL_WORDS`, `CLAUSE_MARKERS` | grammar of a label vs a clause |
| `URL_RE`, `EMAIL_RE`, `PHONE_RE` | syntactic identities |
| `IMAGE`, `MAP` | file extension / host |
| precedence ladder (specialized → labelled detail → unresolved) | destination logic, no domain terms |
| the four accounting outcomes and their identities | arithmetic |
| occurrence-aware one-to-one matching | assignment logic |
| privacy authority (a note needs an explicit private marker) | policy, not vocabulary |
| provenance / source spans / attribution | offsets |

### B — input-format-specific

| rule | scope |
|---|---|
| tab/newline cell splitting, `""` unescaping | spreadsheet clipboard |
| `detectSourceRecords` delimiters `\t , ; \|` | delimited text |
| `CONTINUES`, `FINITE`, `splitTrailingProse` | **English** — a separate axis from vertical, and worth naming: these are language-dependent, not industry-dependent |
| `ADDRESS` street suffixes | **US** postal form |

### C — vertical-specific *(target: zero)*

| rule | verdict |
|---|---|
| **`DESCRIPTOR_WORD`** in `claim-parser.ts` — `studio, bedroom, suite, respite, memory, assisted, skilled, nursing, companion, alcove, courtyard, occupancy…` | **pure senior-living vocabulary, and it is load-bearing in two places** |
| `UNIT` — `month, mo, day, night, year, week, hour` | time-only. No `/person`, `/sq ft`, `/linear foot`, `/bottle`, `each`. Not senior-living *per se*, but it encodes "things are priced per unit of time", which is this industry's billing model |
| `placement.ts intendedField` — `/\b(care\|memory care\|level)\b/`, `/\bpet\b/` | senior-living. **Outside the enforcement path** — the ladder in `reconcile.ts` does not call it — but it is Class C and should not migrate inward |

## What the audit found

Structure held everywhere. **The vocabulary did not.**

```
record envelopes ......... 4/4          ✓ unchanged
labelled fact recall ..... 100.0%       ✓ unchanged
attribution unresolved ... 0            ✓ unchanged
contacts / URLs / emails / phones       ✓ unchanged

unlabelled pricing claimed  3
  expected but NOT claimed  4/4         ✗
  of the 3 claimed, WRONG    1          ✗✗
```

### Failure 1 — recall collapses

Every expected unlabelled price/descriptor pair was declined:

```
Standing Seam Metal $14/sq ft
Gutter Replacement $12/linear foot
Asphalt Shingle Tear-off $6.50-$8.25/sq ft
Lighting Rig $850/day
```

These are ordinary descriptor + price pairs. They fail for one reason: *metal*,
*gutter*, *shingle* and *rig* are not senior-living words. They became
SOURCE_UNRESOLVED, so **accounting still held and nothing was lost** — but the
layer degrades to "surface everything", which is not a guarantee, it is a
shrug.

### Failure 2 — the safety guard silently inverts *(the serious one)*

```
Plated Dinner
- $68/person Family Style     ->  CLAIMED, descriptor "/person Family Style"
```

This is the Vine Ridge trap exactly, in a new vertical — and the guard **did not
fire**. `isBareDescriptor("Plated Dinner")` is false because "Plated Dinner"
contains no senior-living vocabulary, so the dangling-descriptor test never
triggered and a shifted pairing was accepted as **confident**.

In senior living that guard produces caution. In catering it produces a
confidently wrong fact — `$68` bound to *Family Style* when it belongs to
*Plated Dinner* — which enforcement would then write into a Library as truth.

**A safety mechanism whose failure mode is vertical-dependent is worse than no
safety mechanism**, because its reliability is invisible from inside the corpus
that taught it.

The malformed descriptor `"/person Family Style"` is the same defect surfacing
again: `/person` is a unit, but `UNIT` knows only time words, so it was never
stripped.

## Conclusion — do not ship the unlabelled-pricing class

The claim/attribution/accounting core is horizontal and survived intact. **The
unlabelled-pricing claim class is not**, and the honest response is to say so
rather than to add `metal|gutter|shingle|rig|plated|dinner` and call it fixed.
Extending the word list would make this corpus pass and the next vertical fail
in the same way, silently.

Two possible directions, neither taken here:

1. **Positional, not lexical.** Confidence comes from the shape of a run — a
   column of `<text> <amount>` lines, consistent side, one amount each — rather
   than from recognising the words. That is testable across verticals and has no
   vocabulary at all.
2. **Drop the class** and let unlabelled pricing be SOURCE_UNRESOLVED
   everywhere, accepting a high review rate as the price of not guessing.

Either way the current implementation should not reach enforcement. Labelled
facts, contacts, URLs, images, addresses, attribution and the accounting
identities are unaffected and remain ready.
