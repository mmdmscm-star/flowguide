# Design: media ownership provenance (Stage 2, narrowed)

**Status:** design agreed, not implemented. Supersedes the deferred "Stage 2"
sketch in [mid-record-chunk-splits-plan.md](mid-record-chunk-splits-plan.md).

Trigger: the 2026-08-14 client incident on packet `209679e2`, reconstructed in
[client-photo-ownership-incident.md](client-photo-ownership-incident.md). Stage 1
shipped exact media *accounting* and explicitly did not prove *ownership*. That
gap reached a real client packet.

## The problem in one line

> FlowGuide cannot currently show that a photo belonging to source entity A was
> not persisted onto entity B.

Two production incidents, one mechanism: a chunk boundary fell inside a source
record, the orphaned media at the head of the next chunk was absorbed by whatever
item that chunk did contain, and the totals still balanced. In the client
incident, **23 source photos and 23 stored rows concealed 8 photos on the wrong
community plus one fabricated item.**

## Governing principle (unchanged from Stage 1)

> **Structure authorizes. Heuristics only ask.**

Automatic correction requires an unambiguous structural basis. Anything softer
raises a question for the professional; it never silently answers one.

---

## What we are NOT building

- Field-level provenance for details, links, contacts or descriptions. Media is
  where the failure occurred and where misplacement is invisible to the eye.
- Any change to the item/photo model. This stays a pipeline + renderer concern.
- Re-processing of historical imports.
- The packet-title problem observed in the same run.

---

## An approach that was tested and rejected

The obvious cheap answer is to locate each item's title in `raw_input` and
attribute media to the nearest preceding title. **Measured against both
incidents, it is unsafe:**

| Item | Occurrences in source | |
|---|---|---|
| `Primrose Alzheimer's Living` | **0** | legitimate item; source header is just `Primrose` |
| `Drake T Community Property` | **0** | fabricated item |
| `The Reserve at Fountaingrove` | 3, none at line start | its record opens with `"` |
| others | 3–4 each | title recurs in header, pricing cell and description |

"Title not found in source" cannot distinguish a fabricated item from a
legitimately renamed one, and line-start anchoring breaks on quoted cells. A
blocking rule built on it would tell a professional that a correct packet is
wrong. **A regression test pins this so it is not reintroduced.**

---

## Architecture

### The invariant everything rests on

> **No chunk may contain a *partial* source record.**

A chunk's range is persisted and exact; a record's span is computed
structurally. If no chunk straddles a record boundary, then "which record
produced this item" is a *fact*, and ownership becomes arithmetic rather than
inference. A chunk may contain several *whole* records, and one oversized record
may span several chunks — both are safe. Only a partial record is not.

### Layer 1 — Robust record detection (seg-v4)

Replaces seg-v3's "every record must share one field count".

- Quote-aware scan per candidate delimiter (`\t`, `,`, `;`, `|`), trailing empty
  fields ignored (unchanged from seg-v3 — spreadsheet range selection pads rows).
- **Noise rows** are excluded from the shape test and attach to the preceding
  record's span. A row is noise only if it has ≤1 field **and** is either:
  1. pure punctuation/whitespace — `----`, `====`, `***`, `___`; or
  2. **FlowGuide's own generated append marker**, matched narrowly on our
     literal keyword rather than on "text between dashes":
     `/^-{3}\s*Added\b[^\n]*?-{3}$/` on the trimmed row. Both shapes we emit
     are covered — `--- Added ---` (finalize, SQL) and
     `--- Added Jun 30, 2026, 6:57 PM ---` (append routes, en-US
     `toLocaleString`). `--- Notes ---` and other bracketed prose are **not**
     noise.
- **Modal field count** across non-noise rows must be ≥2, and *every* non-noise
  row must match it. Genuinely ragged data still declines — that is real
  ambiguity, not cosmetics.
- A source that is **one record** is trivially aligned: any split falls inside
  that record, so ownership is unambiguous.

Rule (2) is not a general loosening; it is corpus-justified. See the scan below:
this marker is emitted by our own append flow and defeats detection in three of
the five sources that would otherwise block.

### Layer 2 — Loud unsafe fallback

The run records its detection outcome: delimiter, accepted, reason, record
count. Sources then classify as:

| Class | Meaning | Ownership |
|---|---|---|
| **aligned** | detection accepted, no chunk holds a partial record | verifiable |
| **structured-unaligned** | looks tabular (tabs + multi-field lines) but detection declined, or a chunk holds a partial record | **not verifiable** |
| **prose** | no tabular signal | not claimed |

`structured-unaligned` is the state that produced both incidents and today
passes in silence. It becomes explicit: recorded on the run, and — **when the
source contains media** — it puts the run into `needs_review`.

**Honest scope:** this design guarantees ownership for *structured* sources. For
prose it guarantees accounting, not ownership — but it does not stay silent
about that.

**The prose lane's user-facing behaviour is an explicit decision, not an
omission:**

| Prose source | Behaviour |
|---|---|
| no media | nothing |
| media, **0 or 1 item** | nothing — with one item, media cannot be misassigned |
| media, **2+ items** | **non-blocking advisory** in the review panel: *"FlowGuide couldn't confirm which item each photo belongs to — worth a quick check."* |

Non-blocking is deliberate. We have *absence of proof*, not evidence of a
problem, and blocking on that would train professionals to click through
warnings. But silence is the habit this whole design exists to break.

Corpus evidence for the size of this lane: **2 sources, 4 photos**, each
producing 2 items with 1 photo apiece. Both are the same "Most Popular National
Parks" packet. Small enough that an advisory is proportionate; not zero, so it
needs a decision.

### Layer 3 — Ownership verification (at finalize, and on demand)

Bind chunk→record structurally, then item→record via the chunk that produced it.

> For each media occurrence at offset *o* inside record R, the item holding it
> must belong to R.

A violation names the record the source puts the photo in. **A correction is
proposed only when it is uniquely resolvable**: R maps to chunks that produced
exactly one item. If R's chunks produced several items, the destination is
ambiguous and the professional is asked to assign it manually rather than being
offered a guess.

### Layer 4 — Occurrence-aware accounting (replaces Stage 1 counting)

Stage 1 deduplicated source URLs, so it could not tell an author who listed a
photo twice from a duplicate FlowGuide introduced. Both incidents contained the
former.

For each distinct URL: `sourceOccurrences` vs `storedRows`.

| Condition | Meaning |
|---|---|
| stored == source | correct |
| stored < source | occurrence(s) missing |
| stored > source | **duplicate introduced by FlowGuide** |
| stored > 0, source == 0 | not in source |

Accounting and ownership stay separate concerns. The client incident is exactly
why: `89033BrookPC` is listed **twice in the source** and was stored twice, so
occurrence-aware accounting reports it as *correct* — while ownership reports
that one of those copies sits on Primrose instead of Paulin Creek.

### Layer 5 — Revision-aware findings

Findings are a snapshot and go stale the moment the packet is edited. During the
incident the stored payload described problems the professional had already
fixed; acting on it would have "corrected" a photo that was already right.

- Every findings payload records the `content_rev` it was computed at.
- Findings are **recomputed** whenever `packets.content_rev` has moved, before
  they are displayed, before a correction is applied, and before publish is
  allowed.
- The DB trigger remains the backstop; the publish route refreshes first, so a
  professional who has already fixed everything is not blocked by a stale record.

### Layer 6 — A resolution path that ships with the block

**Blocking behaviour and the resolution UI ship in the same change.** No repeat
of a safety state with no exit.

- Blocks **publishing only**. The packet stays fully editable.
- Banner states the concrete problem: *"3 photos may be on the wrong
  community."*
- Each finding shows the photo, where it is now, where the source puts it, and:
  **Move to Brookdale Chanate** (only when uniquely resolvable) · **Assign to…**
  (picker, when ambiguous) · **Keep here** · **Remove**.
- **Apply all suggested moves** for the common case.
- For `structured-unaligned`: no per-photo proposals are possible, so the
  professional is told plainly that ownership could not be confirmed and is
  offered per-item assignment plus **Accept as-is**.
- Every choice is recorded on the run with a reason. Publishing unblocks when no
  finding is unresolved.

---

## Corpus scan (evidence for the above)

All 42 surviving `raw_input` values, classified under the current detector and
the proposal:

| | seg-v3 (shipped) | seg-v4 conservative | seg-v4 + append-marker + single-record |
|---|---|---|---|
| aligned | 10 | 13 | **16** |
| would block (structured + media) | n/a | 5 | **2** |

Newly aligned under seg-v4 include **the client incident source itself**
(`209679e2`, 4 records behind `----` separators) and two others.

The two that still block are genuine ambiguity, not cosmetics:

- `bb324174` — a flat 12-column table mixed with 99 single-field prose lines.
- `38c68f1c` — rows disagree on column count (6 vs 7) beyond any separator rule.

Three of the original five declined **only** because of our own append marker
(`--- Added <date> ---`), which is why rule (2) exists.

Distribution across all 42: 16 aligned, 16 structured-unaligned, 10 prose.

**Among the 19 sources that actually contain media** — the only ones where
ownership matters:

| Class | Sources | Photo occurrences |
|---|---|---|
| **aligned** | **15** | **345** |
| structured-unaligned | 2 | 56 |
| prose | 2 | 4 |

So ownership becomes verifiable for **15 of 19 media-bearing sources, covering
345 of 405 photo occurrences (85%)**. Quote that figure rather than 16/42:
alignment is only meaningful where there is media to misplace.

---

## Failure behaviour

| Condition | Publish | Editing | Surfaced as |
|---|---|---|---|
| aligned, ownership + accounting clean | allowed | — | nothing |
| aligned, ownership violation | **blocked** | allowed | violations, one-click move where unique |
| structured-unaligned **with media** | **blocked** | allowed | "couldn't confirm which entity these photos belong to" + manual assignment + accept-as-is |
| structured-unaligned, no media | allowed | — | recorded on the run only |
| prose, accounting clean | allowed | — | nothing |
| accounting failure (missing / FlowGuide-introduced duplicate) | **blocked** | allowed | as Stage 1, now occurrence-aware |
| item title not locatable in source | allowed | — | advisory only — never blocking |

---

## Migrations

- **None** for detection, classification, verification or accounting — findings
  fit the existing `ingestion_runs.review` jsonb, and `needs_review` already
  exists from 0013.
- **One migration (0014)** for resolution — *confirmed necessary after
  inspecting the existing path.* `update_item_content` (0011) is scoped to a
  single item: it locks the packet, then replaces that item's photos wholesale
  via `delete … where item_id = p_item_id`. Every other photo write in the
  schema is likewise single-item; **no RPC accepts two item ids**. Moving a
  photo from item A to item B through the existing writer therefore takes two
  separate calls — leaving a window where the photo is on both items or on
  neither — plus a third write to record the resolution on `ingestion_runs`.
  Three non-atomic writes fails the correctness bar, so 0014 adds one narrow,
  owner-scoped, draft-only RPC that applies the moves and records the resolution
  **in a single transaction**, with both items verified to belong to the same
  packet.
- `SEGMENTER_VERSION` → `seg-v4`. Version is per run and plans are frozen in
  `ingestion_chunks`, so in-flight runs keep their boundaries; no backfill.

---

## Tests

**Mandatory regression fixtures — both real incidents, PII sanitized.** Contact
names, phone numbers and email addresses are replaced; everything structural is
preserved byte-for-byte in the ways that matter: field counts, separator rows,
quoting, blank lines inside quoted cells, photo-cell shape, record lengths.

1. **Drake Terrace source** → 3 records, one chunk per record, zero photos
   separated from their record.
2. **Client source** → 4 records *despite* four `----` separators, 4 chunks not
   5, zero photos separated, **no content-free tail chunk**.
3. **Replay of both incidents' actual wrong assignments** → all 11 violations
   detected, each with the correct expected owner.
4. **False-positive guard** → the corrected packet yields zero violations.
5. **Anchor unreliability pinned** → `Primrose Alzheimer's Living` (0
   occurrences, legitimate) must not be flagged.
6. **Detection table** — separator styles accepted; append marker accepted;
   genuinely ragged declined; mixed table+prose declined; prose declined;
   unbalanced quotes declined; single-record source treated as aligned.
7. **Occurrence-aware accounting** — a URL listed twice in source and stored
   twice is *correct*; stored three times is a FlowGuide duplicate; stored once
   is a missing occurrence.
8. **Revision awareness** — findings computed at rev N are recomputed after an
   edit; a stale payload is never used to display, apply or gate publish.
9. **Oversized single record** spanning several chunks stays verifiable.
10. **Property** — chunk ranges continue to tile `[0, len)` exactly.

---

## Open questions

1. ~~Whether the resolution RPC can reuse the existing item-content writer.~~
   **Resolved:** it cannot, on atomicity grounds. See Migrations.
2. Whether `structured-unaligned` without media should be visible to the
   professional at all, or recorded only for diagnostics. Current proposal:
   recorded only.
3. One residual edge in the narrowed marker rule: a professional who literally
   types `--- Added photos from tour ---` produces a row we treat as a
   separator. It is a single-field row either way, so the consequence is
   limited, and requiring our literal `Added` keyword keeps the exposure small.
