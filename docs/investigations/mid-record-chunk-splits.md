# Investigation: mid-record chunk splits (ingestion)

**Status:** diagnosis complete, proven from stored data. No code or data changed.
**Date:** 2026-08-07. **Reported by:** pasted-spreadsheet Organize producing a
fabricated item.

## Symptom as reported

A paste of three tab-separated spreadsheet rows (Atria Tamalpais Creek, AlmaVia
of San Rafael, Drake Terrace) was ingested with **Organize with AI** in four
chunks. Two items looked correct. The third produced *two* items:

- **Drake Terrace** — most of the record, and
- **Drake T Community Property** — a fabricated entity holding only
  `Community Fee — $15,000` and three photos.

No such community exists in the source.

## What was actually wrong

The reported fabrication is the **visible half**. The same defect silently
misattributed photos on the two items that looked correct, and in an earlier run
of the same input silently deleted three photos from a packet that was then
published.

## Evidence

`ingestion_chunks.segment_text` and `.result` are cleared on finalize, so
per-chunk model input/output is not directly recoverable. Segmentation is
deterministic, however, and `packets.raw_input` survives — so the plan was
recomputed and compared against the persisted plan.

**All four chunks match the persisted `source_start` / `source_end` /
`segment_hash` bit-for-bit, in both runs.**

| Chunk | Range | Begins with | Injected `section_hint` |
|---|---|---|---|
| 0 | [0, 2649) | Atria record start | `""` |
| 1 | [2649, 4650) | **Atria images 7–8** (orphans) | `Community Fee: Equal to One Month's Rent` |
| 2 | [4650, 7076) | **AlmaVia image 2** (orphan) | `Community Fee: $9,700` |
| 3 | [7076, 7361) | **Drake images 7–9, nothing else** | **`Community Fee: $15,000`** |

Record starts are at offsets 0, 2854, 4769. Cuts fall at 0, 2649, 4650, 7076 —
**two of three cuts land inside a record**, inside a quoted multiline cell.

## Causal chain

1. **The segmenter has no concept of a record.** `parseBlocks` splits on
   `/\n[ \t]*\n/` ([segmentation.ts:83](../../src/lib/segmentation.ts)) — a blank
   line is its only structural notion. Quoted photo cells contain blank lines
   between `Image N:` entries, so one spreadsheet row becomes many "blocks" and a
   cut can land mid-cell.
2. **Every chunk therefore opens with an orphan head** — trailing media
   belonging to the previous record.
3. **The pipeline then feeds the model text the chunk does not contain.**
   `nearestHeading(source, s.sourceStart)` scans `source.slice(0, offset)` —
   backwards, outside the chunk's own range
   ([ingestion.ts:26](../../src/lib/ingestion.ts)). URL lines are rejected as
   headings, so the scan walks back arbitrarily far. For chunk 3 it landed on
   `Community Fee: $15,000`, at offset 5677 — **1,399 chars before the chunk
   starts**, inside chunk 2. That string is prepended verbatim
   ([ingestion.ts:93](../../src/lib/ingestion.ts)):
   `userText = \`Section heading context: ${sectionHint}\n\n${segmentText}\``
4. **The schema requires a title and offers no way to return nothing.** Chunk 3's
   real content was three image URLs and a closing quote. The only nouns
   available were `DrakeT` in the filenames and `Community` in the injected hint.

### Where the fabricated title came from — proven

`Drake T` from the URL filename slugs (`96687DrakeT_kxiar0.jpg`). `Community`
and the entire `Community Fee = $15,000` detail from **FlowGuide's own injected
hint**, not from anything inside that chunk.

## Photo accounting

Run of 2026-08-07 (packet `1d1e9f41…`, draft): 19 in source, 19 stored, **0
duplicated, 0 lost, 0 fabricated — but 3 misattributed**.

| Photo | Belongs to | Stored on |
|---|---|---|
| `AtriaTC7`, `AtriaTC8` | Atria | **AlmaVia** |
| `96823AlmaViaSR` | AlmaVia | **Drake Terrace** |
| Drake images 7–9 | Drake | **the fabricated item** |

The rule is mechanical: *each chunk's orphan head is attributed to the first real
record in that chunk.* The two "correct" items were not correct.

## Reproducibility — and the more important finding

The chunk plan is 100% deterministic and was reproduced bit-for-bit. **The
symptom is not deterministic.** The same input, planned identically, produced two
different outcomes:

- **2026-08-07 run** → the model fabricated an item. Visible.
- **2026-08-05 run** → the model returned nothing usable for chunk 3, and those
  three photos were **silently dropped** (16 stored vs 19 in source). No error,
  no warning. That packet was **published**.

Fabrication and silent loss are the same defect. Fabrication is the lucky
outcome, because it is the only one a professional can see.

## Layer attribution

- **Chunk construction — primary**, on two independent counts: no record grammar,
  and a hint read from outside the chunk.
- **Model interpretation — amplifier**, not cause. Given a content-free segment
  and a required title, invention was the only schema-legal move.
- **Persistence — correct.** It faithfully stored what it was handed.
- **Reconciliation — no safety net.** Nothing checks that a produced item has any
  provenance in its own segment, and nothing accounts for source media.

## Scope

Only 2 ingestion runs have ever used the chunked path, both on this same source.
A vertical-agnostic sweep of all 440 items across 61 packets found exactly one
fragment-shaped item — this one.

Structurally, the exposure is every future multi-chunk ingestion of any source
whose records are not separated by exactly one blank line, or whose trailing
field is a media/URL list: CSV/TSV exports, JSON, YAML, markdown tables,
HTML-to-text. Nothing about this is senior-living-specific.

## Affected packets

Preserved unmodified as forensic evidence. See
[mid-record-chunk-splits-manifest.md](mid-record-chunk-splits-manifest.md).
Repair is deliberately **not** an active priority: the recent packet is internal
and the older one is disposable, so no recipient outreach and no exceptional
direct-write repair is warranted.

## Remedy

See [mid-record-chunk-splits-plan.md](mid-record-chunk-splits-plan.md).
