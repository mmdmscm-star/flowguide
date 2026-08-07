# LESSONS_LEARNED.md

> This document captures discoveries that changed how we think about
> FlowGuide. These are not permanent rules. They are observations earned
> through building and using the product.

------------------------------------------------------------------------

# Why This Exists

Ideas are easy to invent.

Lessons are expensive.

Whenever FlowGuide surprises us, we capture *why* it surprised us so we
don't have to relearn it months later.

------------------------------------------------------------------------

## AI wasn't the magic.

Early on it was tempting to think FlowGuide was an AI product.

Real use taught us something different.

The magic is that professionals communicate better.

AI is valuable because it helps produce a great first draft faster---not
because it exists.

------------------------------------------------------------------------

## The packet became the center.

At first it was easy to think about generators, editors, PDFs, emails,
and mobile pages as separate things.

Eventually it became obvious:

Everything revolves around the packet.

That realization simplified almost every architectural decision
afterward.

------------------------------------------------------------------------

## Small improvements compound.

Very few meaningful improvements were dramatic.

Instead they accumulated:

-   Publish from Preview
-   Reordering sections and items
-   Optional section titles
-   Better editor defaults
-   Intentional title line breaks
-   Better authoring language ("Prepared for", "Note")

Each one was small.

Together they changed how the product felt.

------------------------------------------------------------------------

## Building reveals architecture.

The "many inputs, one packet" principle did not come from a planning
session.

It appeared while imagining CSV imports and realizing every creation
method should converge into the same packet.

Good architecture often emerges from solving real problems.

------------------------------------------------------------------------

## Real examples expose weak assumptions.

Creating packets outside senior living repeatedly revealed assumptions
we didn't notice.

Examples included:

-   Farmers markets
-   Nurseries
-   Vendor directories

Those examples forced FlowGuide to become more universal without
becoming more complicated.

------------------------------------------------------------------------

## Presentation matters.

Professionals are judged not only by their recommendations but by how
clearly those recommendations are delivered.

Improving presentation is improving the product.

------------------------------------------------------------------------

## Shipping teaches faster than speculation.

Discussion matters.

Documentation matters.

But eventually the next lesson only appears after building something and
putting it in front of real people.

That is where FlowGuide is heading.

------------------------------------------------------------------------

# Future Lessons

This document should continue growing.

Whenever something makes us say:

> "We didn't expect that."

...it probably belongs here.
