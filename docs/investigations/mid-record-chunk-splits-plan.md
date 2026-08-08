# Plan: ingestion boundary integrity

Remedy for [mid-record-chunk-splits.md](mid-record-chunk-splits.md). Nothing here
is implemented. Packet repair is explicitly **out of scope** (see the manifest).

## Governing principle

> **Structure authorizes. Heuristics only ask.**

Automatic attachment of content to an entity requires an *unambiguous structural
basis* — a detected record boundary that provably contains the content. Signals
that are merely suggestive (title-token overlap, positional adjacency to the
previous item) are **review triggers, never proof of ownership**. A heuristic may
raise a question; it may not silently answer one.

The corollary matters as much: FlowGuide must never resolve uncertainty by
discarding content or by attaching it somewhere plausible. Both failure modes are
invisible to the professional, and invisibility is what made this bug expensive.

## Decisions taken

1. **No source text may be injected from outside a chunk's own primary range.**
2. **Any chunk — including the first — may legitimately return zero items.** The
   *run* must produce useful output; an individual chunk must never be forced to
   invent an entity.
3. **Quote-aware, record-atomic segmentation** when structured TSV/CSV-like input
   is detectable on strong structural evidence.
4. **Chunk boundaries must not determine semantic section grouping.** One pasted
   table becoming one section is the correct outcome.
5. **Exact media accounting.** Every source media URL ends as *stored*,
   *deliberately rejected with a reason*, or *surfaced for review*.
6. **Accounting failures place the run into `needs_review`**, not an internal
   warning.
7. **Heuristic concerns request review** rather than discarding or attaching.
8. **Neither token overlap nor adjacency alone proves ownership.**

Decision 7 is a deliberate revision of an earlier draft that would have *stripped*
ungrounded items. Stripping is silent discard, which decision 5 forbids.

---

## Stage 1 — Containment and prevention

Ships together. No continuation protocol, no provenance schema.

### 1.1 Remove out-of-range context injection

Delete the `nearestHeading` back-scan and the `Section heading context:` prefix.
A chunk's model input becomes exactly its own `segment_text`. This alone removes
the mechanism that supplied both the fabricated title's noun and its only detail.

Section titles must then come from headings appearing **inside a chunk's own
text**. `segment()`'s `flush()` already peels a trailing heading forward so a
heading always leads the chunk it introduces, which is what makes this safe.

### 1.2 Any chunk may return zero items

- **Prompt:** add an explicit escape hatch — if a segment contains no
  item-bearing text of its own (e.g. it is only the tail of media URLs belonging
  to something described earlier), return an empty list; never invent an entity
  and never derive a title from a URL or file name.
- **Schema/validation:** an empty result is a legal terminal state for *any*
  chunk, including ordinal 0.
- **Run-level guard replaces the per-chunk guard.** The existing
  `no_items` / `no_usable_item` protections move to finalize: the *run* must have
  produced at least one item, or the run enters `needs_review`. This preserves
  the "successful import that added nothing" protection without forcing any
  individual chunk to invent something.

### 1.3 Record-atomic segmentation

A quote-state pre-pass in `segmentation.ts`, beside `parseBlocks`:

- `scanRecords(source, delim)` — one left-to-right pass carrying RFC4180
  `inQuotes` (`""` inside quotes is a literal). Inside a quoted field, newlines
  and delimiters are field-internal. Returns record start offsets and top-level
  field counts, or `null` if quoting is unbalanced at EOF.
- `detectRecords(source)` — tries `\t`, `,`, `;`, `|`. Accepts only on **strong
  structural evidence**: every record having an *identical* top-level field
  count, plus a minimum record/field count, plus (for non-tab delimiters) at
  least one record spanning multiple lines. Returns `Block[]` in the existing
  shape, one per record.
- `segment()` changes by one line: `detectRecords(src) ?? parseBlocks(src)`.
- `splitRange()` gains record starts as its top boundary preference, so adaptive
  re-split also refuses to cut inside a record.

**Scan, never rewrite.** The persistence contract depends on
`segment.text === source.slice(start, end)` and on ranges tiling `[0, len)`
exactly. Masking quoted newlines would create a second representation of the same
input; a quote-state scan yields the same information as offsets with zero
mutation.

On the reported input this yields **3 chunks, one per record** — the orphan heads
and the content-free chunk 3 cease to exist.

`SEGMENTER_VERSION` bumps to `seg-v3`. Version is per run and plans are frozen in
`ingestion_chunks`, so in-flight runs keep their boundaries and nothing is
backfilled.

### 1.4 Section grouping decoupled from chunking

Section identity derives from headings found in a chunk's own text, never from
`is_continuation` or chunk adjacency. When records are detected, the table is one
section. A source with genuine headings still yields multiple sections because
those headings are inside the segments.

### 1.5 Exact media accounting

At **finalize** — never per chunk, because per-chunk accounting would require
cross-chunk visibility and break the concurrent claim model.

Every media URL in `raw_input` must resolve to exactly one of:

| Disposition | Meaning |
|---|---|
| **stored** | present on exactly one item |
| **rejected** | recorded with an explicit machine-readable reason |
| **unresolved** | anything else ⇒ the run enters `needs_review` |

Also flagged: a URL stored on **more than one** item, and a URL stored that does
not appear in the source at all.

Note what Stage 1 accounting can and cannot see. It proves nothing was *lost* or
*duplicated*. It cannot by itself prove a stored photo sits on the *right* item —
that requires provenance, which is Stage 2. Stage 1 therefore closes the silent
**loss** hole; the silent **misattribution** hole closes in Stage 2, and record
atomicity (1.3) removes its main cause in the meantime.

### 1.6 `needs_review` run state

A non-terminal run status. Entered on: unresolved media, a run that produced no
items at all, an item whose title has no support in its own segment, or any
ambiguity a later stage cannot resolve structurally.

---

## Stage 2 — Durable continuation handling

For entities that genuinely exceed the chunk budget or cannot be kept intact —
the case no segmentation can prevent, since a single record larger than the
budget *must* be split.

### 2.1 Provenance

Every staged item records the source range it was derived from. Provenance is
computed, not asserted by the model: the item's title is located within the
chunk's own `segment_text`. An item whose title cannot be located has **no**
provenance — that is a review trigger, not grounds for deletion.

Provenance makes the ownership question arithmetic: a media URL's source offset
either falls inside its item's span or it does not.

### 2.2 Explicit continuation protocol

A chunk may return, instead of new items, **continuation contributions**: fields
carrying their own source ranges. The model never names a target — it cannot,
since chunks are claimed concurrently and the target item may not exist yet. It
only reports *this content is a continuation, and here is where it came from*.

Resolution happens at finalize, where all leaves exist and are already walked in
`source_start` order:

- The contribution's range falls inside exactly one **detected record span**, and
  that record maps to exactly one item ⇒ **attach** (structural basis).
- Otherwise — no record structure, a gap, or more than one candidate ⇒
  **`needs_review`**. Content is held, never guessed at, never dropped.

Adjacency may *order* the candidates presented for review. It may not select one.

---

## What is deliberately not being built

- Mechanical attachment of orphan heads to the previous chunk's last item.
  Correct for the reported input, but it invents a second silent-misattribution
  mode for sources where the orphan belongs to a *later* entity.
- Stripping ungrounded items. Silent discard.
- Any title, name, address, price, or photo heuristic tied to a vertical.

## Open question

Record-atomic chunking may exceed `maxChars` by up to one record, and a single
record larger than the pre-split threshold is still cut internally. Suppressing
pre-split for one-record chunks trades a guaranteed-correct boundary for timeout
risk against the 60s ceiling. That should be a separate, evidence-driven decision
once Stage 2 exists to catch the split safely.
