# Library / reusable content — independent review

**Status: RECOMMENDATION, nothing built. 2026-08-18.**

Written before seeing the founder's proposed solution, deliberately.

---

## 1. The architecture already answers half the questions

Before designing anything, the existing principles constrain the answer more than
they might appear to. From [product-direction.md](../product-direction.md):

> **Inputs seed once; they do not stay connected. This is the load-bearing rule.**
> … We never create live synchronization back to an imported source, because that
> would reintroduce the exact bug the architecture exists to prevent: a second
> source of truth. **An import is a seed, not a live binding.**

**A Library is an input.** It is not a new category of thing — it is another
adapter that produces part of a first draft, sitting alongside AI generation,
manual creation and CSV import in the same diagram. The moment that is accepted,
several of the open questions stop being matters of taste:

| Question | Answer, from the existing rule |
|---|---|
| Relationship after insertion | A **disconnected copy**. Nothing else is permitted. |
| Do packet edits change Library content? | **No.** |
| Do Library edits change existing packets? | **No.** |
| Live sync, "update all packets using this"? | **Ruled out.** It is the second-source-of-truth bug wearing a feature's clothes. |

This is not a limitation to be worked around later. A packet is a **prepared
communication to one client** — a statement of what the professional said to that
person on that day. Retroactively mutating a delivered packet because a Library
record changed would falsify a record of a conversation. The copy semantics are
the product being correct, not the architecture being inflexible.

The one nuance: **ancestry may be recorded, as long as no behaviour depends on
it.** 0014 is the precedent — items carry `origin_run_id` and nothing about
rendering or editing consults it. Lineage as inert evidence is fine. Lineage as a
sync channel is not.

## 2. What the reusable unit should be — the Item

Look at what actually repeats across verticals:

| Domain | What recurs across clients |
|---|---|
| Senior placement | the same communities — Brookdale Chanate, with its address, photos, contact, amenities |
| Real estate | the same listings; the same neighbourhood write-ups |
| Training | the same exercises and modules |
| Restaurants | the same dishes, the same venues |
| Consulting | the same service descriptions and case studies |
| Travel | the same hotels and activities |

In every one it is **a named thing you tell clients about** — and that is exactly
what `items` already is: `title`, `address`, `description`, `notes`, plus
`item_details` (label/value), `item_links`, `item_photos`, `item_contacts`.

That is the profession-agnostic unit, and it is already self-contained and
portable. **The Library is a library of items.**

Explicitly *not* the unit in v1:

- **Sections** — a section is a per-client *arrangement*, not content. "Communities
  I recommend for your mother" is not reusable; the communities are.
- **Packets/templates** — reusable *structure*, a genuinely different feature.
  Bundling it with reusable *content* would conflate two things that should be
  evaluated separately.
- **Fragments below an item** (a lone photo set, a lone contact) — too granular to
  be worth finding. The item is the level at which a professional thinks.

## 3. What I would build for v1

### Entry: explicit save, plus bulk promotion after import

**Explicit "Save to Library" on an item.** Not automatic capture of everything.
A Library that fills itself becomes a junk drawer of client-specific one-offs —
"the apartment we ruled out", "Mom's current place" — and the professional's
judgement about what is reusable *is* the signal that makes it valuable. A
Library containing everything is a search problem, not an asset.

**And the accelerant that makes it useful on day one:** after an AI import
finalizes, offer *"Add these N to your Library"* with checkboxes. FlowGuide's
import already produces well-structured items with photos, addresses and
contacts. One import of twenty communities can populate the Library in a single
gesture. Without this, the Library is empty for months and the compounding
promise is theoretical; with it, the professional's *existing* work becomes the
seed capital.

This is the single feature that separates "a real Library" from "Saved Items".

### Reuse: insertion into the real editor

`Add item` gains a second path: **Add from Library** — a searchable list showing
title, the identifying line (address, where present), and a hero thumbnail.
Choose one or several, insert at a position, and they become **ordinary packet
items**, indistinguishable from manually created ones except for inert ancestry.

Search over title/address/description text. **No folders, no tags, no
collections in v1** — those are organisational scaffolding for a scale that does
not exist yet, and search over a few hundred items is genuinely enough.

### Maintenance: direct editing, because a Library that decays is worse than none

The Library must be editable **in place**, reusing the existing item editor. This
is not a nice-to-have: a phone number changes, and if the only way to fix it is
to edit a packet, every future insertion carries the stale number forward. The
compounding promise inverts — the Library compounds *errors*.

Direct editing covers this need entirely, which is why I would **not** build
"push my packet edits back to the Library" in v1. It is a convenience with
conflict semantics, and direct editing makes it unnecessary.

### Delete

Deleting a Library item **never touches any packet**, because packets hold
copies. That safety falls out of the copy model rather than needing enforcement.
Ancestry pointers become null (`on delete set null`); nothing dangles.

Hard delete is fine and honest. No archive, no trash — the packets already hold
everything that was ever delivered.

### Duplicates

On save, warn when an item with a very similar title (and address, where present)
already exists: *"You already have Brookdale Chanate. Update it instead?"* Warn,
offer, **never auto-merge and never block**. Two genuinely different things can
share a name, and silently merging a professional's content is unrecoverable.

## 4. Architectural shape

```
library_items          ← owner-scoped, mirrors the item payload
  id, user_id, title, address, description, notes,
  source_packet_item_id  (inert lineage: where it was saved FROM)
  created_at, updated_at

library_item_details / _links / _photos / _contacts
  ← same shape as the item_* child tables

items
  + library_item_id      (inert lineage: what it was inserted FROM,
                          on delete set null)
```

Four properties matter:

1. **The Library never renders to a recipient.** It is an authoring-side store.
   Packets remain the only thing a client ever sees, so "one canonical packet"
   is untouched — the Library sits *before* the packet, on the input side.
2. **Insertion is a deep copy.** Item plus all four child collections, new rows,
   new ids. After insertion the packet is self-contained.
3. **Both lineage columns are inert.** Nothing reads them to render or to edit.
   They exist so that future features are *possible*, not so that anything today
   behaves differently.
4. **It mirrors the item schema rather than sharing it.** Sharing one table
   between "content in a packet" and "content in a library" would mean every
   packet query grows a filter, and one missed filter leaks Library rows into a
   client's packet. Separate tables make that class of bug unrepresentable.

Security posture matches 0016: owner-scoped, RLS enabled, reached through the
server with the service role. The Library is professional-private.

## 5. Tradeoffs and risks

**Divergence is real and is the price of correctness.** Insert a community into
ten packets, then fix its phone number in the Library, and those ten packets keep
the old number. That is *correct* — they are records of what was sent — but it
will feel wrong the first time. The honest framing for the UI: the Library is
where you keep your best current version; a packet is what you said to a client.

**Junk drawer** — mitigated by explicit save, and by the bulk-promotion flow being
a deliberate, reviewable checklist rather than an automatic sweep.

**Duplicate proliferation** — the same community saved three times from three
packets. Mitigated by the duplicate warning; not eliminated.

**Scope gravity is the biggest risk.** A Library attracts folders, tags, sharing,
team libraries, templates, versioning and "update all packets". Each is
defensible alone; together they are a second product. v1 must ship without them
and be allowed to sit.

**The specific thing to refuse:** live sync. It will be asked for, it sounds
helpful, and it reintroduces the second source of truth the whole architecture
exists to prevent. It should be declined on principle rather than on effort.

## 6. The smallest version that is still substantial

Not "Saved Items" if and only if it does these five:

1. **Full payload** — photos, contacts, details, links travel with the item, so
   an insertion restores a complete, client-ready block rather than a title.
2. **Bulk promotion after import** — the Library is useful the day it ships,
   populated from work already done.
3. **Insertion into the real editor** at a chosen position, producing normal
   items.
4. **Direct editing**, so it is a maintained asset rather than an archive.
5. **Search that finds things** across a few hundred items.

Drop any one and it degrades to a bookmark list. Add anything else and v1 grows
a second feature.

## 7. Preserve now, build later

Cheap things that keep options open, none of which change v1 behaviour:

- **Both lineage columns** — they make "this community appears in 12 packets",
  "your Library copy is newer than this packet's", and usage analytics possible
  later, with no migration and no behaviour today.
- **`library_items.user_id` rather than an implicit owner** — a future team or
  agency library becomes a scope change, not a rewrite.
- **A separate child-table set mirroring `item_*`** — if the item model grows a
  field, the Library grows the same field; the shapes stay parallel by
  construction.
- **No `type`/`category` column.** Adding one invites vertical-specific
  taxonomies, which is exactly how a profession-agnostic model stops being one.
  Search over real text generalises; a taxonomy does not.

Deliberately *not* preserved, because preserving it would shape v1 badly:
versioning of Library items, and any join table implying many-to-many
"membership" of an item in packets. The copy model makes both meaningless, and
leaving hooks for them would invite exactly the live-sync mistake.

## 8. What I would explicitly not build in v1

| Not building | Why |
|---|---|
| Section / packet templates | Reusable *structure* is a different feature from reusable *content*. Evaluate on its own merits. |
| Folders, tags, collections | Organisational scaffolding for a scale that does not exist. Search suffices. |
| Push packet edits back to Library | Direct editing covers the need without conflict semantics. |
| Live sync / propagate updates | Violates the input rule; falsifies delivered packets. Refuse on principle. |
| Team / shared libraries | Ownership and permissions are a product decision, not a v1 detail. |
| Versioning, usage analytics | The lineage columns keep both possible; neither earns its place yet. |
| Auto-capture of every item | Turns the Library into a search problem instead of an asset. |
