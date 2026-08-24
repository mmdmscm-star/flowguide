# Arm A2 decision rule — recorded BEFORE any call

A2 = production-faithful A, plus the SAME `LOSSLESS_RULES` block used in C2,
appended to whichever production prompt the chunk already uses (lead for chunk
0, sections otherwise). Nothing else differs: same boundaries, same model,
provider, temperature, max_tokens, corpora, scorer.

## PASS requires ALL of the following, against the paired A control

1. Omissions REDUCED. Mean omissions per repetition strictly lower than A.
2. Fabrication: not above A.
3. Unauthorized private notes: not above A.
4. Attribution/misbinding unresolved: not above A (A has measured 0).
5. Malformed responses: not above A (A has measured 0).
6. Accepted rate: no meaningful regression — not more than 1.0 percentage
   point below A.
7. No new duplication pathology. Measured, not eyeballed:
   - item count stays at 20 (one per source record);
   - repeated specifics WITHIN a single item (the same value emitted into two
     destinations) not materially above A;
   - output tokens not more than 1.5x A, which would indicate the model padding
     rather than preserving.

## Reported separately regardless of outcome

The 32 previously characterized whole-source omissions: how many A2 preserves,
split by the 26 C-specific and the 6 shared blind spots. The blind spots are
expected to remain — nothing in these rules addresses an unlabelled bare value
on its own line, and claiming them would mean the rules did something they
cannot do.

## Scope

Senior living first. Ice cream and cross-vertical run ONLY if senior improves
materially. No production change follows from any outcome.
