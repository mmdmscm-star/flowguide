# FLOWGUIDE_DECISIONS.md

> This document records **decisions that are considered settled**. It is
> not a roadmap or a brainstorming document. If a future idea conflicts
> with one of these decisions, the burden of proof is on changing the
> decision---not on ignoring it.

------------------------------------------------------------------------

## Canonical Product Decisions

### 1. The packet is the product.

Everything else exists to help create it, improve it, or deliver it.

------------------------------------------------------------------------

### 2. One packet. One source of truth.

There are not separate AI packets, manual packets, CSV packets, or
vertical-specific packets.

There are only FlowGuide packets.

------------------------------------------------------------------------

### 3. One editor.

Every packet is ultimately refined in the same editor.

Different creation methods may exist, but they always converge into one
editing experience.

------------------------------------------------------------------------

### 4. AI is an input, not the product.

AI accelerates creation.

It never replaces professional judgment.

------------------------------------------------------------------------

### 5. Many inputs. One packet.

Manual entry, AI, CSV imports, website imports, PDFs, or future
integrations all converge into the same packet model.

Inputs create a first draft.

They do not become permanent owners of the content.

------------------------------------------------------------------------

### 6. Inputs seed. They do not sync.

Once information enters FlowGuide, the packet belongs to the
professional.

FlowGuide should avoid creating second sources of truth through live
synchronization unless there is an exceptionally strong reason.

------------------------------------------------------------------------

### 7. Many renderers. One packet.

The same packet may appear as:

-   Mobile
-   Web
-   Email
-   Print
-   Future renderers

Renderers present the packet.

They do not own it.

------------------------------------------------------------------------

### 8. Prefer additive improvements.

When a problem appears, first ask:

> Can this be solved by extending the existing architecture?

Redesigns should be rare.

------------------------------------------------------------------------

### 9. Real workflow outweighs speculation.

Ideas become stronger after real use.

Whenever possible, build from observed friction rather than imagined
needs.

------------------------------------------------------------------------

### 10. Ship thoughtfully.

FlowGuide exists to be used by real professionals.

Progress requires both judgment and shipping.

Avoid two extremes:

-   shipping everything
-   documenting everything without building

The goal is disciplined momentum.

------------------------------------------------------------------------

## How to Use This Document

When evaluating a new idea:

1.  Does it violate one of these decisions?
2.  If yes, is there overwhelming evidence that the decision itself
    should change?
3.  If not, adapt the idea instead of the architecture.

This document should evolve slowly.

If it changes frequently, it is probably becoming a roadmap instead of a
record of judgment.
