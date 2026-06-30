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
