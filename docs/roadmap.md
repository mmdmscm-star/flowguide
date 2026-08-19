# FlowGuide Roadmap


> **PRIORITISATION POSTURE — corrected 2026-08-18.**
>
> Several entries below were written under a retired rule: that a feature had to
> wait for real observed friction, with a "validation gate" before any code. That
> rule is **no longer how work here is prioritised**, per `AGENTS.md`.
>
> Items are prioritised against **the FlowGuide product we intend to sell,
> architectural coherence, and business value**. A prior complaint is not a
> precondition — friction is *evidence, not permission*.
>
> The gates below are preserved as the historical record of how each item was
> originally deferred, and because several describe genuinely useful **validation
> work** (e.g. checking Street View coverage against real addresses) that is worth
> doing before building. Read them as "what to find out first", never as
> "wait until a client complains".

Ideas that have been **thought through and documented**, but are **intentionally
waiting for additional evidence from real-world use** before becoming active
development. Presence on this roadmap is not a commitment to build — it means the
idea has been preserved with enough context to make a go/no-go decision later
without re-deriving the analysis. Each item carries a **validation gate**: the
specific real-world evidence that must arrive before implementation is earned.
Nothing here is built until its gate passes. See
**[product-direction.md](product-direction.md)** for the architecture all items
must obey.

---

## Street View Fallback Investigation

**Status:** Validated concept, pending real-world validation.

### The idea

For items that have an `address` but **no curated photos**, show a Google Street
View image as a **fallback** visual so the packet isn't blank. Most relevant to
small board-and-care homes, where we rarely have photos (large senior communities
usually do). Generalizes to other location-based verticals: real estate, travel,
schools, clinics.

### What to find out first (validation, not a gate on permission)

Matthew and Ramona will manually review **~20 real board-and-care addresses** in
Google Street View and answer one question:

> **"If this were the only visual on the packet, would it make the packet
> meaningfully better?"**

- **If generally yes** → this becomes a **high-priority platform feature**. It
  benefits multiple verticals while preserving "one packet, multiple renderers,"
  so the investment pays off broadly.
- **If generally no** (poor coverage, wrong framing, bleak/misleading imagery for
  these small residential addresses) → **do not build.** The floor alternative is
  a zero-cost generated placeholder (building icon / address card) — no API, no
  key, no licensing.

This check costs an afternoon, needs no API key or billing (use maps.google.com or
the free Street View metadata endpoint), and directly tests the one assumption the
whole feature rests on: that Street View actually covers small care-home addresses
well.

### Why it fits the architecture

A **renderer-time fallback**, not a new media system. The address stays canonical
in the packet; renderers *decide to show* a Street View visual only when no curated
photo exists. Preserves: curated photos primary, fallback-only, one packet /
multiple renderers.

### Constraints already established (don't re-derive)

- **First paid Google API.** Today Maps is deep-link only — no API key, no billing,
  no Maps Platform project. This feature means standing up billing, a server-side
  key, key restrictions, and likely URL signing from scratch.
- **Likely cannot store the images.** Maps Platform Terms generally prohibit
  long-term storing/caching of Street View image bytes. Store only references
  (pano id / lat-lng / address), render dynamically through a **server proxy**
  (the key cannot appear in a public URL). Confirm current terms before relying.
- **Google attribution is baked into the image** and must not be cropped/obscured.
- **Quota risk is fetch-per-view.** Gate every render with the free metadata call;
  cache hard; fetch-once over per-view.
- **Wrong-house / sensitive-domain risk.** Free-text addresses geocode imperfectly,
  and a bleak or wrong Street View reaches emotionally invested families. Favor
  **automatic detection + owner confirmation in the editor**, not automatic
  display to recipients. Label clearly as "Street View / approximate exterior."

### Smallest version if the gate passes

Renderer-level fallback, behind a feature flag, surfaced in the editor first:
no curated photos + address + metadata says a pano exists → show one labeled,
proxied, non-stored Street View image with attribution intact. No editor media
UI, no stored image bytes, no per-channel duplication.

### Reference

Full analysis is in the conversation that produced this item (2026-06-30):
the 10-question evaluation of the Street View Static API.

---

## Details Model — Vertical-Fit Watch

**Status:** Keep as-is. Watching for real-world friction across verticals.

### The observation

Item **Details** are stored and edited as a simple **label / value** pair
(`item_details(label, value, sort_order)`), rendered as a two-column list. It
works extremely well for senior living (pricing, care levels, room types). The
open question is whether that label/value editing model stays natural as real
packets get built in other verticals (farmers markets, travel, real estate,
financial planning, etc.).

### Decision (2026-07-02): leave it alone

No change to the **data model, editor, or renderer**. Checked all three: there is
**no senior-specific coupling** anywhere — the model is a generic key/value pair,
the renderer is a plain two-column list, and the editor copy is neutral ("Details"
/ "Label" / "Value"). The senior-living flavor lives in the *example data entered*,
not in the architecture.

This is the inverse of a build-gate: the default is **do nothing**. label/value is
about the most vertical-agnostic structure possible, the schema is additively
extensible (richer details can be added later with no migration today), and
pre-building flexibility with no observed friction would violate our
evidence-first principle. label/value "working extremely well" is the strongest
reason to leave it untouched.

### Revisit trigger (what friction actually looks like)

Revisit **only** on **repeated friction across multiple real packet types, in ≥2
verticals** — a pattern, not one awkward packet. Specific signals to watch for
while building real packets:

- **Retyping the same labels on every item** in a vertical (e.g. every real-estate
  item = Beds / Baths / Sqft / Price). Most likely signal — points to wanting
  per-vertical *label templates/presets*, which would be an **additive layer on
  top of** the current model, not a redesign of it.
- **Cramming a non-scalar into `value`** — a date range, a list, a link, a
  paragraph. If professionals fight the single-line value field, the model is
  straining.
- **Leaving Details empty and putting that info in Description instead**,
  repeatedly, in a given vertical — a sign key/value doesn't match that vertical's
  mental model.

### If the trigger fires

Prefer the **smallest additive** response, in keeping with the architecture:
per-vertical label templates/presets layered over the existing `item_details`
table — not multiple editors, not a per-vertical schema, not a redesign of the
label/value model. Re-evaluate only with the accumulated evidence in hand.

### Reference

Working principle adopted 2026-07-02 after reviewing the Details data model,
renderer ([item-card.tsx](../src/components/item-card.tsx)), and editor. Relates to
the "real-world use is the primary driver" section of
[product-direction.md](product-direction.md).

---

## Reliability & ownership stack — SHIPPED AND CLOSED

**Closed 2026-08-18.** Deployed as commit `3bc03e8`; see
[2026-08-18-production-deploy.md](migrations/2026-08-18-production-deploy.md).

seg-v4 record-atomic segmentation, media accounting, item provenance (0014),
ownership recomputation, and the publish-time ownership gate with Move/Keep
resolution (0016). Proven end to end against the live model and database before
and after deploy: 0016 at 25/25, seg-v4 at 21/21 locally and 21/21 in
production, plus a 10/10 post-deploy smoke on disposable data.

**This line of work is finished.** It is not a standing programme, and further
reliability work needs its own justification rather than inheriting this one's.

### Available, not scheduled — historical ownership recovery where provable

The gate binds to `SEGMENTER_VERSION`, so every packet imported before
2026-08-18 declines on a version mismatch. Nonblocking by design and verified in
production: those packets publish exactly as before. The consequence is that the
gate protects **future imports, not the existing library**.

Recovering ownership for historical packets is therefore an **available
capability, deliberately unscheduled**. If it is ever taken up, the framing is
**recovery where provable** — establish ownership only where the surviving
source and provenance prove it (`source_hash` still matching `raw_input` at the
recorded `source_offset_base`, chunk and emit indices present), and leave it
unknown everywhere else. A guessed provenance is worse than an absent one:
`recomputeOwnership` refusing to answer is exactly what makes a finding
trustworthy.

**Not a backfill. Never a backfill.**

---

## Library v1 — SHIPPED AND CLOSED

**Closed 2026-08-19. Commit `e8abbad`.** Production smoke 20/20, cleanup clean.
Record: [2026-08-19-library-v1-deploy.md](migrations/2026-08-19-library-v1-deploy.md).

Reusable items in the working editor. The loop is **Save → Find → Insert → Edit
freely → explicitly update the saved version**, with no synchronization anywhere:
insertion is a disconnected snapshot, because a FlowGuide is a record of what was
said to one audience and must not change because a saved item later did.

Shipped: `/library` with full-text search over titles, addresses, descriptions
and detail labels · Save to Library with a duplicate warning that never merges ·
user-initiated bulk promotion, nothing preselected · Add from Library, appearing
immediately · direct editing reusing the existing item editor · Update saved
version with the tailored-descendant safeguard · optimistic concurrency on both
write paths.

**This workstream is closed.** The next Library iteration should be decided from
using the live feature, not from the backlog this release generated. Ideas that
came up during the build — groups/categories, reordering, undo and version
history, AI import straight into the Library, a side-by-side assembly workspace —
are informed directions, deliberately unscheduled, and none is a commitment.

### Still open, no current priority

- **Block-mode Library insertion** — see its own entry. A composition project.
- **`/p/[slug]` rate limit** — the WAF rule stays in **Log**, collecting
  observation data. The decision point is whether any legitimate source
  approaches 60 requests per 60s; if not, switch the action to Deny and re-run
  `scripts/security/verify-recipient-throttle.mts`.

---

## Block-mode Library insertion — NEXT LIBRARY FOLLOW-UP

**A composition project, not a Library patch. Not solved in this release.**

Library v1 ships legacy-only. Inserting a saved item into a block-mode FlowGuide
is refused by the application, before any write, and no Library affordance is
offered in the block editor.

### Why it is refused

Not an unimplemented feature — a deliberate structural invariant:

- `trg_freeze_items` (0007) rejects **INSERT**, **DELETE**, `section_id` and
  `sort_order` changes for any item whose packet is in block mode.
- `trg_freeze_sections` (0007) does the same for sections.
- Only *content* edits (title, address, description, notes) are permitted.

In block mode, composition is owned by `packet_blocks`, and the
`items`/`sections` substrate is frozen as a base. So the question is not "how do
we create the block?" — it is "may we create the item?", and the schema's answer
is a considered no.

### How this was established

0018 added `library_insert_item_block`, creating item and block atomically. It
was applied 2026-08-18, then its runtime proof showed the first statement raising
`items are frozen: cannot INSERT an item into a block-mode packet`. The function
was correct in every respect except that it could never succeed, and was dropped
in 0019. Both migration files remain; neither history was rewritten.

Worth keeping: even failing, the packet was left completely untouched — no orphan
item, no orphan block, `assert_packet_block_consistency` still passing.

### What taking this on actually means

**Revisit the block-mode item/section freeze and the composition ownership
model.** Specifically: whether block mode should permit item creation at all,
and if so, who owns membership — an authorized-exception path like the
`app.block_transition_authorized_packet` mechanism conversion already uses, or a
different arrangement entirely.

That is a decision about how composition works, and it should be scoped and
argued on its own, not as an extension of the Library.


---

## Recipient Text-Size Control (A / A+ / A++)

**Status:** Deferred. Watching whether the larger default is enough.

### The idea

Let a **recipient** adjust the packet's text size (e.g. A / A+ / A++) for their
own reading comfort — most relevant to older clients. This is distinct from the
default type scale, which we already raised for everyone. It's about giving the
*reader* control, not changing the baseline again.

### Why it's deferred

We just lifted the default recipient reading tier (16px body, 18px item titles,
20px section titles, higher-contrast labels). That may be enough on its own.
It was deferred on that basis. Under the current posture it is prioritised on
product value like anything else; the open question is whether it earns its place
in the recipient UI, not whether someone has complained.

### What to find out first (validation, not a gate on permission)

Worth confirming, at the new larger default, whether readers still struggle with
size — useful evidence for sizing the work, NOT a precondition for doing it:

- a client says the text is hard to read, or
- you watch someone pinch-zoom, hold the phone close, or ask you to make it
  bigger while reading a real packet.

Such an observation would be strong evidence. Its absence is not a veto.

### Shape if the gate passes

A **render-only** control: a small A / A+ / A++ toggle that scales the packet's
**root font-size**, so every element scales proportionally off the existing
`rem`-based sizes. Persist the choice in the browser (`localStorage`) so it sticks
across visits.

- **Presentation only** — it never touches the canonical packet; it's a preference
  on the *renderer*, exactly as "one packet, multiple renderers" intends.
- No packet data, no server state, no per-recipient records.
- Placed unobtrusively (e.g. a corner of the packet) so it aids reading without
  cluttering it.

### Reference

Grew out of a real send to an elderly client (2026-07-09): the packet was hard to
read even with reading glasses, and the recipient had no way to enlarge it. The
first response was to fix the default scale (shipped); this control is the
deferred follow-on. Relates to the recipient typography lift and the
"one packet, multiple renderers" principle in
[product-direction.md](product-direction.md).
