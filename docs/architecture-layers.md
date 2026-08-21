# Architecture layers — what may know what

*Standing classification. Adopted 2026-08-20 after the cross-vertical audit.*

Three layers, and the rule is about **what each is allowed to know**.

## 1. Horizontal semantic core

Knows structure and syntax. Knows nothing about any industry.

- deterministic source-record envelopes (`detectSourceRecords`)
- claim extraction: `Label: value`, URLs, emails, phones
- specialized source-backed destinations: contacts, links, photos, address
- the precedence ladder — specialized → labelled detail → unresolved
- provenance, source spans, record attribution
- one-to-one, occurrence-aware reconciliation
- accounting with no dropped state
- privacy / source-authority guarantees
- **money recognition** — that a monetary fragment exists, never what it means

**Vertical vocabulary must not enter this layer.** Not senior living, not
catering, not the next corpus we meet.

## 2. Input-format and locale adapters

Knows how a particular input is shaped, or how a language or region writes.
Legitimately specific, and legitimately incomplete.

- tab/newline cell splitting, RFC4180 quoting, delimiter detection
- English clause markers, lead-in openers, continuation words
- US street-suffix address recognition
- currency symbols

Horizontal across *businesses* does not require solving every *language or
locale* now. These are adapters and may be extended per format or region
without touching layer 1.

## 3. Vertical-specific behaviour

Nothing in the enforcement path. Anything here is presentation, guidance or
analysis — never a deterministic repair.

- `placement.ts intendedField` — `care`, `memory care`, `pet` guidance derived
  from the packet prompts. Used by diagnostic scoring only; the reconciliation
  ladder does not call it. It must not migrate inward.

## Why the boundary is enforced this way

The cross-vertical audit found a lexical descriptor list inside layer 1. It did
not merely reduce recall in other industries — **its safety guard inverted**.
"Plated Dinner" was not a recognised descriptor, so a shifted price pairing in a
catering menu was accepted as confident, where the identical shape in senior
living was correctly refused.

A safety mechanism whose failure mode depends on the vertical is worse than no
safety mechanism, because its reliability is invisible from inside the corpus
that taught it. That list is gone and was not replaced with words from the new
corpus.

The same lesson had already appeared once, in miniature: a rule banning a
lowercase "to" in labels, derived from one corpus, rejected `Time to
Completion`, `Cost to Replace`, `Distance to Airport` and `Steps to Apply`. It
was replaced by a structural test — a lead-in *opens* like a clause — rather
than by a list of exceptions.

**A rule that needs a word list to work is a layer-3 rule wearing a layer-1
costume.**
