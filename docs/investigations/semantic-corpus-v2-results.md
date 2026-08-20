# Corpus v2 — results

13 records · 354 facts · 22,207 chars · mean 1,706 chars/record · 9 chunks ·
**1.44 records/chunk** (real import: ~1.33) · **3 samples**, 27 model calls.
No prompt, routing or classification change.

## Headline

**v2 found a severe, reproducible defect — and it is not the one seen in
production.**

| | v1 | v2 |
|---|---|---|
| correctness | 96.9% | **93.0%** (1,062 observations) |
| MISCLASSIFIED | 5 | **0** |
| LOST | 2 | **68** |
| FABRICATED | 0 | 3 |
| DUPLICATED | 0 real | 3 |

Nothing was misplaced. Facts were **silently dropped**.

## 1. Value shape is the dominant variable

| shape | correct | of | failures |
|---|---|---|---|
| simple | **99.2%** | 768 | 3 fabricated, 3 duplicated |
| qualified | 92.6% | 108 | 8 LOST |
| **ranged** | **12.8%** | 39 | **34 LOST** |
| prose | 82.3% | 147 | 26 LOST |

**A ranged value is lost roughly seven times out of eight.**

- *"Level of care pricing ranges from $600 to $2,400 per month depending on the
  assessment"* — **31 losses**
- *"Live-in Rate: ranges from $520 to $610 per day"* — 3 losses
- *"Care Costs: Additional monthly fee based on level of care…"* — **25 losses**
- qualified community fees (*"Equal to one month's rent"*) — 8 losses

These are not formatting differences. The value is absent from the output
entirely — not in details, not in notes, not in the description.

## 2. Two thirds of failures are reproducible, not nondeterminism

| | count |
|---|---|
| always correct across all 3 runs | 324 |
| **ALWAYS wrong** | **20** |
| sometimes wrong | 10 |

Every one of the 20 reproducible failures is a `ranged`, `prose` or `qualified`
value. The 10 variable ones are the same shapes plus three `capacity` flickers.

So the earlier framing — *"is this model nondeterminism?"* — is answered: mostly
no. The dominant failure is deterministic and shape-driven.

## 3. Chunk occupancy matters, but far less than v1 suggested

| | correct |
|---|---|
| 1 record per chunk | 94.7% (510) |
| 2 records per chunk | 91.5% (552) |

A real 3.2-point effect, and much smaller than the 86-point spread between
`simple` and `ranged`. v1's chunk-composition finding was real but is not the
main driver.

## 4. Length and density have mild effects

| record length | correct | | facts/record | correct |
|---|---|---|---|---|
| <1,000 | 95.8% | | 9 | 100% |
| 1,000–1,700 | 93.1% | | 28 | 92.8% |
| 1,700–2,100 | 92.7% | | 29 | 90.7% |
| | | | 30 | 93.9% |

Roughly three points across the range. Real but secondary.

## 5. Clone consistency — 25 of 30 fact types perfectly stable

The five unstable ones, and their shapes:

```
 92%  capacity        simple      details×22   description+details×2
 83%  fee_qualified   qualified   details×20   LOST×4
 96%  range           ranged      LOST×23      details×1      <- consistently LOST
 67%  care_costs      prose       details×8    LOST×16
 75%  prose_memory    prose       description×18  absent×6
```

`range` is the inverse of an inconsistency problem: it is **consistently lost**.

## 6. One reproducible fabrication

**B2 has no website in its source, and a website was produced in all three
runs** — most likely inferred from the contact email domain. Small in volume
(3 of 1,062) but it is invention, and it was stable across runs.

## 7. What this does and does not tell us about production

**Does not reproduce it.** The production symptom was *misclassification*: simple
key/value facts — `Type:`, `Second Person Fee:`, `Community Fee:` — concatenated
into the private note in 22 of 65 entries. In v2, simple key/value facts scored
**99.2%** and **MISCLASSIFIED was zero across all three runs**.

**Materially narrows it.** We now know:

- long records alone do not cause it (mean 1,706 chars, up from 376)
- realistic chunk occupancy alone does not cause it (1.44/chunk, matching ~1.33)
- high field density alone does not cause it (28–30 facts/record)
- mixed record types do not cause it (confirmed twice)
- value shape causes **loss**, not misplacement

So whatever produced the production symptom is a property of that source that
none of these dimensions captures — most likely its actual formatting, which we
cannot inspect: the run was finalized before 0024, and finalize destroyed the
source, segments and results.

**The next real import will preserve all of it.** That is what 0024 was for, and
it is now the shortest path to reproducing the original symptom.

## 8. What is independently worth fixing, on this evidence alone

Regardless of the production question, v2 establishes a defect that is severe,
reproducible and affects a fact type professionals rely on:

**Ranged and prose-qualified values are silently discarded.** A price band, a
care-cost qualifier and a conditional fee are exactly the facts a family asks
about, and they disappear without any signal — no error, no partial value, no
note. A professional would have no way to know something was dropped.

No fix is proposed here. This is the diagnosis.

## Method notes

- Three samples, aggregated over 1,062 fact-observations.
- Each completed run is persisted before the next begins, after an earlier
  attempt lost two finished samples to a network failure in the third — the
  harness was less resilient than the pipeline it was measuring.
- Scoring uses the shared core with both v1 artifact fixes: text facts are never
  matched inside url-shaped destinations, and short numbers match as whole
  tokens rather than as substrings of postcodes and phone numbers.
