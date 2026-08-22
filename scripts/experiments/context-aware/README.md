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
