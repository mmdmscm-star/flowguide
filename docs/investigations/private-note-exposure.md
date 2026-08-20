# Private-note exposure — confirmed, and the bounded hotfix

*2026-08-20. Confirmed in production through the live product path. Nothing has
been changed. The semantic-ingestion investigation is paused until this closes.*

## What is wrong

`items.notes` / `library_items.notes` is presented to the professional as
private — Library detail labels it **"Private note"** and states **"Only you see
this."**, the packet editor labels it **"Private notes"** — and is rendered to
the recipient on `/p/[slug]` in an amber highlight box.

Verbatim, from a signed-out fetch of a published FlowGuide:

```html
<div class="mb-4 bg-amber-50 border border-amber-200 …"><p class="… text-amber-900 …">
PRIVATENOTE88237: the family cannot afford this community and the director knows it</p></div>
```

Reach in real data (read-only, no note content read): **64 items carrying a note
sit in 15 published FlowGuides, and a recipient has opened all 15.**

## The full surface sweep

Every path by which `notes` can reach a recipient:

| surface | reaches a recipient? | carries notes today |
|---|---|---|
| `/p/[slug]` sections → `SectionGroup` → `ItemCard` | **yes** | `getPublishedPacket` (queries.ts:174) |
| `/p/[slug]` blocks → `PacketBlockBody` → `ItemCard` | **yes** | `assembleItemsByIds` (queries.ts:330) |
| `/preview/[id]` | no — session required, owner-scoped | same assembler |
| `/prototype/persisted-blocks/[id]` | no — session required | same assembler |
| `block-packet-editor` → `ItemCard` | no — editor | `getPacketForEditor` (queries.ts:421) |
| `/p/[slug]` OG metadata | n/a | static string, no item data |
| unauthenticated API routes | n/a | only `/api/auth/*`; no item data |
| PDF / print / email / share renderers | — | **none exist yet** |

`/p/[slug]` is the only recipient surface FlowGuide has today. That is what makes
this fixable in one bounded change — and it is also the reason to fix it at the
data layer, before more renderers exist.

## Why removing the render is NOT enough

`ItemCard` is a `"use client"` component and receives the whole `item` object as
a prop from a server component. **Next.js serializes client-component props into
the RSC flight payload embedded in the HTML.** Deleting the notes JSX would hide
the note visually while leaving it verbatim in view-source.

So the note must not reach the recipient's data at all. Stripping happens in
`queries.ts`, and the component change is defence in depth rather than the fix.

## The hotfix

**No database migration.** Nothing about storage changes. No note content is
deleted, rewritten or migrated. The 65 existing Library entries are neither read
nor written.

1. **`getPublishedPacket`** — stop selecting/returning `notes` for the recipient
   item shape.
2. **`assembleItemsByIds`** — take an `audience` parameter that **defaults to
   `"recipient"`** and omits notes. The two professional callers
   (`block-editor.ts`, `block-preview.ts`) opt in explicitly.
3. **`ItemCard`** — take `audience` defaulting to `"recipient"`; render the note
   only for `"professional"`, and label it *"Private note — only you see this"*
   so the promise is restated where it is true.
4. **`block-packet-editor`** — pass `audience="professional"`, so the
   professional keeps seeing and editing their note.

**Fail-safe defaults are the point.** Both the query parameter and the component
prop default to private. A recipient surface added later is private by omission.
Getting an opt-in wrong fails toward "the professional cannot see their own note
in one view" — visible and recoverable. The opposite default fails silently
toward exposure, which is how this happened.

`/preview/[id]` deliberately stays on the recipient default: it exists to show
the professional what the client will see, so it should not show what the client
will not.

## Proof plan

1. **Source invariant test** — the only `ItemCard` call sites passing
   `audience="professional"` are the known editor ones, so a new leak fails the
   suite rather than production.
2. **Shape test** — `getPublishedPacket`'s item shape has no `notes` key at all,
   asserted on the returned object rather than by reading the query.
3. **Runtime proof** — the existing `proof-private-note.mts`, extended: the
   sentinel must be absent from the **entire signed-out HTML** (which covers the
   RSC payload, not just rendered markup), while the item's title, address and
   details still render — a precondition already guards against passing because
   the page rendered nothing.
4. **Professional path** — the same sentinel is still visible to the owner in the
   editor, and still editable.
5. Existing production smokes re-run.

## Deliberately NOT in this fix

**A recipient-facing callout field.** The amber box is a real use case — a
professional wanting to highlight something *for* the client. That needs its own
column and its own semantics, and it needs a migration. Private notes and
recipient callouts must never share storage again, so it ships separately, after
this.

**`ambiguous -> notes` in the prompts.** Once notes is genuinely private, that
instruction routes facts the model is unsure about into a field the client never
sees — converting a placement error into silent loss from the recipient's point
of view. It belongs to the semantic-reliability investigation, not to an
emergency privacy fix. Recorded there.
