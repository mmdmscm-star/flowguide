# Library → Import with AI — reuse assessment

**Requested before any implementation.** The question is narrow: *can the
existing ingestion architecture be reused cleanly for the Library as another
destination, and what is the narrow plan?*

Conclusion first: **half of it reuses exactly, and half of it does not — and the
split is clean enough to build on.** The model-extraction half is already
packet-independent and already emits precisely the shape a Library entry needs.
The run/durability half is structurally packet-anchored in a way that cannot be
loosened cheaply, and should not be loosened for this.

## What reuses exactly, with no changes

| Piece | Packet coupling |
|---|---|
| `src/lib/segmentation.ts` | none — text in, ranges out |
| `processSegment` (`src/lib/ingestion.ts`) | none — takes `segmentText`, `entryPoint`, a `packetType` **string**, an API key |
| `src/lib/ingest-validate.ts` | none — validates result shape |
| `normalizeItemContent` (`src/lib/item-content.ts`) | none — already the canonical shape both editors and the Library speak |
| `createLibraryItem` + duplicate warning | already exists |

The load-bearing detail: the **`section_append` entry point already returns
`{ items: [...] }`** — a bare list with `title`, `address`, `description`,
`notes`, `details`, `links`, `photos`, `contacts`. That is the same eight fields
as `ItemContentPayload`. A Library import needs **no new prompt, no new
validator, and no new result shape**. It needs the one that already exists for
"add items to this section", pointed somewhere else.

## What does not reuse

`ingestion_runs.packet_id` is `not null references packets(id) on delete
cascade`, and a great deal is built on that not being optional:

- `baseline_section_count`, `baseline_item_count`, `baseline_content_rev` — the
  change-detection that refuses to finalize into a packet that moved
- `idx_ingestion_runs_one_active` — one active run **per packet**, enforced in
  the database rather than the UI
- the `content_rev` bump triggers on every canonical content mutation
- `finalize_ingestion_run` — 167 lines that write sections and items into a
  packet, re-created again in 0014 to carry provenance
- discard's "delete the empty draft this run created" rule, keyed on
  `packets.origin_ingestion_run_id`

None of that is incidental. It is the hardening that came out of 0012 and 0014,
and it exists because finalizing into a live packet is genuinely dangerous.
**Finalizing into the Library is not dangerous in the same way** — there is no
recipient-visible document to corrupt, no composition invariant to violate, no
`content_rev` race, and nothing already sent.

## The three options, and why one wins

**A. Make runs destination-agnostic** (`packet_id` nullable, a second finalize
RPC). This unwinds the baselines, the one-active-run index, the bump triggers,
the discard rule, and both finalize functions — the most carefully hardened part
of the system — to gain durability guarantees the Library does not need.
Rejected: expensive, and it makes the packet path riskier to buy the Library
something cheap.

**B. Reuse the extraction, not the run.** A separate, much smaller Library import
path that calls the *same* segmentation and `processSegment` with
`entryPoint: "section_append"`, reviews the proposed items in the browser, and
writes the chosen ones through the Library's existing create path. Touches
`ingestion_runs` not at all.

**C. Import into a hidden scratch FlowGuide.** Reuses everything and requires
creating a fake FlowGuide — the exact thing this feature exists to avoid. It is
a second source of truth wearing a disguise. Rejected.

**Recommendation: B.**

## What B costs, stated plainly

A Library import would **not be resumable**. If the tab closes mid-import, the
work is lost and the paste has to be redone. The packet path earns its
resumability because an Organize run can be forty communities and several
minutes; a Library import is a handful of reusable things a professional already
has written down. If that turns out to be wrong in use, the fix is to add a
staging table for Library imports — not to make `ingestion_runs` polymorphic.

This is a real trade-off, not a technicality, and it is the one thing worth
disagreeing with in this plan.

## Narrow plan

1. **`POST /api/library/import`** — owner-scoped. Takes pasted text. Segments it,
   runs each segment through `processSegment` with `entryPoint: "section_append"`,
   validates, normalizes, and returns **proposed items only**. Writes nothing.
2. **Review step in `/library`** — the proposals render in `LibraryList`'s
   selectable mode, nothing preselected (same rule as bulk promotion), each one
   openable in `BlockItemEditor` to edit before saving.
3. **Save** — the selected proposals go through the same `POST /api/library`
   direct-write path that already exists, so they get the same duplicate warning
   and the same normalization. No lineage, because there is no packet item.
4. **Empty state** — "Import with AI" joins "Create an item" and "Save from a
   FlowGuide" as the third way to fill an empty Library.

No new tables. No migration. No change to `ingestion_runs`, `finalize_ingestion_run`,
or any packet path.

## What this must not become

- Not a second packet format, and not a Library-specific content shape.
- Not a live binding: an import **seeds** Library entries and disconnects, exactly
  as `product-direction.md` requires of every input.
- Not a reason to make ingestion polymorphic before there is evidence the Library
  needs run-grade durability.
