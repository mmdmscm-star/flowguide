# Library v1 — product + technical specification

**Status: SPEC, not implemented. 2026-08-18.**

Merged from the founder's direction and the
[independent review](library-v1-independent-review.md). Where the two differed,
the founder's position is adopted and marked.

---

## 1. What Library v1 is

A professional-private store of **reusable items** — the named things a
professional tells clients about. Saving one captures its full content; inserting
one drops a complete, client-ready item into a packet.

The loop it exists to close:

> **save → reuse → improve during real client work → deliberately save the better version**

That loop is the product claim. Without the last step the Library is an archive;
with it, a professional's knowledge compounds.

### The governing rule, inherited not invented

From [product-direction.md](../product-direction.md): *"Inputs seed once; they do
not stay connected… An import is a seed, not a live binding."*

**The Library is an input.** Insertion is a **disconnected snapshot**. Nothing
propagates in either direction on its own, ever. A packet is a record of what a
professional said to one client on one day; retroactively mutating it because a
Library record changed would falsify a conversation.

**"Update Library version" does not violate this** — and this was the founder's
correction to the independent review, correctly. It writes *from* a packet item
*to* the Library snapshot, explicitly, on confirmation. No packet is read from or
written to by any other packet. It is a save, not a sync.

---

## 2. Scope

**In v1:** Item as the reusable unit · save to Library · bulk promotion after
import · search workspace · insert into a packet (both editors) · direct Library
editing · **Update Library version** · duplicate warning · delete.

**Not in v1:** templates/sections, folders/tags, teams/sharing, versioning UI,
live sync or propagation, auto-capture, usage analytics.

> **Sections are excluded as a scoping decision, not an architectural law.**
> Reusable sections remain a legitimate future branch, and nothing in this spec
> forecloses them.

---

## 3. Data model

### The key discovery

`update_item_content` (0011) is *the* canonical atomic item-content writer, used
by **both** editors:

```sql
update_item_content(p_item_id, p_owner_id, p_packet_id, p_require_mode,
                    p_title, p_description, p_notes, p_address,
                    p_details jsonb, p_links jsonb, p_photos jsonb, p_contacts jsonb)
```

Its parameter shape **is** the reusable payload. So the Library stores exactly
what that writer consumes, and insertion becomes: create an item, then call the
existing canonical writer with the stored payload.

**This revises the independent review**, which proposed five mirror tables
(`library_item_details/_links/_photos/_contacts`). Storing the payload as jsonb
in the shape the canonical writer already accepts is *more* faithful, not less:
there is no transform between Library and packet, so the two cannot drift. Five
mirror tables would add a second shape that must be kept in step by hand.

### Schema — migration 0017, additive only

```sql
create table public.library_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,

  -- Real columns: what search runs against and what the list renders.
  title       text not null default '',
  address     text not null default '',
  description text not null default '',
  notes       text not null default '',

  -- The payload, in exactly the shape update_item_content consumes.
  details     jsonb not null default '[]'::jsonb,
  links       jsonb not null default '[]'::jsonb,
  photos      jsonb not null default '[]'::jsonb,
  contacts    jsonb not null default '[]'::jsonb,

  -- INERT lineage: where this was first saved from. Nothing reads it to render
  -- or edit; it exists so future features are possible.
  source_packet_item_id uuid references public.items(id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- INERT lineage on the packet side: what this item was inserted FROM.
-- This is also what makes "Update Library version" offerable.
alter table public.items
  add column if not exists library_item_id uuid
    references public.library_items(id) on delete set null;
```

Search index:

```sql
create index library_items_search_idx on public.library_items
  using gin (to_tsvector('english', title || ' ' || address || ' ' || description));
create index library_items_user_idx on public.library_items(user_id, updated_at desc);
```

**Ownership and security**, matching 0016's proven posture:

- `user_id` explicit, never implicit — a future team library is a scope change,
  not a rewrite.
- RLS **enabled with no policy**; all privileges revoked from `public`, `anon`,
  `authenticated`; explicit grant to `service_role` only.
- Every RPC `SECURITY DEFINER` with `set search_path = ''`, owner-checked.
- The migration self-verifies its own privilege boundary in a `do $verify$`
  block, and the post-apply check tests **by effect** (`has_table_privilege`),
  not by grant rows — the exact miss 0016 corrected.

**The Library never renders to a recipient.** It is authoring-side only. One
canonical packet is untouched: the Library sits *before* the packet.

---

## 4. Flows

### 4.1 Save to Library (single item)

**Entry:** an item's overflow menu in either editor → *"Save to Library"*.

1. Client posts `{ packetId, itemId }` to `POST /api/library`.
2. Server reads the item + its four child collections, owner-checked.
3. **Duplicate check** — normalized `title` (+ `address` when both non-empty)
   against the caller's existing Library items.
   - Match → **409 `duplicate_candidate`** with the existing item's id, title and
     updated date. The client offers: *"You already have **Brookdale Chanate**.
     Update it instead?"* → **Update** (§4.5) · **Save as new** · **Cancel**.
   - Never auto-merges, never blocks. Two real things can share a name, and
     silently merging a professional's content is unrecoverable.
4. Insert `library_items` with `source_packet_item_id = itemId`.
5. Set `items.library_item_id` on the source item, so the item the professional
   just saved is immediately eligible for *Update Library version*.
6. Toast: *"Saved to Library"* with an **Undo** for the session.

### 4.2 Bulk promotion after import

**The feature that makes the Library useful on day one.** FlowGuide's import
already produces well-structured items with photos, addresses and contacts; one
import of twenty communities can seed the Library in a single gesture. Without
this the Library is empty for months and compounding is theoretical.

**Entry:** after a run finalizes cleanly, a panel in the editor:

> **Add these to your Library?**
> These 4 items came from your import. Saving them means you can reuse them in
> future packets without pasting anything again.
> ☑ Brookdale Chanate ☑ Paulin Creek ☑ Primrose ☑ The Reserve
> [ Add 4 to Library ] [ Not now ]

- **All checked by default.** An import of communities is reusable content
  almost by definition; the professional unchecks what is client-specific.
- Shown **once per run**, dismissible, never nagging. Dismissal is remembered
  per run.
- Not shown when the run needs review — a run parked for accounting reasons
  should be resolved before its output is promoted.
- Runs the same duplicate check per item, reporting *"3 added, 1 already in your
  Library"* rather than failing the batch.

### 4.3 Search and workspace

**A dedicated page at `/library`:**

- Search box over `title`, `address`, `description` (Postgres full-text).
- Result rows: hero photo thumbnail · title · address · "used in N packets"
  *(derived by counting `items.library_item_id`, read-only)*.
- Default sort: recently updated. No folders, no tags — search over a few
  hundred items is genuinely enough, and organisational scaffolding for a scale
  that does not exist is how v1 becomes v3.
- Row actions: **Edit**, **Delete**.

**An in-editor picker** (the same search, as a modal) reached from *Add item →
From Library*.

### 4.4 Insert into a packet

1. Professional picks one or more items and a position.
2. `POST /api/packets/:id/items/from-library` with `{ libraryItemIds, position }`.
3. Per item, in one transaction:
   - create an `items` row in the target section (legacy) or as an item block
     (blocks mode) — **both editors are supported in v1**;
   - apply the stored payload through **`update_item_content`**, the existing
     canonical writer — no second content-write path is introduced;
   - set `items.library_item_id` (inert lineage);
   - **do not** set 0014's `origin_run_id` / `origin_chunk_ordinal` /
     `origin_emit_index`. A Library insertion has no ingestion provenance, and
     ownership recomputation must continue to decline rather than guess. This
     keeps the 0016 gate honest.
4. The result is an **ordinary packet item**, indistinguishable from a manually
   created one except for the inert lineage column.

### 4.5 Update Library version — the compounding step

**Founder's direction, adopted.** Direct editing does not replace it: the
improvement happens *during client work*, and requiring the professional to redo
it in the Library is exactly the friction that breaks the loop.

**Entry:** on any packet item where `library_item_id is not null`, an action
*"Update Library version"*.

Confirmation is explicit and states the consequence precisely:

> **Update your Library copy of "Brookdale Chanate"?**
> Your Library version will be replaced with this item's current content.
> **Other packets that already use it will not change.**
> [ Update Library version ] [ Cancel ]

- **Replace, not merge.** No conflict semantics, no field-level diffing.
- Writes only `library_items`. Touches **no** packet, including this one.
- Bumps `library_items.updated_at`.
- Leaves `items.library_item_id` unchanged.
- Not offered when the Library item has been deleted (`library_item_id` is null
  after `on delete set null`) — the action simply does not appear.

**Known limitation, accepted for v1:** two packets descending from the same
Library item, both improved, both pushed — last write wins. It is an explicit,
confirmed action showing what will change, and versioning is out of scope.

### 4.6 Direct editing

`/library` → **Edit** opens the **same item editor component** the packet editor
uses, writing to `library_items` instead of `items`. Reusing the component is
what keeps a Library item and a packet item the same kind of thing.

Essential, not cosmetic: without it a stale phone number propagates into every
future insertion and the Library compounds *errors*.

### 4.7 Delete

- Deleting a Library item **never touches any packet.** That safety falls out of
  the snapshot model rather than needing enforcement.
- `items.library_item_id` becomes null via `on delete set null`; nothing dangles,
  and *Update Library version* stops being offered for those items.
- Hard delete, with a confirmation naming how many packets used it. No archive,
  no trash — the packets already hold everything ever delivered.

---

## 5. API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/library?q=` | search / list |
| `POST` | `/api/library` | save from a packet item (409 on duplicate candidate) |
| `POST` | `/api/library/bulk` | bulk promotion after import |
| `PATCH` | `/api/library/:id` | direct edit |
| `DELETE` | `/api/library/:id` | delete |
| `POST` | `/api/library/:id/update-from-item` | **Update Library version** |
| `POST` | `/api/packets/:id/items/from-library` | insert into a packet |

All server-side, session-authenticated, service-role Supabase client. No client
component touches Supabase directly — the posture verified during 0016.

---

## 6. Migration strategy

**0017, additive and reversible.**

- One new table, one new nullable column on `items`, two indexes.
- **No backfill.** Existing items get `library_item_id = null`; the Library
  starts empty and fills through explicit saves and bulk promotion.
- No existing table, column, function or behaviour changes. Every current query
  is unaffected — a nullable column nothing reads cannot alter results.
- Deploy order does not matter: the column is inert without the code, and the
  code offers nothing without the table. (Unlike 0016, no gate depends on it.)
- **Rollback:** `drop column items.library_item_id; drop table library_items;`
  Lossless for packets, which never depended on either. Library content itself is
  lost, so capture it first if any exists.

---

## 7. Acceptance criteria

**Snapshot independence** *(the architectural claim)*

1. Insert from Library → edit the packet item → the Library item is byte-identical.
2. Edit a Library item → every packet previously inserted from it is unchanged.
3. Delete a Library item → all packets that used it are unchanged and still publish.
4. No code path writes from `library_items` to `items` except an explicit
   insertion; asserted against source, in the style of `ownership-route.test.mts`.

**Update Library version**

5. Offered only when `library_item_id is not null`.
6. After confirming: the Library item matches the packet item's current content.
7. After confirming: a *different* packet descended from the same Library item is
   unchanged.
8. Cancelling writes nothing.

**Fidelity**

9. Save → insert round-trip preserves title, address, description, notes, and all
   details, links, photos and contacts in order.
10. An inserted item carries no `origin_run_id`; ownership recompute **declines**
    for it rather than reporting a finding.
11. A packet containing Library-inserted items publishes normally.

**Security** *(mirroring 0016's post-apply checks)*

12. `anon` and `authenticated` can neither read nor write `library_items`, tested
    by effect across every privilege type.
13. `PUBLIC` holds nothing on the table or the RPCs; RLS on, no policies.
14. `service_role` **can** read and write — a lockdown that locks out the only
    caller is a 503 discovered in production.
15. User A cannot read, insert from, update or delete User B's Library items —
    tested per route, not assumed from `user_id` being present.

**Experience**

16. Bulk promotion offers exactly the items the run created, all checked, once.
17. Duplicate save surfaces the existing item and offers Update / Save as new /
    Cancel — and never auto-merges.
18. Search finds an item by title, by address, and by a word in its description.
19. Every async action shows loading, disabled and error states.

**Runtime proof**, disposable, in the `scripts/ingestion-runtime/` style:
import → bulk-promote → insert into a fresh packet → improve → Update Library
version → confirm the first packet is untouched → publish → cleanup verified
clean.

---

## 8. What is deliberately preserved, and what is not

**Preserved** (free, no behaviour today): both lineage columns; explicit
`user_id`; the payload stored in the canonical writer's own shape.

**Not preserved, deliberately:** no `type`/`category` column — it invites
vertical-specific taxonomies, which is exactly how a profession-agnostic model
stops being one. No version table, and no many-to-many packet-membership table:
the snapshot model makes both meaningless, and leaving hooks for them would
invite the live-sync mistake this architecture exists to prevent.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Snapshot divergence feels wrong the first time | UI language: the Library is your best current version; a packet is what you said to a client |
| Junk drawer | explicit save; bulk promotion is a reviewable checklist, not an automatic sweep |
| Duplicate proliferation | duplicate warning offering Update; not eliminated |
| Last-write-wins on Update | explicit confirmation showing the consequence; versioning out of scope |
| **Scope gravity** | folders, tags, sharing, templates, versioning will all be asked for. v1 ships without them and is allowed to sit. |
| **Live sync requests** | decline on principle, not on effort — it reintroduces the second source of truth |
