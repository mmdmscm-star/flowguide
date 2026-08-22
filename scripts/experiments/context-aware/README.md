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
