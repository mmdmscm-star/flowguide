# FlowGuide Product Direction

> Status: directional, not yet built. This document records the architecture and
> philosophy that future implementation decisions should follow. It is not a
> commitment to build any specific renderer on any timeline.

## What FlowGuide is

FlowGuide is a **communication tool**, not a link-sharing tool.

The earlier framing — "a tool that gives you a link to share" — described one
delivery method and mistook it for the product. The product is helping a
professional communicate a prepared set of information to a client. A shareable
link is one way that communication reaches the client. It is not the thing
itself.

## Core principle: one packet, multiple renderers

The **packet is the canonical source of truth**: structured data the
professional authors once. Everything a client receives is that same packet,
*rendered* for a particular delivery method.

```
                       ┌─────────────────────────┐
                       │   Packet (canonical)     │
                       │   structured data,       │
                       │   authored once          │
                       └────────────┬─────────────┘
                                    │
        ┌──────────────┬────────────┼────────────┬──────────────┐
        ▼              ▼            ▼              ▼              ▼
   Mobile/web      Email        Print / PDF   Copy client    (future
   experience      version      version       message        renderers)
   (primary)                                  (SMS/email
                                               text)
```

A **renderer** takes the canonical packet and presents it for a delivery method.
Renderers never own content and never change it — they only present it.

### Why this matters

This principle is the load-bearing decision. It is what keeps FlowGuide
coherent as delivery methods multiply. Hold it explicitly because the tempting
shortcuts all violate it:

- **No duplicate packets.** There is never an "email packet" and a "mobile
  packet" that can drift apart. There is one packet, shown two ways.
- **No regenerated outputs.** We do not use AI (or any process) to *generate a
  different artifact* per channel. Renderers are deterministic presentations of
  the same structured data, not new content derived from it.
- **No second source of truth.** If a fact lives in two places that can disagree,
  the architecture is wrong. Content lives in the packet; presentation lives in
  the renderer.

## Core principle: many inputs, one packet

The renderer principle above describes how the packet *leaves* FlowGuide: one
packet, shown many ways. The mirror image is how information *enters* it: **many
sources, one packet.**

**FlowGuide should not care where information comes from.** The source is not the
point — the packet is. Whatever the origin, information converges into the same
canonical packet, the same editor, and the same renderers. This is the deeper
thing FlowGuide does: **it transforms information into communication.** Inputs
bring raw information in; the packet and its renderers turn it into something a
client actually receives.

```
   AI          Manual        CSV         Website       (future
   generation  creation      import      import         inputs)
        └───────────┴────────────┼────────────┴─────────────┘
                                 ▼
                     ┌─────────────────────────┐
                     │   Packet (canonical)     │
                     │   one model, one editor  │
                     └─────────────────────────┘
```

An **input** is an adapter that produces a first draft of the canonical packet.
Like renderers, inputs touch the packet without becoming a second source of
truth — but from the other side: a renderer *reads* the current packet; an input
*writes* the first version of it, once. AI generation, manual creation, and
imports from structured sources are all just inputs; the list will grow, but the
rule does not depend on it. (Those examples are illustrative — not a request to
build any importer.)

### Why this matters

Naming the input side prevents the same class of mistakes the renderer principle
guards against — this time at the source:

- **Inputs seed once; they do not stay connected.** This is the load-bearing
  rule. A renderer re-reads the packet every time it presents it. An input does
  the opposite: its job ends the moment it has created the first draft. After
  that, the packet belongs to the professional — it grows, changes, and evolves
  independently of wherever it came from. We never create live synchronization
  back to an imported source, because that would reintroduce the exact bug the
  architecture exists to prevent: a second source of truth. **An import is a
  seed, not a live binding.**
- **A packet is source-agnostic once it exists.** There is no "AI packet," "CSV
  packet," or "website packet." There are only FlowGuide packets. Origin must
  not affect how a packet is edited, stored, rendered, or shared. A packet
  carries no memory of where it came from, and no behavior depends on it.
- **Every input converges on the one editor.** No source earns a privileged mode
  or a separate review screen. Whatever the origin, the professional reviews and
  shapes the result in the same canonical editor the manual path uses. (This is
  the input-side reading of "one editor.")
- **AI is one input among many.** Framing it this way is deliberate. It keeps
  "AI is an accelerator, not the product" (see [north-star.md](north-star.md))
  structurally true: AI earns its place by producing a good first draft faster,
  exactly as any other input would.

This is a framing principle, not a decision to build any importer. Which inputs
are worth building, and when, is driven by real use — the same discipline that
governs renderers.

## Renderer roadmap (illustrative, not committed)

Listed roughly by how primary each is today. Order is not a build sequence —
real usage drives what gets built and when.

1. **Mobile / web FlowGuide** — the primary, canonical, interactive experience.
   The richest renderer; the one the live link points to.
2. **Email version** — the same packet rendered appropriately for email
   constraints (limited layout, image-blocking, no interactivity). A presentation
   of the packet, not an email-shaped copy of it.
3. **Printable / PDF version** — the same packet rendered for paper / static
   distribution.
4. **Copy client message** — pre-written SMS/email text the professional sends
   from their own channel, wrapping the link in human context.
5. **Other presentation formats** — added only as real workflows demand them.

Each new delivery need should first be framed as *"what renderer presents the
existing packet for this?"* — not *"what new content do we create?"*

## The magic is the mobile experience

> **The magic of FlowGuide is the mobile experience.**

The interactive, mobile FlowGuide is the best version of the product — the one
that actually delights a client. Every other renderer exists in service of it.

The website, email, PDFs, printed packets, share messages, and future
integrations are **supporting renderers**: their job is to support and drive
people toward the interactive FlowGuide, not to replace it. An email that fully
satisfies the client inside their inbox has, in a sense, failed — the goal is to
get them into the real experience.

Practical implication: when designing any non-mobile renderer, optimize it to
*lead back to* the live FlowGuide (clear, obvious entry into the interactive
experience), and resist the urge to make a supporting renderer so complete that
it becomes a substitute. Supporting renderers are teasers and on-ramps, not
destinations.

## Professionals have different communication workflows

> **FlowGuide should adapt to the professional's workflow, not require the
> professional to adapt to FlowGuide.**

Professionals do not share a single delivery method. For example:

- Some primarily **text** clients.
- Some primarily **email**.
- Some hand over **print** materials.
- Some use a **combination** depending on the client.
- Some may eventually send through a **CRM or other system**.

The "one packet, multiple renderers" architecture is what makes this possible:
because the packet is delivery-agnostic, a professional can reach the same client
by text, email, and print without re-authoring anything, and can choose per
client.

**The packet stays delivery-agnostic. The delivery method is chosen when
sharing, not when creating the packet.** The packet does not care how it travels.

## Decision guardrails for future work

When evaluating a future feature, check it against these:

- **Does it keep the packet canonical?** If a feature introduces content that
  lives outside the packet, or a copy that can diverge, reconsider.
- **Is it a renderer, or a new source of truth?** Prefer renderers. Be suspicious
  of anything that *generates* per-channel content rather than *presenting*
  existing content.
- **Does it widen the professional's workflow, or narrow it?** Prefer changes
  that let professionals deliver how they already work. Avoid changes that
  assume a single channel.
- **Is the delivery method a send-time choice?** Delivery method should be
  selected when communicating, not baked into the packet.
- **Does an input seed or sync?** An import should create a first draft and then
  disconnect. Anything that keeps a packet live-bound to an external source
  reintroduces a second source of truth.

## Real-world use is the primary driver

The best improvements come from **actually using FlowGuide with real clients**,
not from brainstorming features in the abstract. When a real workflow reveals
friction, that observation is the strongest signal we have — stronger than any
idea that sounds good on paper.

This is a demonstrated pattern, not an aspiration. A single session of real use
surfaced, in order of need: publish-from-preview, item reorder, section reorder,
move-item-to-section, the advisor headshot, and professional links. None came
from a feature brainstorm; each came from hitting a real limitation while
preparing or sending a real packet.

Practical implications for future work:

- **Treat observed friction as the top of the backlog.** "I was using it and X
  got in the way" outranks "wouldn't it be cool if."
- **Be skeptical of ideas with no usage behind them.** They aren't forbidden, but
  they carry a validation gate (see [roadmap.md](roadmap.md)) — build only once
  real use, or a deliberate real-world check, justifies it.
- **Keep the loop tight.** Ship small, use it for real, let the next friction
  point tell you what's next. Don't build ahead of evidence.

## What this document is not

- Not a decision to build the email, PDF, or any other renderer now.
- Not a schema or technical design. It is the philosophy those designs must obey.
- Not a substitute for real usage data. We still let real professional and client
  behavior drive *which* renderers are worth building and *when*.
