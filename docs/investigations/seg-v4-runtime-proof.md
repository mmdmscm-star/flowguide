# seg-v4 — production-runtime proof

**Status: PASSED, 2026-08-18. 21/21, cleanup clean.**

Script: `scripts/ingestion-runtime/verify-seg-v4.mts`

```bash
FLOWGUIDE_RT_CONFIRM=1 npx tsx scripts/ingestion-runtime/verify-seg-v4.mts
```

Real routes, real model, real database, disposable data. ~4 model calls, ~33s.

---

## Why a runtime proof

`segmentation-incidents.test.mts` already pins `detectSourceRecords` against this
source. What a unit test cannot show is that **the run uses it**: that the plan
persisted to `ingestion_chunks` is the record-aligned one, that `finalize` writes
complete provenance for what the model actually emitted, that
`source_offset_base` locates the slice the hashes were measured against, and
that ownership recomputation therefore comes back **answered** rather than
declining.

Those are properties of the pipeline, not of a function. seg-v4 was explicitly
withheld from production in `aa87636` for exactly this reason — no end-to-end
proof.

## The fixture is the incident

`CLIENT_SOURCE` — packet 209679e2, 2026-08-14 — PII-sanitized at identical byte
lengths so budget-driven boundaries are preserved. Four TSV records separated by
cosmetic `----` rows.

Under **seg-v3** the detector saw field counts `[6,1]`, declined, and fell back to
blank-line blocks. Every record was cut, 8 of 24 photo occurrences were orphaned,
and a 118-char photo-only tail chunk was left, from which the model fabricated a
fifth item: **"Primrose Photo 4"**.

Every assertion is that failure stated as its negation.

## Results

| # | Assertion | Result |
|---|---|---|
| 1 | organize accepted (201) | PASS |
| 2 | the import finalized | PASS |
| 3 | the run is recorded as seg-v4 | PASS |
| 4 | `source_offset_base` locates the exact slice the hashes were measured against | PASS |
| 5 | leaf chunks tile the whole source, no gap or overlap | PASS |
| 6 | **NO chunk boundary falls inside a source record** | PASS |
| 7 | the structured records survived the separator rows (4 found) | PASS |
| 8 | every media occurrence sits inside a source record (24/24) | PASS |
| 9 | every media occurrence's chunk contains that media's WHOLE record | PASS |
| 10 | **no chunk carries media without the record that owns it** | PASS |
| 11 | one item per source record — nothing fabricated, nothing lost | PASS |
| 12 | no item is named after a photo cell | PASS |
| 13 | every item records the run that made it | PASS |
| 14 | every item records a chunk ordinal and an emit index | PASS |
| 15 | emit indices are dense `0..n-1` within every chunk | PASS |
| 16 | ownership recomputation is available, not unavailable | PASS |
| 17 | ownership was actually CHECKED, not declined | PASS |
| 18 | a clean import produces NO ownership findings | PASS |
| 19 | and therefore nothing blocking | PASS |
| 20 | publishing is not blocked by OWNERSHIP | PASS |
| 21 | the packet publishes | PASS |

Run shape: `chars=9885 initialChunks=4 leaves=4 splits=0 retries=0`,
4 model calls, 33.2s. Cleanup: 0 packets, 0 users, 0 tagged users remaining.

Assertions 6 and 10 are the incident directly: seg-v3 cut all four records and
left the photo-only tail. Assertion 11 is the fabricated item.

## What the first run surfaced — and it was not segmentation

The first run scored 19/20. Every seg-v4 assertion passed; **publish** returned
`409 import_needs_review — "1 photo is missing"`, from the media ledger.

Cause: record 2 (Brookdale Paulin Creek) holds **8 media occurrences but 7
distinct URLs** — `89033BrookPC` is listed twice in the source on purpose. The
ledger is deliberately occurrence-aware, and
[media-ownership-provenance.md](media-ownership-provenance.md) records that in
the original production run the model stored it twice, so accounting called it
correct. This run the model stored it **once**: `stored(1) < source(2)` →
`media_missing` → `needs_review` → publish blocked.

So a correct import was parked in a review state whose only exit is discarding
the import, and told the professional a photo was missing from a packet holding
every distinct photo in its source.

**Fixed by changing the consequence, not the evidence** — see
`src/lib/media-ledger.ts`. The ledger stays occurrence-aware; the discriminator
is *record spread*:

| Condition | Code | Blocks |
|---|---|---|
| stored 0 | `media_missing` | yes |
| stored < source, **1 record** | `media_consolidated` | **no — advisory** |
| stored < source, **>1 record** | `media_missing` | yes |
| stored > source | `media_duplicated` | yes |

The third row is the one that matters: two records listing the same photo are two
*placements*, and losing one loses a placement. Sources with no detectable
records — prose — downgrade nothing.

Two defects in the proof script itself were fixed alongside: it destroyed its own
evidence by cleaning up before diagnosis, and it reported a publish refusal
without naming which gate refused, blaming segmentation for an accounting result.

## What this proof does NOT establish

- **Only this fixture's shape.** Tabular TSV with cosmetic separator rows. The
  Drake source (quoted photo cells containing blank lines) is covered by unit
  tests, not by this runtime proof.
- **Nothing about pre-seg-v4 packets.** Existing production packets are seg-v3
  and will decline on a version mismatch after deploy — nonblocking by design.
  See "historical ownership recovery where provable" in
  `docs/migrations/0016-deployment.md`.
- **One run.** The model varied between the two runs here, which is precisely how
  the ledger issue surfaced. A pass is evidence, not a guarantee of determinism.
