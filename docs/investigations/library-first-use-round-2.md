# Library, second round of real use — findings and bounded plan

Six findings from production use on 2026-08-19. Finding 1 is fixed and deployed
(`1b81df8`); the rest are planned here and **not built**.

The loop these serve: **build Library → choose saved material → create FlowGuide
→ tailor → share.** Everything below is judged by whether it makes that loop
obvious. Nothing here is categories, groups, reordering, or a Trello-like
assembly workspace.

---

## 1. Library editing did not save — FIXED AND DEPLOYED

Reproduced in production first. Open an AI-imported entry, change anything, press
Save: **zero network requests, no error, the editor stays open.** The button was
not dead; the click handler was throwing.

```
rejection: TypeError: Cannot read properties of undefined (reading 'trim')
```

**Two contracts that never met.** The model's contract for an extracted item is
`photos: string[]` — `ingest-validate.ts` rejects anything else. The canonical
`ItemContentPayload` shape is `{url}[]`. Nothing converted between them, and
`library_save_proposal` copies the proposal payload verbatim, so every imported
entry with a photo was stored as bare strings. Reading it back gave
`[{url: undefined}]`.

Fixed at the boundary where untrusted content becomes a payload, so a save
rewrites the entry canonically; read paths tolerate both shapes so an entry that
has not been re-saved still opens (that is also why imported entries showed no
thumbnail). The save-back diff had the same latent fault — a string photo keyed
as `""` made every photo compare equal, hiding real removals from the safeguard.

**The class fix matters more than the shape:** a throw inside `handleSave` showed
nothing at all. It is now caught and surfaced, and every filter that reads a
stored shape is defensive. *"Save does nothing"* must not be a reachable state.

**Why no proof caught it:** the runtime proof's fixture produced no photo urls,
so the import it exercised never wrote the broken shape. A proof is only as good
as the awkwardness of its fixture.

### Still owed (not urgent, since the app now tolerates both)

New imports still *store* bare strings until `library_materialize_proposals`
normalises them. Proposed as **0023**, together with a one-time repair of existing
rows. Both need explicit approval; neither blocks anything, because every read
and write path now handles both shapes.

---

## 2. Create a FlowGuide from the Library — the core workflow gap

Having saved several communities, the natural next thought is *"now make a
FlowGuide from these"*, and there is no way to do it. `New Packet` offers only
**Paste & organize with AI** and **Start blank**.

### The model

**Create a FlowGuide**
- **Use my Library**
- **Paste & organize with AI**
- **Start blank**

Plus the same destination from inside the Library, where the material already is.

### Narrowest implementation — no new schema, no new RPC

Every piece exists:

| Need | Already have |
|---|---|
| pick saved entries | `LibraryList` `selectable` mode (built for the in-editor picker) |
| create a draft | `POST /api/packets` |
| insert copies | `POST /api/packets/:id/items/from-library` — `sectionId` is already optional |

So the work is composition and two entry points:

1. **`POST /api/packets/from-library`** — create a draft, insert the chosen
   entries as copies, return the packet id. One route so a failure cannot leave
   an empty orphan draft, matching how the Library's other multi-step writes are
   handled.
2. **Dashboard** — `New Packet` gains **Use my Library**, opening the picker.
   Disabled with a quiet reason when the Library is empty.
3. **Library** — a selection mode: choose entries, then
   **Create a FlowGuide with these**. Reuses the same picker component in a
   different default state rather than a second list.
4. Land in `/edit/:id` with the items already there, tailored normally from there.

**Explicitly not now:** ordering within the selection, sections chosen at pick
time, a side-by-side assembly canvas. Everything arrives in one section and is
rearranged with the editor's existing controls.

---

## 3. Viewing versus editing

Clicking a saved entry should let you *look* at it. `Edit` is currently the only
way to see the full content.

**Recommendation — the simplest thing that works:** the row expands in place to a
read-only detail (address, description, details, links, photos, contacts), with
**Edit** as an explicit action inside it. No new page, no modal, no route.
Expansion is local state; the list already holds the full payload, so this costs
no request.

---

## 4. Language

`Create an item` made you stop and ask what "item" means. Nothing in the product
requires a customer-facing noun for a community, an exercise, a property.

| Now | Becomes |
|---|---|
| `+ Create an item` | **Add manually** |
| `Import with AI` | unchanged |
| `Add from Library` | **Choose from Library** |
| `Save items` | **Save to Library** |
| `Save to Library` (per item) | unchanged |
| `New Library item` (heading) | **Add to Library** |
| "Save items to your Library" (modal) | **Save to Library** |

`item` stays in code, routes and the database, where it is precise and internal.

---

## 5. Creator-side typography — bounded audit

Measured, not guessed:

| Surface | `text-[11px]` | `text-xs` (12px) | `text-sm` (14px) | `text-base` (16px) |
|---|---|---|---|---|
| editor | 7 | 67 | 69 | 2 |
| library | 0 | 61 | 24 | 0 |
| dashboard | 0 | 8 | 9 | 0 |
| nav | 0 | 2 | 1 | 0 |
| **recipient pages** | 0 | ~1 | ~1 | **dominant** |

The recipient experience is 16px-led; the creator experience is **12px-led**.
That is the whole finding, and the Library is the worst of it — 61 `text-xs`
against zero `text-base`.

**Recommended baseline — a size policy, not a redesign:**

- **Anything read to make a decision is `text-sm` (14px) minimum** — entry
  titles, list rows, descriptions, field labels carrying content.
- **`text-xs` is reserved for true metadata** — timestamps, counts, one-line
  helper captions under a control.
- **`text-[11px]` is retired** (7 uses).
- **Controls a professional clicks repeatedly are `text-sm`.**
- Inputs are already `text-sm`; unchanged.

Order: Library, then editor, then dashboard. Mechanical, reviewed surface by
surface, no layout changes.

---

## 6. Empty Library — say it once

The current empty state explains the same idea three times: the page description,
the "what your Library holds" paragraph, and the two/three ways to fill it.

**Direction, close to your wording:**

> **Save things you use often and add them to any FlowGuide.**
> [ Import with AI ] [ Add manually ]
> You can also save anything straight from a FlowGuide you are building.

One sentence, two actions, one line of follow-up. The page-level description
above the list is removed rather than restated — it is the same sentence.

---

## Sequencing

1. ~~Library save~~ — done, deployed, verified in production.
2. **Create from Library** (2) — the workflow gap; everything else is polish.
3. **Language** (4) and **empty state** (6) — small, and they touch the same
   screens as 2, so doing them together avoids editing the same copy twice.
4. **View versus edit** (3).
5. **Typography** (5) — mechanical, best done last so it is applied once to
   final copy.
