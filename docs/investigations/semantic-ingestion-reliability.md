# Semantic ingestion reliability — diagnosis of the 61-record import

Investigation only. **Nothing changed in production.** Evidence is the founder's
real import, run `c27f54b8`, 116,378 characters, 46 chunks, 65 Library entries.

Conclusion first: **the inconsistency is not model nondeterminism. It is a
missing specification.** The prompt the Library import uses is the only one in
the codebase with no field-routing rules and no domain guidance, and no code
anywhere enforces where a fact belongs. Given no rule, the model invented one per
chunk — and there were 46 chunks.

---

## 0. What evidence survives, and what we destroyed

`library_close_import_run` clears `source_text`, `segment_text` and `result` when
an import finishes. All three are gone for this run.

> **We cannot compare any output against its source record.** The paired
> comparison this investigation was asked for is impossible on this import.

Everything below is therefore derived from the 65 outputs alone. That is weaker
than it should be, and it is a design defect in its own right: an import that
cannot be diagnosed after the fact is an import whose failures can only ever be
re-encountered, never studied. **Retaining the source and staged results is the
first recommendation, because it gates every other one.**

Fortunately, misplacement is partly detectable without the source: a URL is a URL
wherever it sits, a currency amount is a price, and `Label: value` is a key/value
pair. And one signal needs no source at all — **the same label landing in
different destinations within a single import**.

---

## 1. Why did structurally similar records map differently?

They were classified by 46 independent model calls that were never told where
anything goes.

**The Library import uses `itemsOnlyPrompt()`, which is missing every routing
rule the packet prompts have:**

| Rule | `organizeLeadPrompt` / `sectionsPrompt` | `itemsOnlyPrompt` (Library) |
|---|---|---|
| `full street addresses -> address` | present | **absent** |
| `ambiguous -> notes` | present | **absent** |
| `a label for every link` | present | **absent** |
| `TYPE_GUIDANCE` (e.g. "cost, care level as details; tour notes -> notes") | present, per packet type | **absent — the function takes no packet type at all** |

So the packet paths say "monthly cost and care level are *details*". The Library
path says nothing, and the model decided per chunk.

**The evidence, needing no source.** These labels landed in *both* `details` and
the private `notes` inside this one import:

| label | as a detail | in the private note |
|---|---|---|
| `Type` | 53 | 11 |
| `Capacity` | 52 | 6 |
| `Community Fee` | 25 | 9 |
| `Second Person Fee` | 20 | 8 |
| `Care Costs` | 13 | **12** |

Ten labels are self-contradictory this way. `Care Costs` is a coin flip.

Two entries from the same operator, adjacent in the source, identical in shape:

```
Brookdale Chanate      details(5)   notes: "Type: AL, MC, Respite. Second Person Fee: $2,500/month.
                                            Community Fee: $6,000. Care Costs: ..."
Brookdale Paulin Creek details(14)  notes: "Care Costs: ..."
```

`Type` is a detail in one and prose in the other. Same operator, same format,
same run.

---

## 2. Model nondeterminism vs prompt/schema ambiguity vs code

**Almost none of it is nondeterminism.** Nondeterminism would produce scattered,
unpatterned variation. What we see is *bimodal*: facts land in one of exactly two
places, and the split tracks nothing about the source. That is the signature of an
underspecified decision, not a noisy one.

| Cause | Share of what we can see | Evidence |
|---|---|---|
| **Prompt/schema ambiguity** | dominant | no routing rules in the Library prompt; `notes` is legal for anything; `ambiguous -> notes` in the packet prompts is an explicit instruction to be inconsistent |
| **Code** | the enabling condition | nothing validates placement; `ingest-validate.ts` checks *shape* only — arrays are arrays, title is non-empty. `normalizeItemContent` coerces *types* only. **There is no field-classification code at all.** |
| **Model nondeterminism** | residual | plausibly the depth spread (2–14 details) once a chunk has no rule to anchor to |

**Everything is currently the model's decision** except URL *labelling*, which is
instructed but never enforced. Chunking makes it worse: 65 entries across 46
completed leaves is ~1.41 entries per call, each independent, with **no
cross-chunk context and no shared vocabulary**. Two identical records in
different chunks are two unrelated decisions.

**And yes — the schema legally permits one fact in several destinations.** A
price may be a `details` row, a sentence in `description`, or a sentence in
`notes`. A phone may be `contacts[].phone` or a `details` row (7 entries did the
latter). A website may be `links[]` or `contacts[].website`. Nothing anywhere
says a fact has exactly one home.

---

## 3. Invariants that would make equivalent structures map consistently

Stated generally; none is senior-living specific.

1. **Single destination.** Every extracted fact has exactly one legal home,
   decided by *shape*, not by judgment: URL → `links`/`photos` by pattern;
   `+1-555…` → `contacts[].phone`; `x@y.z` → `contacts[].email`; currency amount
   attached to a label → `details`; postal address → `address`;
   `Label: value` → `details`.
2. **`notes` is not a destination for extracted facts.** It is the professional's
   own private commentary. Nothing the model extracts may be routed there. This
   single rule removes the largest observed defect class — and note that
   misrouting *into* `notes` is not cosmetic: **the recipient never sees it.**
3. **Deterministic before semantic.** Recognisable facts are extracted by code
   *first*; the model receives what remains and decides only genuinely semantic
   things: which record this is, its title, and prose description.
4. **One canonical label per run.** First occurrence of a normalised label fixes
   its form; later chunks conform. Today: 193 distinct labels across 431 rows,
   **161 used exactly once**.
5. **A fact appears once.** After routing, deduplicate by normalised value across
   destinations, and within `links` by normalised URL (`The Vincent` carried
   `thevincentsl.com` twice).
6. **Placement is validated, not hoped for.** A post-model validator rejects or
   repairs any output that violates 1–5, in the same place `ingest-validate.ts`
   already checks shape.

---

## 4. The regression corpus that should gate ingestion changes

A **semantic** corpus, not a snapshot corpus. Snapshots of model output would
freeze today's defects as expected behaviour.

- **Fixtures**: 25–40 source records spanning verticals — senior living, real
  estate, a services list, a plain prose list, a TSV export — including the
  awkward shapes we already know about: a record with no address, one with three
  contacts, one whose photos outnumber its text, a mid-record chunk split.
- **Assertions per record are per-field and destination-specific**: *this price
  is a detail with this label*, *this URL is a link labelled Website*, *this phone
  belongs to this contact*, *`notes` is empty*.
- **Scoring is field-level, not record-level**: precision and recall per
  destination, plus a **placement-consistency score** — the same label must not
  appear in two destinations across the corpus, which is exactly the defect this
  import shows.
- **Gate**: any change to prompts, schema, chunking or the router must not
  regress field-level placement accuracy or the consistency score. Model calls
  are non-deterministic, so the gate is a threshold over the corpus, not equality
  on any single record.
- **Deterministic layers get ordinary unit tests** and need no model at all —
  which is the point of moving work into them.

---

## 5. Measured failure rate on this import

Field-by-field, over all 65 entries. **A lower bound**: with the source
destroyed, extraction *loss* and *fabrication* cannot be measured at all.

| Defect | Entries | Rate |
|---|---|---|
| Wrong field classification (a label that is a detail elsewhere, sitting in the private note) | 20 | **31%** |
| Pricing reachable **only** in the private note — invisible to the recipient | 5 | 8% |
| Duplicate link within one entry | 1 | 2% |
| Suspiciously thin against peers (≤2 details, ≥4 photos) — *possible* extraction loss, unconfirmable | 11 | 17% |
| **At least one detectable defect** | **28** | **43%** |
| Clean on every detectable axis | 37 | 57% |

Supporting spread: details per entry ranged **2 to 14** for records of the same
kind; 22 of 65 had key/value facts split across `details` *and* `notes`
simultaneously; 16 of 65 had pricing in the private note.

**Classification of the discrepancies observed:**

- *Wrong field classification* — dominant, and the direct cause of the reported
  symptom.
- *Duplication* — present but rare (1 entry), and deterministically fixable.
- *Presentation-only* — the label-vocabulary spread; harmless per record,
  corrosive across a Library.
- *Extraction loss* — suspected in 11 entries, **unprovable without the source**.
- *Fabrication* — **not measurable**; no `Primrose Photo 4`-style artefact is
  visible, but absence of evidence here is exactly what the destroyed source
  costs us.

---

## Proposed architecture, in order

1. **Stop destroying the evidence.** Retain `source_text` and chunk `result` for a
   bounded window after finish. Nothing else can be measured until this exists.
2. **A deterministic fact extractor** ahead of the model: URLs, emails, phones,
   postal addresses, currency amounts, and `Label: value` lines, with spans
   recorded so the model sees what is already claimed.
3. **A deterministic router** after the model, enforcing invariants 1–5 and
   repairing violations rather than trusting placement.
4. **Give the Library path the routing rules the packet paths already have**, and
   a `packetType` so vertical guidance applies — as *part of* the general rule
   set, not as senior-living examples.
5. **Build the corpus**, then gate.
6. Only then re-tune prompts, measured against the corpus.

Steps 2 and 3 are where the reliability comes from. A prompt cannot be made
reliable by adding examples; it can only be relieved of decisions that code
should be making.
