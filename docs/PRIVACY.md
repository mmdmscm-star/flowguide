# Privacy & exposure notes

This documents the privacy posture of published packets and AI Organize as of the
privacy-hardening checkpoint. It is a factual record, not a set of guarantees.

## Correct framing for published packets

**Published packets are unlisted and excluded from search indexing, but anyone
with the link can view and forward them.** Do not describe them as private.

- Access is by unguessable link only (a random slug, now ~113 bits of entropy
  for newly created packets — see `src/lib/slug.ts`). No sign-in is required.
- The recipient page sends `robots: noindex, nofollow` and page metadata is
  entirely generic (no packet, client, sender, or note content in the title,
  description, or OpenGraph tags), so crawlers that reach the URL will not index
  it and link-unfurl bots have no content to surface. See
  `src/app/p/[slug]/page.tsx`.
- The `/p/:slug*` route sends `Referrer-Policy: no-referrer` (see
  `next.config.ts`) so the bearer-token URL does not leak to third-party sites a
  recipient taps through to.
- The page is `dynamic = "force-dynamic"`, so unpublish/delete takes effect on
  the next request at the origin — there is no prerendered/ISR copy. This does
  **not** retract copies already captured externally (browser history,
  search-engine caches, link-unfurl snapshots, screenshots).

## AI Organize (structuring)

Source text is sent to OpenRouter with per-request privacy routing
(`provider.data_collection = "deny"` and `provider.zdr = true`; see
`src/lib/ai-structure.ts`). If no compliant endpoint exists for the model, the
request fails clearly (`no_private_endpoint`) rather than falling back to a
non-compliant provider. Model output is never written to logs.

This enforcement is per-request in code. It should be aligned with the
account-level settings in the OpenRouter dashboard (logging disabled, ZDR/data
policy). See the checkpoint report for the exact dashboard locations to verify.

## Open tradeoff: `raw_input` retention

`packets.raw_input` stores the professional's original pasted source text
(set in the structure route; appended to by "Add with AI").

**It is not an accidental backup.** It backs the existing **"Original Input"**
editor feature — the editor renders it so the professional can see and re-read
what they originally pasted (`src/app/edit/[id]/page.tsx`, `<OriginalInput>`).

Because of that live dependency, retention is **an open product/privacy
tradeoff, deliberately left unchanged at this checkpoint**, not a bug to purge.
`raw_input` is retained for the life of the packet and removed only when the
packet is deleted (FK cascade). Any future reduction (e.g. a manual "clear
original source" action, or a TTL) must first account for the Original Input
feature so it is a product decision, not a silent data loss.
