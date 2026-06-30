# AGENTS.md — FlowGuide

Start here. This file gives every coding session the same mental model before
touching the code. For the full reasoning, read **[docs/product-direction.md](docs/product-direction.md)**.

## What FlowGuide is

**FlowGuide is a communication platform, not a link-sharing tool.** A shareable
link is one delivery method, not the product. The product helps a professional
communicate a prepared set of information to a client.

## Core architectural principles

1. **One packet. Multiple renderers.** The packet is structured data, authored
   once. Every delivery method — mobile/web, email, PDF/print, copy-client-message,
   future integrations — is a *renderer* that presents that same packet.
2. **The packet is the single source of truth.** Content lives in the packet.
   Renderers present it; they never own or change it. No second source of truth.
3. **New delivery methods should almost always be renderers, not duplicate
   packet formats.** Never create an "email packet" vs. a "mobile packet" that can
   drift. No AI-regenerated, per-channel content. One packet, shown many ways.
4. **Adapt to the professional, not the other way around.** Favor architecture
   that lets professionals communicate however they prefer (text, email, print,
   combinations, eventually CRMs) rather than forcing a single workflow. The
   packet stays delivery-agnostic; delivery method is chosen at share time, not
   at creation time.
5. **The magic is the mobile experience.** The interactive mobile FlowGuide is
   the best version of the product. Every other renderer exists to support and
   drive people *toward* it — supporting renderers are on-ramps, not substitutes.

## Before adding a feature, ask

- **Does this preserve one canonical packet?**
- **Is this a new renderer, or a duplicate representation?** (Prefer renderer.)
- **Does this make FlowGuide more flexible without making it more complicated?**

If a feature introduces a divergent copy, a second source of truth, or
per-channel generated content, reconsider the approach.

## Working norms

- This is a solo-founder product that values simplicity. Let real usage drive
  decisions; don't invent complexity or build ahead of evidence.
- The principles above are directional, not a mandate to build any specific
  renderer now. They are the philosophy that implementation must obey when work
  does happen.
