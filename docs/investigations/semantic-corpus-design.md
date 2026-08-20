# Controlled diagnostic import — test set and scoring rubric

**For review before running.** Nothing has been imported. No prompt, routing or
classification change has been made.

This is the first import whose evidence will survive, because 0024 stopped
finalize from destroying it. That is what makes source ↔ model output ↔ saved
entry comparison possible at all.

---

## The corpus

`scripts/ingestion-runtime/fixtures/semantic-corpus.mts`

| | |
|---|---|
| Records | 20 |
| Facts with a declared expected destination | 228 |
| Facts actually present in the source | 219 |
| **Deliberate absences** | **9** |
| Source size | 7,527 characters |
| Chunks (computed in advance) | 4 |

**Ground truth is generated, not typed.** Every record is built from a template,
so the clone group is identical by construction rather than by proofreading, and
each fact carries its expected destination in the same data structure. Scoring is
mechanical, decided before results are seen rather than after.

### The five groups

**A — structural clones (8 records).** Byte-identical *structure*, different
values: name, address, `Type:`, `Capacity:`, two priced room types, a community
fee, a named contact with role, phone, email, a website, a photo URL, a
descriptive sentence, and a tour remark. **If these map differently from one
another, the source is not the reason.**

**B — legitimate absences (6 records).** Same shape, each missing exactly one
different thing: phone, website, price, address, email, prose. Absent in source
*and* absent in output is **correct**. This is what stops us reading silence as
failure, and it is why every fact carries a `present` flag.

**C — ambiguity probes (2 records).** Facts that could defensibly land in two
places. C1 states a fee as *prose* rather than a key/value pair — the same fact
group A states as `Community Fee: $6,000` — and includes a contact's **own**
scheduling URL alongside the community site, which the prompt explicitly
distinguishes. C2 has a price *range* and **two people in one sentence**.

**D — a different kind of record (3), interleaved not appended.** A home-care
agency with an hourly rate and no address, a government benefit with neither
address nor phone, and a physical-therapy clinic. Each sits **next to** clone
records so type-bleed is observable rather than hidden at the end.

**E — awkward but realistic (1).** The same URL appears **twice** in the source.
Correct output contains it once. This is the duplicate-link symptom, reproduced
deliberately.

### Chunk plan, known before running

```
chunk  0 [0..2638)    A1 A2 D1 A3 B1 A4
chunk  1 [2638..4793) C1 B2 A5 D2 B3 A6
chunk  2 [4793..6770) E1 B4 A7 C2 D3 B5
chunk  3 [6770..7527) A8 B6
```

The eight clones are spread across **all four** chunks — four together in chunk
0, two in chunk 1, one each in chunks 2 and 3. So the corpus separates:

- **within-chunk** inconsistency (A1–A4 differing from each other), from
- **cross-chunk** inconsistency (A8, alone in its own call, differing from A1),

which are different failures. Each chunk is an independent model call with no
shared context, so cross-chunk divergence is the expected structural weakness.

---

## Scoring rubric

### Per fact

Each of the 228 facts scores exactly one outcome:

| Outcome | Meaning |
|---|---|
| **CORRECT** | in the expected destination, value intact |
| **CORRECTLY ABSENT** | not in the source, not in the output |
| **MISCLASSIFIED** | present, but in a different destination — the actual destination is recorded |
| **LOST** | in the source, absent from the output entirely |
| **FABRICATED** | in the output, not in the source *(includes anything appearing for a deliberate absence)* |
| **DUPLICATED** | the same fact in two destinations, or twice in one |
| **DEGRADED** | right destination, value altered — truncated, rounded, reformatted so information is lost |

Presentation-only differences — label wording, capitalisation, `$4,720/month` vs
`$4,720 per month` — are recorded separately and **do not count as failures**.
Confusing formatting with misplacement is how a reliability number becomes
meaningless.

### Per record

**SPLIT** (one source record became two entries) · **MERGED** (two became one) ·
**MISSING** (produced no entry) · **INTACT**.

### The two headline numbers

**1. Correctness.** `CORRECT + CORRECTLY ABSENT` over 228. The absolute quality
of one import.

**2. Consistency.** For each fact type in group A, the share of the 8 clones
where it landed in the *modal* destination. **100% means perfectly consistent
even if consistently wrong.**

These are deliberately separate, because they have different causes and
different fixes. A fact that lands in the wrong place *every time* is a
prompt/schema problem. The same fact landing in different places across identical
records is nondeterminism or genuine ambiguity — and only the second is fixed by
constraining the model.

### The column that turns a score into a diagnosis

Every fact records whether the rule for its destination is **stated in the prompt
the Library import actually uses**:

| `ruleStated` | Meaning | Count |
|---|---|---|
| `yes` | `itemsOnlyPrompt` states it | contacts, URL routing, titles |
| `packet-prompts-only` | stated in `organizeLeadPrompt`/`sectionsPrompt` but **absent from the Library path** | addresses, prices, care type, tour notes |
| `no` | **no rule exists anywhere** | capacity, prose, hourly rates, ranges |

This is what separates the three causes in the original question. A failure on a
`yes` fact is model nondeterminism. A failure on `packet-prompts-only` is a rule
that exists but was never given to this path. A failure on `no` is a genuine
schema gap, where the model is being asked to guess.

---

## How the comparison will run

1. Import `SOURCE` through the real route, as a professional would.
2. Drive every chunk; **save all proposals**, so each entry carries its origin
   coordinates.
3. **Finish** the import — the step that used to destroy the evidence.
4. For each saved entry, walk `origin_run_id → source_text`,
   `origin_chunk_ordinal → chunk`, `origin_item_index → result->'items'`.
5. Score each fact against ground truth, three ways: **source vs model output**
   (extraction and classification), **model output vs saved entry** (whether
   anything changed on the way in), and **source vs saved entry** (end to end).
6. Report per-fact outcomes, per-record status, the two headline numbers, and a
   breakdown by `ruleStated`.

Disposable user throughout. The founder's real Library is never read or written.

## Cost and scope

Four chunks, so four model calls. Nothing is changed by running it — it produces
evidence, and the evidence is what the next decision rests on.

**Deliberately not in this step:** any prompt, routing, schema or classification
change. Those come after there are numbers to justify them.
