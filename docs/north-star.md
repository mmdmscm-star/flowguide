# FlowGuide North Star

*This is not a roadmap, a spec, or a pitch. It is a letter to whoever builds
FlowGuide next — including a future version of me. It exists so that the way we
learned to build this well isn't lost between sessions, releases, or years.*

*If you are reading this to make a decision, read it for the reasoning, not the
rules. The specifics will age. The judgment behind them shouldn't.*

---

## Why FlowGuide Exists

A trusted professional — a senior-placement advisor, a real-estate agent, a
financial planner — spends real effort figuring out what a client should do next.
Then that carefully-formed recommendation gets flattened into a hurried text, a
long email, a stack of printouts. The thinking was good; the delivery undersells
it.

FlowGuide exists to close that gap. It helps a professional communicate a prepared
set of recommendations in a way that **builds the client's confidence and moves
the conversation forward** — so the quality of the advice survives contact with
how it's delivered. That's the whole job. Everything else is in service of it.

## Where We Started

We started, honestly, a little in love with the AI. The early vision leaned hard
on generation: paste your notes, let the model structure everything, marvel at how
fast a polished packet appeared. AI was framed as the thing that made FlowGuide
special — almost as the product itself.

That instinct wasn't wrong, but it was aimed slightly off. The magic people
actually responded to wasn't that a machine wrote the packet. It was that the
*client* received something clear, personal, and trustworthy from someone they
already relied on. AI was a fast way to get there — not the reason it mattered.

## What Changed

The biggest lesson of building FlowGuide is almost embarrassingly simple: **nearly
every improvement that mattered came from using the product with real clients, not
from brainstorming features.**

The list of changes that made FlowGuide meaningfully better reads like a log of
small frictions hit during real use:

- **Publish from Preview** — because reviewing a packet and publishing it were
  awkwardly separate moments.
- **Item reorder**, then **Section reorder**, then **Move item to another section**
  — because AI's first-draft organization was a starting point, not the final word,
  and professionals needed to shape it.
- **Professional links** and a **headshot** on the advisor card — because
  relationship-driven work needs the packet to feel like it comes from a *person*.
- **Optional section titles** — because sometimes a section is just a container and
  forcing a heading added nothing.
- **The expanded manual editor** — because the canonical editor was hiding behind a
  collapsed state and made the manual path feel second-class.
- **Duplicate feedback** — because a feature that worked silently looked broken.

Not one of these came from a whiteboard. Each came from a professional using
FlowGuide and bumping into something. That pattern is the single most important
thing we know about how to build this product.

## Principles We've Earned

These aren't rules we adopted; they're conclusions we backed into, each with a
scar behind it.

**AI is an accelerator, not the product.** We learned this by watching what people
valued: not the generation, but the clarity and trust the client felt. AI earns
its place by getting a professional to a great packet faster — and it fails the
moment it becomes a separate, magical mode that competes with the professional's
own judgment.

**One packet.** The packet is the single source of truth. The instant content
lives in two places that can drift, we've created a bug that no feature can
outrun. Everything a client sees is *that* packet, presented.

**One editor.** There is exactly one canonical way to build a packet. When the
manual workflow looked "limited," the fix was never a second editor — it was
realizing the one editor was rendering in a different state. Two editors is two
sources of truth wearing a costume.

**Multiple renderers.** Mobile, email, print, share messages, future integrations
— these are all *ways of showing the one packet*, never separate copies of it. The
mobile experience is the magic; every other renderer exists to support it and lead
people toward it.

**Prefer additive improvements over redesigns.** Optional section titles, the
expanded editor, the footer label — each preserved the architecture and changed a
default or a condition rather than rebuilding a system. Redesigns are expensive and
risky; additions are cheap and reversible. We reach for the smallest change that
honestly solves the problem.

**Real-world workflow outranks brainstorming.** Stated plainly because it's the
one we most need reminding of. An idea that sounds good on paper is a hypothesis. A
friction someone hit while sending a real packet is evidence. We build from
evidence.

**Preserve architecture whenever possible.** When something feels wrong, the first
question is "is this the architecture straining, or a default/condition getting in
the way?" Almost always it's the latter. Diagnose presentation before rewriting
behavior.

**Small improvements compound.** None of the changes above was impressive in
isolation. Together they turned a promising demo into something professionals
actually reach for. We trust the accumulation.

## Where We Are Today

FlowGuide is no longer trying to prove the concept. The concept is proven — real
professionals use it with real clients, and it makes their communication better.

What it's becoming is a **polished communication platform**. The work now is less
about "can this exist" and more about "is this as good as it should be."

And the bottleneck has moved. It is no longer engineering capability — we can build
what we can clearly see. The bottleneck is **learning from professionals outside
our own experience**: understanding workflows we don't personally live, in
verticals we haven't worked in. The scarce resource is insight, not implementation.

## Where We're Going

Not a feature list — a direction:

- **Use with professionals we don't know.** Our own experience got us here; other
  people's experience is what we most lack. The next hard-won lessons live with
  users who aren't us.
- **Refine onboarding.** The first ten minutes decide whether a professional ever
  reaches the magic.
- **Improve the visual language.** Polish is not decoration here; it's part of the
  trust the packet is meant to create.
- **Strengthen the recipient experience.** The client is the ultimate audience.
  Everything upstream exists to make their moment clearer and more reassuring.
- **Let real-world use reveal what deserves to exist.** The same discipline that
  got us this far is the plan for going further.

## What We're Deliberately Not Doing

Just as important as what we build is what we've chosen — on purpose — to leave
alone:

- **Multiple editors.** One canonical editor. Always.
- **Per-vertical schemas.** The data model stays general. If a vertical needs more,
  the answer is almost always an *additive* layer (e.g. label templates), not a
  forked schema.
- **Premature customization.** We don't add knobs before anyone has asked to turn
  them.
- **Feature development without evidence.** Ideas without real use behind them wait.

These aren't rejections — they're deferrals with a condition. That's the point of
our **validation-gate philosophy**: an idea can be fully thought through and
preserved, yet still wait for the specific real-world evidence that would justify
building it. See [roadmap.md](roadmap.md) for the ideas currently waiting (and the
exact evidence each is waiting for), and [product-direction.md](product-direction.md)
for the architecture every decision must obey.

## A Personal Note

Over the last month, something changed in how I think about building products.

Early on, the question I kept asking was **"Could we build this?"** It's an
exciting question. It's also, I've realized, the easy one — and with modern tools,
the answer is almost always yes. "Could we" rewards cleverness and momentum, and it
will happily lead you to build a dozen things that no one needed.

Somewhere in here I started asking a different question: **"Should we build this?"**
That one is quieter and harder. It asks for evidence, for restraint, for the
patience to let real use tell you what's true instead of guessing. Most of the best
decisions in FlowGuide were the result of that second question — and a surprising
number of them were decisions *not* to build something.

If this project produced one durable thing beyond the product itself, it's that
shift. The capability to build was never really the constraint. The judgment about
what's worth building was. Whoever picks this up next: protect that judgment. Keep
asking the harder question. Let the people who actually use FlowGuide teach you what
it should become — and have the discipline to leave the rest alone.

*The specifics in this repo will change. That way of working is the thing worth
keeping.*
