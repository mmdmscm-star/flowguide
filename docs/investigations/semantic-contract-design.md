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

### The unit is the CLAIM, and the parse decides it — not the value

A **claim** is what the source demonstrably asserts: an explicit `Label: value`
line, or a bare URL, email or phone. That determination is made at parse time,
deterministically, before the model runs.

**Value shape never decides whether information is preserved.** It may inform
how something is rendered. It may not decide whether it survives. `Care Costs:
Prices are all-inclusive (care costs included in price)` is exactly as much a
claim as `Community Fee: $2,500`, and both must reach the recipient.

The earlier scalar/prose split is withdrawn. It made preservation contingent on
how a value happened to be phrased, which is the same error the model is making.

### Destination precedence

Every claim resolves down this ladder. The first rung that fits wins.

| | rung | examples |
|---|---|---|
| **1** | **specialized source-backed destination** | email → `contacts.email` · phone → `contacts.phone` · image URL → `photos` · map URL → `links` "View on Map" · other URL → `links` · street address → `address` |
| **2** | **ordinary labelled Detail** | every other `Label: value`, **whatever the value looks like** — `Community Fee: $2,500`, `Care Costs: Prices are all-inclusive…`, `Type: AL, MC` |
| **3** | **UNRESOLVED** | content that is **not a claim**, or a claim whose specialized destination cannot be satisfied |

Specialized wins first: a phone number that also appears on a `Phone:` line
belongs in `contacts`, not as a detail row, and the ladder says so without a
per-label table.

**No per-label ontology or configuration.** The ladder is general. If a label
eventually needs special handling, that is a future decision made on evidence,
not a system built in advance.

### What actually reaches UNRESOLVED

Rung 3 is narrow by construction. The Atria case shows why it is still needed —
and why it cannot be solved by a length threshold. Its paragraph is not a
labelled line at all; it is **glued onto the end of a fee line** in the source
cell:

```
- Second Person Fee: $2,095 (2BR) Pricing for apartments at Atria Tamalpais
  Creek are listed on their website when units are available. The units vary…
```

The claim on that line is `Second Person Fee: $2,095 (2BR)`, which goes to
`details` by rung 2. The trailing paragraph is not a claim, has no deterministic
destination, and must not be guessed at. It becomes UNRESOLVED and the
professional decides.

That is the honest shape of the boundary: **not "prose versus scalar", but
"claim versus not-a-claim"**, drawn by the parser rather than by a heuristic
about how a sentence reads.

### Model judgment — not enforced

Entity boundaries · titles · descriptions · which contact owns which phone ·
detail ordering · label normalisation · recognising a room type versus a field.
These are why the model is here.

### The privacy rule

`notes` is populated **only** from source text carrying an explicit privacy
marker. The diagnostic spreadsheet contains none — all 53 "private" matches are
room types — so all 31 historical notes would have been rejected.

- note content matching a **claim** → re-placed by the precedence ladder
- note content that is **model-generated prose** → not accepted; the accounting
  guarantee covers source facts, not model inventions

**This rule ultimately applies to packet ingestion too.** Once `notes` means
genuinely private, no ingestion path may route ordinary or ambiguous
recipient-relevant information there without source evidence that it is private.
Library is the first bounded implementation because it is smaller and its
failure is already characterised — but **packet ingestion must inherit the same
rule before this reliability work is complete**, and the packet prompt's
`ambiguous -> notes` cannot remain as it is. It is currently an instruction to
route uncertainty into a field the client never sees.

## UNRESOLVED — what it blocks

An unresolved claim **blocks silent completion of that exception, not the
import.**

- Clean records continue normally and save normally.
- The unresolved claim is **preserved verbatim** and visibly marked against its
  record until the professional places it, explicitly ignores it, or otherwise
  resolves it.
- It is **never dropped** merely so a proposal can save. Silent disappearance is
  the failure mode this whole layer exists to end; permitting it at the exception
  boundary would reintroduce it exactly where the system already knows something
  is wrong.

## Content model — deliberately unchanged in this patch

**No narrative field is added here.** Paragraph-like reusable source content
becomes UNRESOLVED rather than being forced into `details` or `notes`.

The reasoning that a paragraph does not belong in a label/value row, in a
private field, or blended into `description` still stands. What does not follow
is that the answer is one new rigid column. The longer-term direction is a
first-class recipient-visible **reusable content concept** — plausibly
block-oriented, and plausibly the same primitive a more block-oriented Library
would want — designed on its own terms rather than bolted onto a reliability fix.

Adding a field now would commit the content model to the shape of the first
example we happened to meet.

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
| **placement determinism** | repeated identical-input runs of the 20-record paste; recipient-visible placement of every claim | **identical across runs** |
| **detector recall** | explicit `Label: value` fixtures (label-shapes, v1, v2, the 20-record source) | **100%** on controlled explicit-label fixtures |
| **detector precision** | same three fixtures | **≥98%** |
| **accounting completeness** | `accepted + repaired + unresolved == detected` | **100%** |
| **no unauthorised privacy** | facts reaching `notes` without a source privacy marker | **0** |
| **fabrication** | unbacked source-backed field values | **0** |
| **no regression** | corpus v1/v2, seg-v4 proofs, production smokes, full unit suite | all green |

### Why recall is now its own gate

`accepted + repaired + unresolved == detected` proves only that **detected**
claims were accounted for. It is silent about a claim the detector never raised —
which would be counted nowhere, repaired nowhere, and surfaced nowhere. That is
precisely the silent-loss failure this layer exists to end, reintroduced one
level up.

So recall is measured separately, and on explicit `Label: value` fixtures the
target is **100%**, not a percentage that sounds high. A detector that finds 97%
of clearly-labelled facts is a system that loses three in a hundred without ever
saying so.

### On the 8 → 1 replay

That figure is **feasibility evidence, not proof**. It was produced by a crude
offline matcher over captured output, and it says the approach is worth
building — nothing more.

**The decisive gate remains the flagged Class A implementation, followed by
repeated identical-input runs demonstrating deterministic semantic output.**
Until that has been run and reported, the design is a hypothesis.

## Minimum sequence to prove the approach

Steps 1–2 change no production behaviour and make **no model calls** — they
replay against the preserved run 1 / run 2 evidence.

**1. Reconciliation ledger, observe-only.**
Extend the chunk ledger with placement outcomes per claim. Inert, exactly as
0025 was: written, read by nothing, cleared by the same retention paths.

**2. Encode the precedence ladder, and replay it offline.**
Rungs 1–3 plus the claim parser, with tests. Replay over the captured evidence
and report: claims detected, placement before and after, run-to-run agreement,
repairs, and **every UNRESOLVED case by name**.
**This is the gate before any production change. If it does not converge the two
captured runs here, the design is wrong and nothing ships.**

**3. Flagged enforcement, Library import only.**
Rungs 1–2 applied for real, behind a flag. Proven by **repeated identical-input
runs demonstrating deterministic recipient-visible placement** — the decisive
gate, not the replay.

**4. The privacy rule, Library import.**
`notes` requires a source privacy marker. Rejected content is surfaced as
UNRESOLVED, never dropped.

**5. UNRESOLVED as a real state.**
Preserved verbatim, visibly marked on its record, resolvable by placing or
explicitly ignoring. Clean records save normally throughout.

**6. Packet ingestion inherits the privacy rule.**
Including the removal or replacement of `ambiguous -> notes`. **This work is not
complete until this step ships** — Library first is a bounded proof, not the
scope.

Each step ships separately behind its own gate. Steps 3–6 each require the full
gate table above to be green.

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

## Decisions taken (previously open)

- **Scalar vs prose is withdrawn.** Value shape may inform rendering; it never
  decides preservation. The boundary is claim vs not-a-claim, drawn by the parser.
- **No per-label ontology or configuration** is built.
- **No narrative field in this patch.** Paragraph-like content is UNRESOLVED. A
  first-class reusable public content concept is designed later, on its own
  terms, plausibly block-oriented.
- **The privacy rule extends to packet ingestion**, and this work is not complete
  until it does.
- **UNRESOLVED blocks the exception, not the import.** Clean records save
  normally; the unresolved claim is preserved and marked until resolved.
- **Recall is its own gate**, at 100% on controlled explicit-label fixtures.

## Still open

- Whether `address` belongs on rung 1 as a specialized destination or is left to
  model judgment — it is legitimately reformatted, which is why `source-backed.ts`
  deliberately excludes it from fabrication checks. Rung 1 placement and
  fabrication checking are separable concerns, but the design should say so
  explicitly rather than leave it implied.
- How an UNRESOLVED claim is represented in the Library payload once saved — it
  is not part of the entry's content, but it must survive the review screen.
