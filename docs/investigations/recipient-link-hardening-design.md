# Recipient link hardening — bounded design

**Status: DESIGN, not built. 2026-08-18.**

Scope: materially strengthen recipient-link privacy, then stop. This is a
bounded security task, not the start of another reliability phase.

---

## What the slug actually is now

Before 0015, packet rows were readable and writable with the public anon key, so
slug entropy was a detail behind a much bigger hole. 0015 closed that. The
consequence is that **the slug is now the entire access control** for a
recipient packet — there is no second factor, no login, no expiry.

`src/lib/slug.ts` is already correct for new packets: platform CSPRNG, 22
base-36 characters (~114 bits), rejection-sampled so the modulo is unbiased.
The problem is entirely historical.

### The live distribution, measured 2026-08-18

| slug length | total | published | ever viewed |
|---|---|---|---|
| 8 chars (~41 bits) | 50 | **16** | 16 of 16 |
| 22 chars (~114 bits) | 13 | 3 | 3 of 3 |

Every one of the 16 short published links has been opened at least once, so
every one of them is a real link that reached a real recipient. Fifteen of the
sixteen have not been touched in 31–90 days (median 52).

**The database cannot tell active from obsolete.** `viewed` is a one-shot
boolean set on first open, and `updated_at` only moves when something writes the
row. Recency here is weak evidence, not a classification. Only the founder knows
which clients are still live.

## The threat, with arithmetic

**Targeted** — guessing one specific client's packet: 36⁸ ≈ **2.82 × 10¹²**.
Infeasible, and not the concern.

**Enumeration** — finding *any* live packet: 50 valid slugs in that space, so
≈ **5.6 × 10¹⁰** expected requests. At a sustained 10,000 req/s that is ~65
days; at 1,000 req/s, ~650 days.

So it is not trivially exploitable — but "decades" would be wrong, and **the
reason it is hard is the size of the keyspace, not any limiter anyone has
confirmed exists.** Verified, not assumed: no `middleware.ts`, no `vercel.json`,
no rate-limit library, and no limiter anywhere in `src/` other than the unrelated
5-per-hour cap on magic-link sends.

---

## Part 1 — abuse protection for the route

### The design principle: throttle MISSES, not traffic

A legitimate recipient opens a link that exists. An enumerator generates a
near-unbroken stream of links that do not. That asymmetry is the whole design:

> **Rate-limit on 404s. A successful packet view never touches the limiter.**

This matters because the alternative — counting every request — puts a write in
the hot path of every legitimate client view, adds latency to the one page that
must feel instant, and risks throttling a family sharing one link.

### Shape

```
GET /p/:slug
  │
  ├─ 1. cooldown check ── one indexed read on hashed IP
  │      in cooldown? → 404 immediately, no packet lookup
  │
  ├─ 2. resolve packet (unchanged)
  │      found? → render. LIMITER NOT TOUCHED. no write, no extra latency.
  │
  └─ 3. miss → record it
         over threshold in window? → open a cooldown for that IP
```

- **Storage**: one small table, `recipient_probe_attempts`, service-role only,
  RLS on with no policy — the same posture as `item_media_decisions` in 0016.
- **The IP is never stored.** Only `HMAC(ip, server_secret)`. The limiter needs
  to recognise a repeat source, not identify a person, and a table of visitor IPs
  is a privacy liability this product should not accumulate.
- **Self-expiring**: rows older than the window are deleted opportunistically on
  write, so there is no cron and no growth.
- **Fails open.** If the limiter's read errors, the request proceeds. A limiter
  outage must never take the recipient experience down — this is the same
  decline-vs-unavailable discipline as the ownership gate, applied where the
  stakes point the other way.

Suggested starting values, deliberately generous: **30 misses / 10 minutes →
15-minute cooldown.** A real recipient with a typo'd link makes one miss, not
thirty.

### What it buys, stated honestly

A throttle does not make 41-bit slugs safe. It changes the shape of the attack:

| | without | with (30 / 10 min / IP) |
|---|---|---|
| single host at 10k req/s | ~65 days | impossible — capped at 3/min |
| 100,000-IP botnet | hours | ~4 months, and continuously noisy |

It converts a cheap, quiet, single-host scan into an expensive, distributed,
sustained one. **It does not make the keyspace bigger.** That is Part 2's job,
and the two are complementary rather than alternatives.

### Defense in depth: Vercel Firewall

Vercel's WAF supports rate-limiting rules configured in the dashboard — no code,
no deploy, and it applies to every route including this one. **I could not verify
what this project's plan offers** (the stored CLI token has expired), so this is
a recommendation to check, not a claim.

If it is available it is strictly better as a first layer: it rejects abuse at
the edge before a function is ever invoked, which the application-level limiter
cannot do. It does not replace the application limiter — a dashboard rule is
invisible to the repo, untested, and lost if the project moves — but it is close
to free.

---

## Part 2 — the 16 legacy short slugs

**No link already sent will break, and nothing rotates automatically.** The
options below are all founder-driven, per packet.

### The realistic options

**A. Do nothing beyond Part 1.**
Legacy links keep working forever. Residual risk: those 16 remain the weak point
of a distributed attack, indefinitely.

**B. Retire obsolete packets — already possible, zero code.**
Unpublishing a packet makes its slug 404 immediately (`getPublishedPacket`
filters on `status = 'published'`, and 0015's policies enforce it in the
database). A senior-placement packet is a point-in-time deliverable; most of
these are likely finished work.

This is the **only option that actually shrinks the enumerable set**, and it
needs nothing built. Each retired packet removes one of the 50 targets — and
because expected search cost scales as *keyspace ÷ live slugs*, retiring half
the short slugs roughly doubles the attacker's expected work.

**C. Coexisting replacement links — small, additive, later.**
The founder's explicit question: *can a stronger link coexist with the old one?*
**Yes.** Today `packets.slug` is a single unique column, so a packet has exactly
one link. A `packet_slug_aliases` table — `(packet_id, slug unique, retired_at)`
— makes a packet resolvable by several slugs at once, so:

1. mint a 22-char slug for a packet, both links live;
2. send the strong link to the client;
3. retire the 8-char alias **when the founder chooses**, per packet.

Nothing is a flag day and nothing breaks on a schedule.

> **The trap to name explicitly:** minting a long alias does **not** reduce
> exposure while the short slug still resolves. The 41-bit target is still there.
> Coexistence is what makes retirement *safe*, not a substitute for it. Adding
> aliases and stopping would be security theatre.

**D. Blanket rotation — rejected.** Breaks links already delivered to real
clients, which is the one thing the founder ruled out.

### Recommended handling

1. **Part 1 first.** It protects all 63 packets, legacy and future, immediately
   and without touching a single link.
2. **Then a founder review of the 16.** I can produce the inventory — packet
   title, client name, published date, last activity — and for each one the
   question is only: *is this client still active?* Obsolete → unpublish.
3. **Build C only for what survives that review** and genuinely needs a stronger
   link. If the answer is "two packets", the alias table is probably not worth
   its own schema; re-publishing those as new packets may be simpler.

---

## What I recommend building now

**Build:** Part 1 — miss-throttled recipient route, hashed IPs, fails open,
self-expiring. One table, one helper module, one call site, unit tests for the
window/threshold/cooldown logic. Self-contained and finishable.

**Configure (founder, no code):** check whether Vercel's WAF offers rate limiting
on this plan; if so, add an edge rule as the outer layer.

**Decide, don't build:** the 16-packet review. Unpublishing obsolete packets is
existing functionality and is the highest-value, lowest-risk action available.

**Defer:** the alias table, until the review says how many packets actually need
it.

## User impact

- **Recipients:** none on the happy path. A successful view does not touch the
  limiter — no added latency, no write, no behaviour change.
- **A recipient behind an IP that just made 30 failed lookups:** sees "not found"
  for 15 minutes. Vanishingly unlikely without deliberate probing.
- **Professionals:** none. No editor, packet, or publish behaviour changes.
- **Existing links:** all continue to work exactly as they do today.

---

## What protection exists today (second inspection pass)

Verified rather than assumed, 2026-08-18:

**Present and working:**

- **`/p/[slug]` is the ONLY unauthenticated surface that reads a packet.**
  `getPublishedPacket` / `createPublicClient` appear in exactly three files:
  the recipient page, `queries.ts`, and `supabase.ts`. Every `/api/` route
  requires a session. There is no second door to close.
- **0015's RLS**, which is what made the slug the access control rather than one
  lock among several.
- **Generic metadata + `robots: noindex`.** No packet or client content reaches
  titles, descriptions or OpenGraph tags — the things crawlers and link-unfurl
  bots ingest. So the packets are not discoverable through search engines; an
  attacker must guess slugs directly.
- **`force-dynamic`.** No cached HTML can outlive an unpublish.
- **Unpublished and nonexistent are indistinguishable** — both 404 through the
  same `status = 'published'` filter, so the route leaks no existence signal.
- **A weak tamper-evidence signal.** `markPacketViewed` flips `viewed` on first
  open. An enumerator who actually lands on a live packet leaves that mark. It
  is not an alert and nobody is watching it, but it is evidence that exists.

**Absent:**

- No rate limiting of any kind on this route. No `middleware.ts`, no
  `vercel.json`, no limiter in `src/` beyond the unrelated magic-link cap.
- No alerting on 404 volume.
- No expiry, no revocation short of unpublishing, no second factor.

So the gap is precisely one thing: **nothing makes guessing expensive.**

---

## Verification plan

Unit-testable, because the window/threshold/cooldown logic is pure:

1. under threshold → allowed; at threshold → cooldown opens
2. cooldown expiry → allowed again
3. a **hit** never records anything (the legitimate path must stay untouched)
4. window rollover discards stale misses rather than accumulating forever
5. limiter read error → **allowed** (fails open)
6. two different hashed IPs never share a bucket
7. the raw IP never appears in what is stored

Then a disposable runtime check in the existing harness style: N+1 misses from
one synthetic source produce a cooldown; a valid packet fetched from a different
source during that cooldown still renders.

**Explicitly not tested by attack:** no enumeration run against production. The
arithmetic is not in doubt and the test would be indistinguishable from the
thing being defended against.

## Rollback plan

Deliberately trivial, because a limiter that cannot be switched off is itself a
risk to the recipient experience:

- **Kill switch first.** An env var (`RECIPIENT_THROTTLE=off`) short-circuits the
  check before any query. No deploy needed to disable — set and redeploy, or
  unset in the dashboard.
- **Code rollback:** revert one commit. The route's behaviour returns to today's
  exactly; nothing about packets, slugs or links changed.
- **Schema rollback:** `drop table recipient_probe_attempts`. It holds no packet
  data and nothing references it.
- **No link is ever touched**, so there is nothing to un-rotate. That is the
  point of doing Part 1 before Part 2.

---

# RESOLVED — the two open questions, and a changed recommendation

**2026-08-18, second pass.** The founder caught a real contradiction and asked
two questions before implementation. Answering them honestly reverses the
recommendation: **do not build an application-level limiter.**

## The contradiction was real

The first design claimed both of these:

> "A successful packet view never touches the limiter."
> "cooldown check — one indexed read on hashed IP → 404 before any lookup"

These cannot both be true. Work it through:

- If the cooldown is checked **only on misses**, an attacker already in cooldown
  still has every packet lookup executed, still enumerates at full speed, and
  still wins the moment they hit a valid slug. The limiter denies nothing.
- Therefore the gate **must** run before the lookup, on **every** request.
- Therefore **every successful request pays a limiter read.** The claim was false.

So the real cost of the application-level design is: **one indexed database read
on every recipient page view, forever** — on the single page that must feel
instant — to defend against an attack requiring ~5.6 × 10¹⁰ requests. Even
issuing it in parallel with the packet query (hiding the latency behind work
already happening) does not remove the query, the cost, or the failure mode.

That is a bad trade, and it only became visible once the path was written out
honestly instead of described.

## Q1 — the trusted source of client IP on Vercel

From [Vercel's request-headers documentation](https://vercel.com/docs/headers/request-headers):

> **`x-forwarded-for`** — "The public IP address of the client that made the
> request. If you are trying to use Vercel behind a proxy, we currently
> **overwrite** the `X-Forwarded-For` header and **do not forward external IPs**.
> **This restriction is in place to prevent IP spoofing.**"

> **`x-vercel-forwarded-for`** — "identical to the `x-forwarded-for` header.
> However, `x-forwarded-for` could be overwritten if you're using a proxy on top
> of Vercel."

So, precisely:

- On Vercel, `x-forwarded-for` is **written by Vercel's proxy, not by the
  caller** — a client-supplied value is discarded. It is not spoofable.
- `x-vercel-forwarded-for` is **strictly safer**, because it survives even if a
  proxy is ever placed in front of Vercel. It is the correct primary, with
  `x-forwarded-for` as fallback.
- Overriding `X-Forwarded-For` requires the Enterprise **Trusted Proxy** add-on,
  which this project does not have — so no caller can inject one.

**Conclusion:** a trustworthy client IP is available. The IP was never the
blocker; the per-request cost was.

## Q2 — does the platform give a cleaner option? Yes.

From [Vercel's WAF rate-limiting documentation](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting):

| Resource | Hobby | Pro |
|---|---|---|
| Included counting keys | **IP**, JA4 Digest | **IP**, JA4 Digest |
| Counting algorithm | Fixed window | Fixed window |
| Counting window | min 10s, max 10 min | min 10s, max 10 min |
| Number of rules | 1 per project | 40 per project |
| Included requests | 1,000,000 allowed | usage-based |

Actions: `429` (default), **Log**, **Deny**, **Challenge**. Rules are matched on
request conditions including path.

**Rate limiting is available on every plan, including Hobby.** It runs at the
edge, before a function is invoked, so it costs:

| | application limiter | Vercel WAF |
|---|---|---|
| DB read on a successful view | **yes, every time** | none |
| added latency for recipients | real | none |
| new table / schema / migration | yes | none |
| code to maintain and test | yes | none |
| blocks before function invocation | no | **yes** |
| survives repo/code changes | yes | needs documenting |

The platform option is better on every axis that matters here except visibility.

### The two honest weaknesses

1. **Per-region counters.** Vercel: *"Rate limit counters are tracked on a
   per-region basis; traffic matching a given rate limit key in multiple regions
   can exceed the limit you configure for any single region."* A geographically
   distributed attacker multiplies their effective ceiling by the number of
   regions they reach. This is a real weakening — but distributing across
   regions is strictly harder than rotating IPs, which already defeats any
   per-IP limiter including the application-level one.
2. **The WAF cannot tell a hit from a miss.** It sees the request before the app
   knows whether the slug exists, so the rule throttles all `/p/*` traffic rather
   than only 404s. This is why the limit must be generous: a recipient loading a
   packet makes a handful of requests; the rule only needs to stop a machine
   making thousands.

Neither weakness justifies putting a database read on every recipient page load.

## Final recommendation

**Build no application-level limiter.** Configure a WAF rule instead.

### The rule

| Field | Value |
|---|---|
| Name | `recipient-link-enumeration` |
| Condition | Request Path **starts with** `/p/` |
| Action | **Rate Limit** |
| Algorithm | Fixed Window |
| Window | `60s` |
| Limit | `60` requests |
| Key | **IP** |
| Then | **Log** for the first few days → then **Deny** |

**Why 60/60s:** a human opening a packet makes a handful of requests to `/p/*`;
sixty is roughly an order of magnitude of headroom, including a recipient who
reloads, shares, and reopens. An enumerator is capped at 60/min/IP/region —
against a ~5.6 × 10¹⁰ expected search, that is ~1.8 million IP-days per region.

**Why Log first:** it costs nothing, and it converts "I believe this is generous"
into "no legitimate traffic tripped this in N days." Flip to Deny once that is
observed. This is the same discipline as decline-vs-unavailable: do not act on a
belief you can cheaply turn into evidence.

### What goes in the repository

A dashboard setting is invisible to code review, untested, and lost if the
project is recreated. So two things are committed:

1. **This rule specification**, exactly as above, so it can be restored or
   audited without access to the dashboard.
2. **`scripts/security/verify-recipient-throttle.mts`** — sends N+ requests to a
   nonexistent slug and asserts the rule actually engages. This converts an
   invisible dashboard toggle into a tested, provable invariant, and it is the
   only reason to write any code at all for Part 1.

### What is explicitly NOT built, and why

- No `recipient_probe_attempts` table.
- No hashed-IP storage.
- No middleware.
- No limiter module, and no change to `/p/[slug]/page.tsx` whatsoever.

The recipient page keeps exactly today's behaviour and today's latency. The
narrowest coherent solution here turned out to be **less code than the first
design, not more** — which is what checking the platform first was for.

### Rollback

Set the WAF rule's action to **Log**, or delete the rule. Takes seconds, needs no
deploy, and cannot affect packets, slugs, or links. There is nothing in the
application to revert.

---

## Out of scope, deliberately

Login-gated packets, per-recipient tokens, link expiry, watermarking, view
analytics. Each is a product decision about what FlowGuide *is* rather than a
security fix, and none is required to close this gap.
