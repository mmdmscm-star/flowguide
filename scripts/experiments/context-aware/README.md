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
