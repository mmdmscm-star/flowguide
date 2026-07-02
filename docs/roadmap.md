# FlowGuide Roadmap

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

### Validation gate (do this before any code)

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
