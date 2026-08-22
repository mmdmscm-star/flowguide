# Context-aware ingestion experiment

Offline. No database, no production configuration. `REPS=3` over three corpora
and three arms; every raw response is written to `out/` before anything is
scored.

    FLOWGUIDE_EXP_CONFIRM=1 REPS=3 npx tsx scripts/experiments/context-aware/run.mts
    npx tsx scripts/experiments/context-aware/report.mts

`out-v1-contaminated/` is the FIRST run, kept deliberately. Its arm-B source map
contained "a recurring label and its value belong together as one detail on that
record" — a destination instruction. The model read the recurring-label list as
an allowlist and dropped every unlisted field, and moved phones out of contacts
into Details. That run measured the instruction, not the context. Its timings
are also wrong: the clock was stamped when fetch() resolved (headers) rather
than when the body arrived, reporting ~10,000 tok/s where the provider does 363.

Both defects are fixed in the current harness. The contaminated output is kept
because the allowlist artifact is a finding in its own right: a structural map
that names a subset of fields will be read as naming ALL the fields that matter.

## v3 (paired A vs B2) — INVALID, credit-exhausted

`out-v3-INVALID-credit-exhausted/` is a partial run and must not be scored. The
API key hit its own $20 spending limit partway through: OpenRouter reserves
`max_tokens` UP FRONT, so once the remaining key budget fell below the 24,000
token reservation every subsequent call was refused before generating anything.
The refusals surface as `malformed`, which is why the log shows runs of
"0 items, 0 accepted" completing in 0.4s.

Only `senior/A` r1-r3 completed. `senior/B2/r1` is partial (8 items, 10 refused);
everything after it is refusals.

The fix is NOT to lower `max_tokens` — that changes the generation settings the
experiment is required to hold constant, and would make the arms
non-comparable with the earlier runs.

## Outcome: STOP. The gain was directive framing, not structural facts.

Three paired runs, same gate throughout:

| run | arm | senior acc% | senior whole-item consistency |
| --- | --- | --- | --- |
| v4 | A / B2 (facts + 2 instructions) | 71.4 / **76.1** | 4/20 / **14/20** |
| v5 | A / B3 (facts only)             | 71.5 / 72.9 | 3/20 / **2/20** |

Removing exactly two instructional sentences removed the entire stability gain.
The structural FACTS - record count, delimiter, column count, opaque ordinal
range, segment position - do nothing on their own. What worked was telling the
model to copy literally and stay inside its segment, and that is the same
mechanism that changed how titles were formed.

### A correction

The v4 verdict "B2 regresses ice-cream titles" is NOT established. In v5, arm A
itself produced the city-suffixed titles in two of three repetitions and the
bare names in the third. The title convention is A's own nondeterminism. v4
compared a stable arm against an oscillating one and read one side of the
oscillation as the baseline. Phones and websites were byte-identical in every
pairing.

### What is and is not known

KNOWN: current chunking is stable in accuracy and unstable in output identity
(A holds 3-4 of 20 items constant across three runs, in every run measured).

KNOWN: purely factual structural metadata does not fix that.

MEASURED ONCE, NOT REPLICATED: the B2 configuration reached 14/20. A single
three-repetition observation of a large effect, whose mechanism appears to be
directive framing with side effects we do not understand well enough to ship.

NOT PURSUED: B4. The decision rule said to stop rather than keep tuning, and
the mechanism found is not the one the experiment set out to exploit.

## Arm O (orientation before execution) — the answer is NO

Paired, counterbalanced, 3 repetitions. Senior living, the primary corpus:

| | A | O |
| --- | --- | --- |
| accepted rate | 71.7% | 72.7% (+1.0pp; rule required +3) |
| whole-item consistency | 5/20 | **0/20** (rule required +5) |
| cross-record leakage | 0 | **1** (a URL from a chunk that never held it) |

Consistency fell on EVERY corpus: senior 5/20 -> 0/20, ice cream 6/15 -> 1/15,
cross-vertical 4/4 -> 3/4.

The mechanism is visible in the briefs. They agree with each other only 35-49%
by vocabulary across repetitions - the orientation is itself nondeterministic.
Handing each run a different understanding of the document makes the downstream
output MORE variable, not less. Orientation does not damp the existing
nondeterminism; it adds a second source of it.

The briefs are otherwise good: genuinely source-level prose about shape rather
than contents, no covert extraction in 8 of 9. The exception is senior r1, which
wrote an aggregate price range ("$3,000 to over $15,000") - two record-derived
values, and a violation of the predeclared zero-specifics rule even though it
reads as a summary rather than a copy.

Predeclared rule failed on: accepted margin, consistency, leakage, and brief
validity. No production change follows.

## C2 — whole source plus a horizontal lossless-organization contract

Generic rules only: every distinct claim represented, multiple values of a kind
are separate facts, enumerations not collapsed, apparent redundancy is not
permission to omit, presentation may change but factual content may not shrink.
No field, domain or value kind is named. C2 is C as a strict prefix plus this
block.

| senior | A | C | C2 |
| --- | --- | --- | --- |
| accepted rate | 71.7% | 70.7% | **74.6%** |
| omissions (of 429) | 19.7 | 32.0 | 23.0 |
| fabrication | 0.0 | 1.0 | 0.0 |
| seconds | 133 (17 calls) | 154 | 304 |

Of the 26 C-specific omissions: 8 recovered in every repetition (all from one
dense enumerated line), 18 still missing in every repetition (16 secondary
contact phones, 2 URLs), 0 intermittent, 0 new omissions introduced.

The contract works SELECTIVELY. "Do not collapse an enumeration" was accepted.
"Two values of the same kind are two facts" was not - the model still treats a
contact's second phone as redundant with their first. A generic no-reduction
rule does not reach a per-entity judgement about duplication.

Controls pass: ice cream 100% accepted, 0 omissions, 0 fabrication. Cross
vertical 80.7% vs A's 80.0%, 1 omission both.

### The cost is reliability, and it is not confined to the large corpus

3 of 15 C2 whole-source calls hung and terminated (senior twice, ice cream
once), at 736-1339s. Arm C never did this in 9 calls. Successful C2 calls also
vary wildly for identical input: ice cream ran 397s and 37s on the same source.
Arm C ran it in 35s every time.

A single call that usually takes 5 minutes and sometimes dies at 20 is not a
viable interactive import path, however good its output is.

### Harness defects found in this arm, all client-side

1. A 300s AbortSignal - too low for a legitimate 258s generation, and
   ineffective anyway since it covers the fetch, not the body stream.
2. The response envelope was discarded, turning a diagnosable upstream failure
   into an opaque "unparseable_json".
3. `res.json()` silently returned null on bodies carrying the gateway's SSE
   keepalive lines, so three successful generations were recorded as "no
   content" after 13-21 minutes. The payload was there; the parser never saw it.

Each was hidden by the previous one. None touched model, provider, temperature,
max_tokens, prompts, corpora or scoring.
