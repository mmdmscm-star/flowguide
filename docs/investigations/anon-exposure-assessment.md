# Anon-key exposure — bounded assessment

Closed by migration 0015 on 2026-08-17. This is a deliberately time-boxed
assessment of *what was exposed and for how long*, not an open-ended forensic
project. Conclusion first: **exposure proven; exploitation unknown.**

## What was exposed

Anyone holding the `anon` key — which ships in the browser bundle and is public
by design — could, against **every published packet** and without knowing any
slug:

- enumerate them and read `title`, `client_name`, `personal_note`, `map_url`,
  `raw_input`, `custom_identity`, `professional_snapshot`
- read all child content: sections, items (including **street addresses**),
  photos, links, details, and **`item_contacts` — third-party names, phone
  numbers and email addresses**
- **overwrite** any of the packet columns above (verified: an anon `UPDATE`
  returned `rows=1`)

Not exposed: creating packets (`INSERT` was refused), deleting or modifying
child rows, unpublishing (`with check (status='published')` held), draft
packets, and anything in `users` / `sessions` / `magic_links` /
`professional_profiles` / `ingestion_*`, which had RLS enabled with zero
policies. `TRUNCATE` and `REFERENCES` were *granted* but had no execution path,
since PostgREST exposes no verb for them.

## The window

| fact | date | source |
|---|---|---|
| repo's first commit | 2026-06-02 | git |
| first packet created | 2026-06-05 | `packets.created_at` |
| first packet published | 2026-06-05 | `packets.published_at` |
| policies first appear in the repo | 2026-06-11 | `git log -S`, `schema.sql` |
| most recent publish | 2026-08-14 | `packets.published_at` |
| closed | 2026-08-17 | migration 0015 |

**Upper bound: 2026-06-05 → 2026-08-17, roughly 73 days, covering 19 published
packets** (63 packets total).

The exact date the policies reached the *database* cannot be established. They
came from `schema.sql` applied by hand, not from a numbered migration, so
nothing records when it ran — and the first published packet (06-05) predates
the schema.sql commit (06-11), which means the schema was applied to production
before it was committed. The window above is therefore the widest defensible
bound, not a measurement.

## Evidence of exploitation: none available

**Supabase request logs cannot answer this.** They are Dashboard-only (Logs
Explorer); the Management API needs a personal access token this project does
not hold, and the anon/service keys grant no access to them. Log retention is
**plan-dependent** and I have not established what this project's plan provides
— check the Dashboard for the actual available history. Whatever it is, it will
almost certainly be a fraction of the ~73-day window, so a clean result narrows
the question rather than answering it.

**In-database signals are uninformative.** The one shape an external overwrite
would leave is `updated_at > published_at` on a published packet. That is true
for **19 of 19**, because `markPacketViewed` and every ordinary edit also touch
the row. It carries no signal in either direction. There is no audit table, no
row-version history, and no soft-delete trail to interrogate.

So there is no dataset that could distinguish "never touched" from "read
repeatedly". Absence of evidence here is genuinely absence of *evidence*, not
evidence of absence — and equally not evidence of compromise.

## Conclusion

**Exposure proven; exploitation unknown.** The hole was real and reachable, and
I verified it empirically rather than inferring it. Whether anyone found it
cannot be determined with the history available, and the existence of a
vulnerability is not itself grounds to conclude it was used.

Deliberately NOT done, because it would be inference dressed as investigation:
guessing at compromise from packet contents, notifying clients on the strength
of a possibility, or treating the 19/19 timestamp pattern as a finding.

## If you want the last few days checked

One bounded thing is still available to you and not to me — the Dashboard's
Logs Explorer, covering whatever retention your plan gives:

> Dashboard → Logs → **API / Edge**, filter `path` containing `/rest/v1/packets`
> and look for requests where the role is `anon` with method `PATCH` or `GET`.

Legitimate FlowGuide traffic never appears there as `anon` — every server path
uses the service role — so **any** `anon` row against `/rest/v1/` is worth a
look. If that window is clean it does not clear the preceding two months, but
it costs five minutes and it is the only real evidence that exists.

## What actually reduces risk now

The exposure is closed at both layers, and the closure is proven by
`scripts/security/anon-exposure-probe.mts` (0 anon capabilities). Two follow-ups
matter more than archaeology:

1. **Rotate the anon key** if you want to invalidate any copy an attacker may
   have retained. Low value on its own — the key is public by design and the
   policies were the actual defect — but it costs little.
2. **16 of 19 published packets still carry ~41-bit slugs.** Now that 0015 has
   closed enumeration, the slug IS the access control — so its entropy is the
   whole privacy story rather than a detail behind a bigger hole.

   `src/lib/slug.ts` is already correct for new packets: platform CSPRNG,
   22 base-36 chars (~114 bits), with rejection sampling so the modulo is
   unbiased. But it only applies going forward, and the live distribution is:

   | slug length | packets | published |
   |---|---|---|
   | 8 chars (~41 bits) | 50 | **16** |
   | 22 chars (~114 bits) | 13 | 3 |

   **There is no rate limiting on the recipient route.** Verified, not assumed:
   no `middleware.ts`, no `vercel.json`, no rate-limit library, and no limiter in
   `src/` other than the unrelated 5-per-hour cap on magic-link sends. Whatever
   the hosting platform does about volumetric abuse is not something this
   assessment has established, so it is not part of the reasoning below.

   The honest arithmetic, resting on the size of the space alone:

   - 36^8 ≈ **2.82e12** possible 8-char slugs.
   - Guessing one **specific** packet is infeasible.
   - Guessing **any** valid packet is ~50x easier, because 50 slugs are live in
     that space: ≈ **5.6e10** expected requests. At a sustained 1,000 req/s that
     is ~650 days; at 10,000 req/s, ~65 days.

   So this is not trivially exploitable, but "decades" would have been wrong, and
   the reason it is hard is the keyspace — not a rate limiter anyone has
   confirmed exists. A sustained, noisy, months-long scan is within reach of a
   determined attacker, and nothing currently observes or interrupts one.

   Flagged for deliberate hardening, NOT blanket re-slugging: rotating a slug
   breaks links already sent to clients, so the design has to decide which
   packets are still active, whether old links must keep working, and whether
   `/p/[slug]` should carry explicit abuse/rate-limit protection of its own —
   which, on this evidence, is probably the higher-value half of the fix.
