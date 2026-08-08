# Forensic manifest: packets affected by mid-record chunk splits

Companion to [mid-record-chunk-splits.md](mid-record-chunk-splits.md).

**Status: preserved as evidence. Repair is NOT an active priority.** The recent
packet is internal; the older one is disposable or can be pulled. No recipient
outreach and no exceptional direct-write repair is warranted. This document
exists so the damage is recorded precisely while the packets remain untouched —
and so that if repair is ever chosen, it can be done from a written reference
rather than re-derived. There is no soft-delete and no audit table, so this
manifest is also the only rollback plan a repair would have.

Captured 2026-08-07 by read-only inspection. Nothing was modified.

## Ground truth

Record spans in `packets.raw_input` (byte-identical in both packets, 7,361 chars,
`source_hash 24eab8fe1cc1`):

| Record | Span |
|---|---|
| Atria Tamalpais Creek | `[0, 2854)` |
| AlmaVia of San Rafael | `[2854, 4769)` |
| Drake Terrace | `[4769, 7361)` |

Correct ownership: **Atria 8, AlmaVia 2, Drake 9 = 19 photos.** The source's own
`Image N:` numbering (1–8, 1–2, 1–9) confirms the span arithmetic independently.
All 19 URLs are unique; every stored URL matches its source byte-for-byte.

`item_photos` columns: `id, item_id, storage_path, url, sort_order, created_at`.
`storage_path` is `not null default ''` and is `''` on every live row. There is
**no unique index on `(item_id, sort_order)`**.

## Packet A — `1d1e9f41-6821-4dc7-8e65-35ce53859a14`

Draft, slug `la20p15q7r364gifi7mukz`, `composition_mode = legacy`, 0
`packet_blocks`. Section `2ea0ef57-fc66-49f6-b516-561848e504d8`. 19 photo rows.
Run `74a9ff97-2302-4ad2-8738-4f12b023db26`, finalized.

**Damage:** one fabricated item, three cross-record misattributions. No loss.

| Photo row id | URL basename | Currently on | Belongs to |
|---|---|---|---|
| `4925175a-8473-404b-99ea-fc19eb8ee1d7` | AtriaTC7_p3vchy | AlmaVia `9dc0f64e…` | Atria `a799b9b4-4a2d-49ce-a610-d6354d43016e` |
| `40732d50-2ccf-409e-8b3f-49cd0158e8cc` | AtriaTC8_ibzent | AlmaVia `9dc0f64e…` | Atria `a799b9b4-4a2d-49ce-a610-d6354d43016e` |
| `06817d10-7f07-4c63-9e09-4b4dd17e1631` | 96823AlmaViaSR_s08qht | Drake `b2b21e52…` | AlmaVia `9dc0f64e-80ab-4852-a019-592a50019bee` |
| `93298a6c-ddac-4b92-9957-8a07a8a7e1fa` | 96687DrakeT_kxiar0 | **fabricated** `d7b3baa2…` | Drake `b2b21e52-e2e8-43b2-b386-61a07ede5c05` |
| `71f00902-0ad3-4109-952a-ab10ba3baa87` | 96680DrakeT_pvspi0 | **fabricated** `d7b3baa2…` | Drake `b2b21e52-e2e8-43b2-b386-61a07ede5c05` |
| `f3157a01-71f2-485b-b31a-1d6645b54799` | 96684DrakeT_hwjhly | **fabricated** `d7b3baa2…` | Drake `b2b21e52-e2e8-43b2-b386-61a07ede5c05` |

Fabricated item: **`d7b3baa2-dab6-49df-8b5e-c3875dbeb464`** — "Drake T Community
Property", sort_order 3. Its one detail
(`561ca489-757e-40fb-81f6-331b320597b5`, `Community Fee = $15,000`) is a strict
duplicate: the genuine Drake item already carries
`Memory Care Community Fee = $15,000` (`923a5519-e337-4e62-a833-34bb01a2e1be`).
Its `item_links`, `item_contacts` and `packet_blocks` rows are all empty.

> **Destructive ordering hazard.** `item_photos.item_id` is `ON DELETE CASCADE`.
> The three genuine Drake photos currently live on the fabricated item, so
> deleting that item first **destroys them**. Any repair must re-point before
> deleting.

## Packet B — `b600dd0d-ca76-4e6d-99b6-eecf1cd43807`

**Published**, slug `94cr7dqiz4meuv5e9w1mxc`, published 2026-08-05,
`viewed = true`, `composition_mode = legacy`, 0 `packet_blocks`. Section
`c056be50-bab6-40c5-8e43-461aebcc5c57`. **16 photo rows — three fewer than the
source.** Run `45a13052-d7b6-4bee-9d3d-b2820096a5cd`, finalized.

**Damage:** the same three misattributions, plus three photos **silently lost**.
No fabricated item — this run's chunk 3 returned nothing usable instead.

| Photo row id | URL basename | Currently on | Belongs to |
|---|---|---|---|
| `6b841d7e-32d6-4a6e-9c58-79dbf7cb26ff` | AtriaTC7_p3vchy | AlmaVia `19f574b3…` | Atria `08c16ae7-bd87-455c-8b3e-1158e89acf4f` |
| `142b6a4b-549b-42ae-930b-e3aa782e8c52` | AtriaTC8_ibzent | AlmaVia `19f574b3…` | Atria `08c16ae7-bd87-455c-8b3e-1158e89acf4f` |
| `652c8391-0cea-4ecf-8a42-ec31e57bb25a` | 96823AlmaViaSR_s08qht | Drake `9c517a9b…` | AlmaVia `19f574b3-704c-4152-8228-90455afbaed1` |

Missing entirely from the packet, belonging to Drake
`9c517a9b-11ba-472c-bc0d-fa5fcaa8f232`:

- `…/v1782351998/96687DrakeT_kxiar0.jpg`
- `…/v1782351989/96680DrakeT_pvspi0.jpg`
- `…/v1782351994/96684DrakeT_hwjhly.jpg`

All three remain recoverable from `packets.raw_input`, which finalize retains.

## Constraints any future repair must respect

- **Re-point before deleting** (cascade hazard above).
- `update_item_content` refuses non-draft packets
  ([0011:279](../../supabase/migrations/0011_multiple_item_contacts.sql)), so
  Packet B cannot be corrected through the supported RPC while published.
  Unpublishing 404s the live link (`/p/[slug]` is `force-dynamic`) and
  republishing resets `published_at`.
- There is no transaction boundary across separate PostgREST calls. A partial
  application is visible to a recipient mid-flight, and `queries.ts` orders
  photos by `sort_order` with no tiebreaker, so a half-applied state renders
  nondeterministically.
- **`published-snapshot.mts` has a side effect:** it fetches every published
  packet through the real route, which calls `markPacketViewed`. Running it would
  flip `viewed = true` on packets no client has opened yet, destroying a signal
  that cannot be reconstructed. Prefer a targeted fetch of the single slug, and
  prove "nothing else changed" with a database-level diff instead.
