# Incident: photo ownership failure on a live client packet

**Date:** 2026-08-14. **Packet:** `209679e2` "Possible Communities for Jane".
**Run:** `e017d1d7` (organize, seg-v3, 5 chunks, finalized 19:18:36).
Read-only forensic reconstruction; no data was altered by the investigation.

## What the professional saw

Photo assignments could not be trusted: some communities had too few photos, and
a fabricated standalone item named **`Primrose Photo 4`** held a photo belonging
to a real community. The packet was manually repaired and published under time
pressure, then blocked from publishing by the Stage 1 guard with no in-product
way to resolve it.

## Evidence: what survived, what did not

**Survived:** `packets.raw_input` (9,885 chars); run metadata
(`source_hash b7616973269d`, `segmenter_version seg-v3`, 5/5 chunks); the full
chunk plan with exact offsets and hashes; the original review payload (preserved
under `review.original_finding`); all four item rows, created at the finalize
timestamp `19:18:36.969999`.

**Destroyed or never existed:** `segment_text` and `result` on all five chunks
(cleared on finalize by design — no model outputs survive); `source_text`;
**every import-created photo row** (the manual repair replaced them — surviving
`item_photos.created_at` are 19:39, 19:41, 19:45, 20:27, all after the import);
the `Primrose Photo 4` item; content-revision history; deletion history.

The chunk plan was **recomputed from `raw_input` and matches the persisted
offsets and hashes bit-for-bit**, so segmentation is fully recoverable even
though the outputs are not.

## Root cause (proven)

The source contained four cosmetic separator lines between communities:
`-------------`, `-------`, `--------`, `----`.

seg-v3 requires an identical top-level field count across all records. The four
real records scan as 6 fields; the four separator lines scan as 1. So:

```
distinct field counts: [6, 1]  →  detector DECLINES
→ falls back to blank-line block segmentation (pre-Stage-1 behaviour)
```

**Counterfactual:** removing only those four lines, the detector accepts and
produces **4 chunks — one per community, zero photos separated**. With them: 5
chunks, and **every record cut mid-way**.

| Chunk | Range | Contents |
|---|---|---|
| 0 | [0, 2856) | Reserve record + its images 1–3 |
| 1 | [2856, 5125) | **Reserve images 4–5 (orphaned)** + Chanate record + Chanate 1–5 |
| 2 | [5125, 7751) | **Chanate images 6–7 (orphaned)** + Paulin Creek record + PC 1–5 |
| 3 | [7751, 9767) | **PC images 6–8 (orphaned)** + Primrose record + Primrose 1–3 |
| 4 | [9767, 9885) | **Primrose image 4 only — no record** |

**8 of 24 photo occurrences were separated from their community's chunk.**

Chunk 4 verbatim is 118 characters; after stripping URLs, five letters remain
("Image"). Handed a content-free chunk under a schema requiring a title, the
model composed one from the filename `Primrose4` → **`Primrose Photo 4`**. This
is the identical mechanism that produced `Drake T Community Property` from
`96687DrakeT` in the earlier incident.

## Ownership reconstruction

Source expectation (proven from `raw_input`): Reserve 5, Chanate 7, Paulin Creek
8 occurrences / 7 unique (`89033` is listed **twice in the source**), Primrose 4.
24 occurrences, 23 unique.

Predicted from the chunk plan vs the professional's pre-repair screenshots:

| Item | Chunk gave it | Screenshot | |
|---|---|---|---|
| Reserve | 3 | 3 | ✅ |
| Chanate | 7 available | 6 | ✅ minus one |
| Paulin Creek | 7 | 7 | ✅ |
| Primrose | 6 | 6 | ✅ |
| `Primrose Photo 4` | 1 | 1 | ✅ |

Four of five match exactly; the fifth differs by exactly the photo the ledger
independently flagged as `media_missing` (`BrookdaleCha3`). Two independent
sources agreeing.

Net: Reserve too few (3 of 5); Chanate holding two of Reserve's and missing one
of its own; Paulin Creek holding two of Chanate's; Primrose holding three of
Paulin Creek's; one fabricated item; one photo genuinely lost.

## Layer attribution

- **Source data** — contributing, not causal. The separators are legitimate
  formatting; the duplicated URL is genuinely in the input.
- **Segmentation** — **root cause.** Detector declined on a technicality and fell
  back silently.
- **Model** — behaved reasonably. Each chunk contained exactly one real
  community, so attaching that chunk's photos to it was locally correct. It
  identified all four real communities. Its only outright error was chunk 4,
  where it had no legal alternative.
- **Persistence** — no defect; stored faithfully what it was given.
- **Reconciliation** — the missing layer. `is_continuation` was **true for chunks
  1–4**: the system knew each began mid-record and used that only for section
  grouping, never for media.

## Stage 1 assessment

**Protected:** the run finalized honestly, publishing was blocked, and the two
count-level faults were caught. The `nearestHeading` fix held — `section_hint`
was empty on all five chunks.

**Failed to protect:** record-atomic segmentation **was not operating** — it
declined and fell back silently, the documented "degrades silently when detection
fails" risk realised in production. `needs_review` reported 2 problems when the
truth was 8 misplacements plus a fabricated item. **23 source / 23 stored**
concealed the failure entirely, because theft is conservative: every stolen photo
landed somewhere.

**Why the professional could not recover:** the resolution UI was designed but
never built, so a guard that could stop them offered no way through. They needed
database access to publish their own packet, mid-crisis, for a real client.

## Consequences

1. Detection must tolerate cosmetic separators — see
   [media-ownership-provenance.md](media-ownership-provenance.md) Layer 1.
2. Silent fallback must end — Layer 2.
3. Accounting must become ownership-aware — Layer 3.
4. Findings must be revision-aware. The stored payload was computed at 19:18 and
   described problems already fixed by 20:13; acting on it would have "corrected"
   a photo that was already right.
5. A block must never ship without its exit — Layer 6.
