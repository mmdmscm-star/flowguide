# Parked, not abandoned

## `tabular-short-row-detection.patch`

Lets `detectSourceRecords` accept a row that is SHORT provided it still carries
the table's delimiter slots — a blank trailing cell rather than an absent one.
Fixes an ordinary spreadsheet paste whose last row has an empty final column.

**Measured:** record detection 4/16 → 5/16 on the reliability corpus, every
previously-correct detection unchanged, no false positives, full suite green.

**Why it is parked (2026-08-25):** the benefit is one input, and applying it
requires bumping `SEGMENTER_VERSION`, which makes every existing run's ownership
check return `declined / segmenter_changed`. That is non-blocking by design but
it is a behaviour change for all published packets, and 4/16 → 5/16 does not pay
for it — especially since record detection turned out not to equal governance
coverage (the newly-detected input governed 2 of its 4 items).

Apply with `git apply docs/parked/tabular-short-row-detection.patch`.

Two rejected variants are recorded in the patch's own comments, because both
looked correct and were not:
  * counting trailing empties reverses a documented fix for Excel padding;
  * `fields <= mode` lets a user's stray line be absorbed into a table as a row,
    which an existing test in segmentation-incidents proves must decline.
