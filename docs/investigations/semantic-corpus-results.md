# Controlled corpus — results and diagnosis

Three runs of the 20-record / 228-fact corpus. No production behaviour changed.

## The headline you need first

**The corpus did not reproduce the production failure.** In the real 61-record
import, 22 of 65 entries (34%) had key/value facts split into the private note
and 16 (25%) had pricing there. In this corpus, prices went to `details`
**8 times out of 8**, and 14 of 15 fact types were perfectly consistent.

That is a result about the corpus, not a clean bill of health. See *Why it did
not reproduce* below.

## 1. Overall correctness — run 3

| | |
|---|---|
| **218/228 (95.6%)** measured | CORRECT 209 · CORRECTLY ABSENT 9 |
| MISCLASSIFIED | 5 |
| LOST | 2 |
| FABRICATED | **0** |
| DUPLICATED | 3 — **all three are scorer artifacts** (below) |
| Records | 20/20 matched, 0 missing, 0 split, 0 merged |

Discounting the artifacts: **221/228 (96.9%)**, with **7 real defects**.

## 2. Two scoring artifacts I had to remove before believing anything

Runs 1 and 2 reported **13 DUPLICATED**. Almost all of it was mine, not the
model's.

- **A name inside its own domain.** `Marin Terrace` → `marinterrace.example.com`
  and `ken@marinterrace.example.com`. A substring scan reported the title as
  duplicated across `title+links+photos+contacts.email`. Fixed by never
  searching text facts in url-shaped destinations.
- **Two-digit numbers inside longer digit strings.** `Capacity: 47` "appears" in
  postcode `95472`; `Capacity: 75` "appears" in phone `707-555-0215`. The
  remaining 3 DUPLICATED are all this. **Real duplication: zero.**

Reporting run 1's 90.8% would have been wrong by five points and would have
invented a duplication problem that does not exist.

## 3. Clone consistency — 14 of 15 fact types at 100%

```
  50%  tour          rule=packet-prompts-only   description×4, notes×4
 100%  name, address, type, capacity, price_studio, price_onebed, fee,
       person, role, phone, email, website, photo, prose
```

## 4. The one real inconsistency, and it is not nondeterminism

`tour` — the identical sentence *"Tours run on Tuesday and Thursday mornings."*

```
run 1   chunk0: description   chunk1: notes   chunk2: notes   chunk3: description
run 2   chunk0: description   chunk1: notes   chunk2: notes   chunk3: notes
run 3   chunk0: description   chunk1: notes   chunk2: notes   chunk3: notes
```

**Chunk 0 got it "wrong" in all three runs.** Chunk 0 is the one holding four
clones together; chunks 1–3 hold one or two. The same sentence classifies
differently depending on **what else is in the chunk with it** — reproducibly,
not randomly.

That is the most important finding here, because it generalises: each chunk is an
independent model call with no shared context, so classification is a function of
chunk composition rather than of the fact alone.

## 5. By whether the prompt states the rule — this contradicts my hypothesis

| `ruleStated` | correct |
|---|---|
| `yes` | **113/113 (100%)** |
| `packet-prompts-only` | 71/75 (94.7%) |
| `no` | 34/40 (85.0%) |

The gradient runs the way I predicted, **but the prediction was still wrong in
substance**: I expected the `packet-prompts-only` facts — prices, addresses, care
type — to be the failure mode, because the Library prompt never receives that
guidance. They were 100% consistent across all 8 clones. `capacity` and `prose`,
which have **no rule anywhere**, were also 100%.

So *absence of a stated rule did not predict failure.* All four
`packet-prompts-only` misses are the same `tour` fact, and both `no` misses are
prose-embedded values.

## 6. The 7 real defects, in full

| kind | where | fact | expected → actual |
|---|---|---|---|
| MISCLASSIFIED ×4 | A1–A4, all chunk 0 | `tour` | notes → description |
| MISCLASSIFIED ×1 | D2 | `timeline` "4 to 6 months" | details → notes |
| LOST ×1 | C1 | fee written as prose: *"six thousand dollars"* | details → nowhere |
| LOST ×1 | C2 | *"$5,100 to $6,400 per month"* | details → nowhere |

**Both LOST facts are values embedded in prose rather than written as
`Label: value`.** Nothing extracted them at all — they are simply gone from the
output. That is the sharpest signal in the run.

## 7. Mixed types did not confuse it

| group | correct |
|---|---|
| D — mixed type (home care, benefit, PT clinic) | 23/24 (95.8%) |
| A — clones sitting beside them | 116/120 (96.7%) |
| B — legitimate absences | 57/60 (95.0%) |
| C — ambiguity probes | 14/16 (87.5%) |
| E — awkward | 8/8 (100%) |

Interleaving a home-care agency and a benefit programme among senior-living
records caused no observable bleed. The mixed records scored as well as their
neighbours.

## 8. Ambiguity probes and the duplicate link

- **C1** — a contact's own scheduling URL was correctly kept out of item links;
  the fee stated as prose was **lost**.
- **C2** — two people in one sentence were separated correctly into two contacts;
  the price **range** was **lost**.
- **E1 — the duplicate link did not reproduce.** The same URL appears twice in
  the source; the output contains it once. Scored 8/8.

## 9. Absences were handled correctly — FABRICATED = 0

All 9 deliberate absences were correctly absent. Nothing was invented for a
missing phone, website, price, address, email or prose. **The model did not
fabricate anything, in any run.**

## 10. The application layer alters nothing

For every matched record, the model output and the saved Library entry are
identical. Every discrepancy is upstream of the save — extraction and
classification, not persistence.

## Why it did not reproduce, and what that implies

Comparing the corpus with the real import:

| | real import | this corpus |
|---|---|---|
| records | 61 | 20 |
| source | 116,378 chars | 7,527 |
| **chars per record** | **~1,900** | **~376** |
| chunks | 46 | 4 |
| **records per chunk** | **~1.3** | **~5** |

Real records are **five times longer** and carry far more per record. The
production notes field contained things like *"Care Costs: Additional monthly fee
based on level of care (assessment required)"* — long, qualified values that do
not fit a clean `label: value` shape. My corpus gave every fact a tidy one-line
`Label: value` form, which is the easy case.

Combined with finding 4 — classification depends on chunk composition — the
likely mechanism is that **long, field-dense records with prose-qualified values
are where classification degrades**, and this corpus contained neither.

**A faithful corpus needs records of realistic length and messiness**: multi-line
qualified values, fee tables, mixed prose-and-label formatting, and enough volume
that chunks hold roughly one record rather than five.

## What can be concluded now

1. **Nothing is fabricated, nothing is duplicated, nothing is lost from
   well-formed input.** The pipeline is not broadly unreliable.
2. **Values written as prose rather than `Label: value` are silently dropped.**
   Two of two attempts. This is the clearest reproducible defect.
3. **Classification depends on what else shares the chunk** — reproducible across
   three runs, and the mechanism most likely to explain the production symptom.
4. **A missing prompt rule did not predict failure**, which contradicts the
   hypothesis I formed from reading the prompts. That hypothesis should not be
   the basis for a fix.
5. **The production failure is not yet reproduced**, so no fix should be designed
   from this corpus alone.
