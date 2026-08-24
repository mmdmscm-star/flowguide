# FlowGuide Roadmap


> **PRIORITISATION POSTURE — corrected 2026-08-18.**
>
> Several entries below were written under a retired rule: that a feature had to
> wait for real observed friction, with a "validation gate" before any code. That
> rule is **no longer how work here is prioritised**, per `AGENTS.md`.
>
> Items are prioritised against **the FlowGuide product we intend to sell,
> architectural coherence, and business value**. A prior complaint is not a
> precondition — friction is *evidence, not permission*.
>
> The gates below are preserved as the historical record of how each item was
> originally deferred, and because several describe genuinely useful **validation
> work** (e.g. checking Street View coverage against real addresses) that is worth
> doing before building. Read them as "what to find out first", never as
> "wait until a client complains".

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

### What to find out first (validation, not a gate on permission)

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

---

## Details Model — Vertical-Fit Watch

**Status:** Keep as-is. Watching for real-world friction across verticals.

### The observation

Item **Details** are stored and edited as a simple **label / value** pair
(`item_details(label, value, sort_order)`), rendered as a two-column list. It
works extremely well for senior living (pricing, care levels, room types). The
open question is whether that label/value editing model stays natural as real
packets get built in other verticals (farmers markets, travel, real estate,
financial planning, etc.).

### Decision (2026-07-02): leave it alone

No change to the **data model, editor, or renderer**. Checked all three: there is
**no senior-specific coupling** anywhere — the model is a generic key/value pair,
the renderer is a plain two-column list, and the editor copy is neutral ("Details"
/ "Label" / "Value"). The senior-living flavor lives in the *example data entered*,
not in the architecture.

This is the inverse of a build-gate: the default is **do nothing**. label/value is
about the most vertical-agnostic structure possible, the schema is additively
extensible (richer details can be added later with no migration today), and
pre-building flexibility with no observed friction would violate our
evidence-first principle. label/value "working extremely well" is the strongest
reason to leave it untouched.

### Revisit trigger (what friction actually looks like)

Revisit **only** on **repeated friction across multiple real packet types, in ≥2
verticals** — a pattern, not one awkward packet. Specific signals to watch for
while building real packets:

- **Retyping the same labels on every item** in a vertical (e.g. every real-estate
  item = Beds / Baths / Sqft / Price). Most likely signal — points to wanting
  per-vertical *label templates/presets*, which would be an **additive layer on
  top of** the current model, not a redesign of it.
- **Cramming a non-scalar into `value`** — a date range, a list, a link, a
  paragraph. If professionals fight the single-line value field, the model is
  straining.
- **Leaving Details empty and putting that info in Description instead**,
  repeatedly, in a given vertical — a sign key/value doesn't match that vertical's
  mental model.

### If the trigger fires

Prefer the **smallest additive** response, in keeping with the architecture:
per-vertical label templates/presets layered over the existing `item_details`
table — not multiple editors, not a per-vertical schema, not a redesign of the
label/value model. Re-evaluate only with the accumulated evidence in hand.

### Reference

Working principle adopted 2026-07-02 after reviewing the Details data model,
renderer ([item-card.tsx](../src/components/item-card.tsx)), and editor. Relates to
the "real-world use is the primary driver" section of
[product-direction.md](product-direction.md).

---

## Reliability & ownership stack — SHIPPED AND CLOSED

**Closed 2026-08-18.** Deployed as commit `3bc03e8`; see
[2026-08-18-production-deploy.md](migrations/2026-08-18-production-deploy.md).

seg-v4 record-atomic segmentation, media accounting, item provenance (0014),
ownership recomputation, and the publish-time ownership gate with Move/Keep
resolution (0016). Proven end to end against the live model and database before
and after deploy: 0016 at 25/25, seg-v4 at 21/21 locally and 21/21 in
production, plus a 10/10 post-deploy smoke on disposable data.

**This line of work is finished.** It is not a standing programme, and further
reliability work needs its own justification rather than inheriting this one's.

### Available, not scheduled — historical ownership recovery where provable

The gate binds to `SEGMENTER_VERSION`, so every packet imported before
2026-08-18 declines on a version mismatch. Nonblocking by design and verified in
production: those packets publish exactly as before. The consequence is that the
gate protects **future imports, not the existing library**.

Recovering ownership for historical packets is therefore an **available
capability, deliberately unscheduled**. If it is ever taken up, the framing is
**recovery where provable** — establish ownership only where the surviving
source and provenance prove it (`source_hash` still matching `raw_input` at the
recorded `source_offset_base`, chunk and emit indices present), and leave it
unknown everywhere else. A guessed provenance is worse than an absent one:
`recomputeOwnership` refusing to answer is exactly what makes a finding
trustworthy.

**Not a backfill. Never a backfill.**

---

## Library v1 — SHIPPED AND CLOSED

**Closed 2026-08-19. Commit `e8abbad`.** Production smoke 20/20, cleanup clean.
Record: [2026-08-19-library-v1-deploy.md](migrations/2026-08-19-library-v1-deploy.md).

Reusable items in the working editor. The loop is **Save → Find → Insert → Edit
freely → explicitly update the saved version**, with no synchronization anywhere:
insertion is a disconnected snapshot, because a FlowGuide is a record of what was
said to one audience and must not change because a saved item later did.

Shipped: `/library` with full-text search over titles, addresses, descriptions
and detail labels · Save to Library with a duplicate warning that never merges ·
user-initiated bulk promotion, nothing preselected · Add from Library, appearing
immediately · direct editing reusing the existing item editor · Update saved
version with the tailored-descendant safeguard · optimistic concurrency on both
write paths.

**This workstream is closed.** The next Library iteration should be decided from
using the live feature, not from the backlog this release generated. Of the ideas
that came up during this build, **AI import straight into the Library shipped**
on 2026-08-19; the rest are collected under *Library evolution* below.

### Still open, no current priority

- **Block-mode Library insertion** — see its own entry. A composition project.
- **`/p/[slug]` rate limit** — the WAF rule stays in **Log**, collecting
  observation data. The decision point is whether any legitimate source
  approaches 60 requests per 60s; if not, switch the action to Deny and re-run
  `scripts/security/verify-recipient-throttle.mts`.

---

## Library first-use fix — SHIPPED AND CLOSED

Shipped 2026-08-19 (`d3e29f9`), proven in production 21/21.

First real use of Library v1 exposed it: a professional created a FlowGuide,
added items, published it, and never found how to fill an empty Library.
Nothing was broken — every control was present and every route worked. The
affordances that could populate an empty Library were the visually subordinate
ones, and none of them were where the work ends. Reproduced end to end against
production before anything changed.

Shipped: state-aware precedence in the Library bar (an unknown lookup stays
reuse-first rather than claiming the Library is empty) · the same bulk save
offered again after the last section · "Save to Library" styled as an action
instead of inheriting the muted treatment chosen for ancestry · entries written
straight into the Library with no FlowGuide involved · an empty state that names
both ways to fill it and says draft-or-published is irrelevant · creator
navigation between Dashboard, Library and New · an owner-only return path on a
published FlowGuide, with recipients unaffected · `viewed` no longer set by the
author opening their own link.

**Closed.** The next Library work is the AI import below.

## Library AI import — SHIPPED AND CLOSED

Shipped 2026-08-19 (`fec04b4`). Migrations 0020, 0021, 0022 applied and verified
one step at a time. Production proof 35/35; post-deploy smoke 10/10; Library v1
smoke 20/20; first-use smoke 21/21; seg-v4 incident proof 21/21.

Library → Import with AI → chunked resumable extraction → durable proposals →
review/edit/select → save selected → finish or abandon. No FlowGuide is created.
The claim/lease/stage/split engine is shared with packet ingestion unchanged;
`library_import` reuses the items-only prompt and result shape `section_append`
already had. `library_save_proposal` creates the entry and consumes the proposal
in one transaction, and remains the only writer.

**Two defects in existing shared code surfaced only in the runtime proof**, and
both would have shipped otherwise:

- `splitRange` could cut a range into itself plus a one-character tail, because
  boundary preference outranked placement and the blank line separating records
  sits at the range edge. Any record over `PRESPLIT_CHARS` in an ordinary paste
  hit it, in packet imports too, presumably since 0012.
- Both drive loops treated a transient provider failure as terminal, discarding
  the server's own retry tagging. The rule now lives once in `chunk-outcome.ts`.

Neither was reachable by reasoning. Both needed a real oversized record through a
real provider.

### Final state, verified after deploy

| | |
|---|---|
| Rollback point | `3e95889` — redeploy from the Vercel dashboard |
| Schema | none in this deploy; 0020/0021/0022 applied and verified beforehand |
| Non-terminal ingestion runs | **0** (all runs `finalized`) |
| Orphan `library_import_proposals` | **0** |
| Stray disposable users | **0** |
| `SEGMENTER_VERSION` | deliberately not bumped — it versions the chunk *plan*, which `splitRange` does not affect, and nothing was in flight at deploy |

Every proof and smoke cleaned up its own disposable data and verified the removal
by re-query. No live FlowGuide and no live Library entry was read or written at
any point.

One caveat recorded honestly: the seg-v4 incident proof reported `splits=0`, so it
does not exercise `splitRange` directly. It proves the hardened class of failure
is intact — record alignment, media ownership, provenance, publish. The split path
itself is proven by the Library import proof, which forces a real presplit.
Neither proof covers it alone.

**This workstream is closed.** Use it on real material before deciding what earns
the next iteration.

---

## Create a FlowGuide from the Library — SHIPPED AND CLOSED

Shipped 2026-08-19. Migration 0023 applied and verified (38/38). Production
proof 26/26; post-deploy smoke 10/10; Library v1 smoke 20/20.

`New FlowGuide` offers **Use my Library · Paste & organize with AI · Start
blank**; the Library offers the same action inline against the list already on
screen. Choose saved material, get one new draft with independent copies, land
in the editor.

**One transaction, not compensating cleanup.** The first implementation created
the FlowGuide, its section and the copies as three writes and deleted the draft
if a later step failed — which a process that dies never gets to do. 0023 does
all of it inside one plpgsql body, reusing `update_item_content` as the content
writer and coercing photos through the single `library_canonical_photos`. Proven
by injecting a failure on the third of four copies: zero packet, zero section,
zero items survive.

Structural equivalence with an ordinary blank create is pinned by comparing every
column except identity and `content_rev`, with `content_rev` asserted directly
as 0 and greater-than-0 either side — a stronger statement than the equality it
replaced.

**Three verifier defects surfaced during this work, none of them migration
defects:** a `LIKE` pattern where `_` is a wildcard matched a comment that
promised the opposite of what it asserted; a text sentinel could not coalesce
with a jsonb column; and `content_rev` was compared between two packets with
different content. Each was fixed by making the check stricter, never by
loosening it.

## POST-REVIEW MUST REVISIT — parked, not dropped

Recorded 2026-08-19, at the founder's request, so nothing parked disappears while
the product is reviewed as a whole. **Nothing here is implemented until that
review produces a concrete finding.** The order below is the order it was given
in, not a priority ranking.

1. **Creator-side typography and readability.** The creator UI is 12px-heavy
   while the recipient experience is 16px-led — measured at 141 `text-xs` plus 7
   `text-[11px]` across creator surfaces. Decision-making text should generally
   be at least `text-sm`, with `text-xs` reserved for real metadata. A size
   policy, not a redesign. Screens touched during the language and view-vs-edit
   passes already meet the floor; the broad sweep is what remains.

2. **Canonical Library photo normalization, and historical repair — 0029.**
   Migration numbers follow APPLICATION order, so parked work loses its
   reservation every time something else ships first: this was pencilled in as
   0024, then 0025, then 0026, then 0027, then 0028, and is now **0029** — 0025
   is the observe-only fact ledger, 0026 is packet-path evidence retention, 0027
   is review-unit resolution, and 0028 is the dedicated per-chunk review-unit
   channel. No applied migration
   file is ever renamed to make room; the parked work simply takes the next free
   number when it is finally written. The
   application tolerates both the canonical `{url}` shape and the bare strings an
   AI import used to write, and every read and write path handles both — so
   production is protected and this is not urgent. What remains is canonical data
   *at rest*: normalising in `library_materialize_proposals` using the existing
   `library_canonical_photos` (0023), plus a one-time repair of
   `library_items.photos` and `library_import_proposals.payload->'photos'` where
   an element is a JSON string. Touches no packet, section, item or `item_photos`
   row — those were always written through `update_item_content`. Row counts to
   be reported from a read-only preflight before anything is applied.

3. **`/p/[slug]` rate limit.** The WAF rule stays in **Log**. The decision point
   is whether any legitimate source approaches 60 requests per 60s; if not,
   switch the action to Deny and re-run
   `scripts/security/verify-recipient-throttle.mts`.

4. **Library organization at scale.** Simple groups or categories and manual
   ordering — *when actual use supports it*. Deliberately absent so far because
   search plus recency has not yet been shown to fail.

5. **NEXT INVESTIGATION — context-aware ingestion / chunking experiment.**
   Recorded, not started. Nothing about chunking, chunk size, source-map
   prompting or model context strategy was touched by the semantic-contract
   work, deliberately.

   *Hypothesis:* resilient chunking may be reducing the model's useful
   run-level context on modest inputs, even where the chunk boundaries are
   structurally safe. The 15-shop ice-cream source is 6.5KB and was cut into
   three chunks; a model shown one third of a directory has less to reason with
   than one shown the whole thing.

   *Method:* the same moderate-size sources under three modes — (a) current
   chunking, (b) chunking plus deterministic run-level source-map context,
   (c) whole-source processing where comfortably within model limits.

   *Measure RAW model quality, before enforcement:* ACCEPTED vs REPAIRED,
   omissions, semantic consistency, run-to-run variation. The deterministic
   contract stays as the safety layer in every mode — the question is how much
   work the model is being made to do badly, not whether the contract catches it.

6. **RESOLVED — packet-path evidence destruction.** Closed by 0026: finalize and
   discard both retain source, segments, results and the ledger for a bounded
   30-day window; a discarded run survives the deletion of its draft; expired
   orphans are deleted unless a Library entry still references them.

7. **RESOLVED — the hostname validator's hardcoded TLD list.** Replaced with
   `tldts` (Public Suffix List). Note for whoever writes fixtures: `.world` IS a
   valid suffix, so `hello.world` must not be used as a false-positive example —
   doing so asserts that a false negative is correct.

8. **Block-mode Library insertion.** A composition project, low priority. See its
   own entry: `trg_freeze_items` forbids the item INSERT outright, so this is a
   change to a composition invariant rather than a Library feature.

**Closed by the 2026-08-19 deploy, and off this list:** view-versus-edit in the
Library, and the empty-Library dead end where `Create a FlowGuide` opened
selection mode over nothing.

Older deferred questions — item reuse, profile-per-packet, Street View fallback,
the Details label/value model, recipient text-size control — keep their own
entries elsewhere in this file and are unchanged.

## Library AI import — original plan (superseded by the entry above)

Plan: [docs/investigations/library-ai-import-plan.md](investigations/library-ai-import-plan.md).

Designed for realistic scale — 20–40+ items per import, not a handful. The
claim/lease/stage/split engine is already destination-agnostic (it authorizes on
`ingestion_runs.user_id` and touches no packet table), so the recommendation is
to widen the run row with a `destination` discriminator rather than fork the
engine into duplicate tables. The Library gets **no finalize RPC that writes
content**: entries are still written only through `createLibraryItem`.

One decision is open and needs a call before implementation — whether review
selections/edits persist in a small proposals table or live client-side.

## Block-mode Library insertion — NEXT LIBRARY FOLLOW-UP

**A composition project, not a Library patch. Not solved in this release.**

Library v1 ships legacy-only. Inserting a saved item into a block-mode FlowGuide
is refused by the application, before any write, and no Library affordance is
offered in the block editor.

### Why it is refused

Not an unimplemented feature — a deliberate structural invariant:

- `trg_freeze_items` (0007) rejects **INSERT**, **DELETE**, `section_id` and
  `sort_order` changes for any item whose packet is in block mode.
- `trg_freeze_sections` (0007) does the same for sections.
- Only *content* edits (title, address, description, notes) are permitted.

In block mode, composition is owned by `packet_blocks`, and the
`items`/`sections` substrate is frozen as a base. So the question is not "how do
we create the block?" — it is "may we create the item?", and the schema's answer
is a considered no.

### How this was established

0018 added `library_insert_item_block`, creating item and block atomically. It
was applied 2026-08-18, then its runtime proof showed the first statement raising
`items are frozen: cannot INSERT an item into a block-mode packet`. The function
was correct in every respect except that it could never succeed, and was dropped
in 0019. Both migration files remain; neither history was rewritten.

Worth keeping: even failing, the packet was left completely untouched — no orphan
item, no orphan block, `assert_packet_block_consistency` still passing.

### What taking this on actually means

**Revisit the block-mode item/section freeze and the composition ownership
model.** Specifically: whether block mode should permit item creation at all,
and if so, who owns membership — an authorized-exception path like the
`app.block_transition_authorized_packet` mechanism conversion already uses, or a
different arrangement entirely.

That is a decision about how composition works, and it should be scoped and
argued on its own, not as an extension of the Library.


---

## Recipient Text-Size Control (A / A+ / A++)

**Status:** Deferred. Watching whether the larger default is enough.

### The idea

Let a **recipient** adjust the packet's text size (e.g. A / A+ / A++) for their
own reading comfort — most relevant to older clients. This is distinct from the
default type scale, which we already raised for everyone. It's about giving the
*reader* control, not changing the baseline again.

### Why it's deferred

We just lifted the default recipient reading tier (16px body, 18px item titles,
20px section titles, higher-contrast labels). That may be enough on its own.
It was deferred on that basis. Under the current posture it is prioritised on
product value like anything else; the open question is whether it earns its place
in the recipient UI, not whether someone has complained.

### What to find out first (validation, not a gate on permission)

Worth confirming, at the new larger default, whether readers still struggle with
size — useful evidence for sizing the work, NOT a precondition for doing it:

- a client says the text is hard to read, or
- you watch someone pinch-zoom, hold the phone close, or ask you to make it
  bigger while reading a real packet.

Such an observation would be strong evidence. Its absence is not a veto.

### Shape if the gate passes

A **render-only** control: a small A / A+ / A++ toggle that scales the packet's
**root font-size**, so every element scales proportionally off the existing
`rem`-based sizes. Persist the choice in the browser (`localStorage`) so it sticks
across visits.

- **Presentation only** — it never touches the canonical packet; it's a preference
  on the *renderer*, exactly as "one packet, multiple renderers" intends.
- No packet data, no server state, no per-recipient records.
- Placed unobtrusively (e.g. a corner of the packet) so it aids reading without
  cluttering it.

### Reference

Grew out of a real send to an elderly client (2026-07-09): the packet was hard to
read even with reading glasses, and the recipient had no way to enlarge it. The
first response was to fix the default scale (shipped); this control is the
deferred follow-on. Relates to the recipient typography lift and the
"one packet, multiple renderers" principle in
[product-direction.md](product-direction.md).


## Backlog — recorded, not started

**Mixed-run discard-only review.** A run holding BOTH a media-accounting failure
and a review-required unit cannot be cleared unit by unit: the media failure has
no per-unit remediation, so the run still exits only through discard. That is
fail-closed and unchanged from how media review has always worked, and this
slice deliberately did not redesign the mature media-accounting workflow around
the new resolution UI. Worth revisiting only if a real mixed run turns up and
the discard-only exit actually costs someone their import.

**Library imports produce review units nobody surfaces.** Enforcement is not
destination-guarded - it runs for library chunks too - but the review
aggregation lives in the packet finalize path, and a library import closes
through `library_close_import_run`, which clears chunk evidence including
`review_units`. With enforcement ON, a privacy-rejected unit on a Library import
would therefore be held and then discarded without ever being shown. This is a
BLOCKER for enabling enforcement globally, not a backlog item to schedule
casually: it must be closed, or enforcement must be scoped to the packet path,
before the flag goes on for normal traffic.


## Reliability rollout — COMPLETE 2026-08-21

**Packet semantic enforcement is ON in production.** `FLOWGUIDE_ENFORCE_CONTRACT=1`
in the Vercel Production environment, deployed and aliased to the production
domain. Library ingestion is unchanged.

Rollback is one variable: `vercel env rm FLOWGUIDE_ENFORCE_CONTRACT production`
followed by a redeploy. The pre-change state was recorded behaviourally, not
from a config listing — a bounded production import showed
`enforcementEnabled: false`, and the variable was absent from the environment.

Verified after enabling, against the deployed process:

| | packet | library |
| --- | --- | --- |
| scope recorded | `enforced` | `out-of-scope` |
| items governed | 3 | 0 |
| ACCEPTED / REPAIRED / STRIPPED | 9 / 0 / 0 | 0 / 0 / 0 |
| review-required units | 0 | 0 |
| permanent contract failure | none | none |

Production smokes 10/10, 20/20, 22/22. No disposable data left behind; the 65
real Library entries untouched.

**The boundary that made this safe** is the destination guard, not the flag. The
flag says whether the contract may act; the guard says where. Library is
excluded because a held unit there would be cleared by
`library_close_import_run` without anyone seeing it — and without enforcement a
model-placed note stays visible to its owner, so declining preserves content
rather than risking it.

**Next: the context-aware ingestion/chunking experiment** (item 5). No further
reliability subsystem before it unless normal use exposes an actual blocker.


## Context-aware ingestion experiment — CLOSED 2026-08-22

Five hypotheses tested offline, ~$17, production untouched throughout. Four
failed: whole-source (more omissions, the only fabrication), a structural source
map (the gain came from directive framing, with side effects), structural facts
alone (inert), and orientation-before-execution (made output LESS consistent -
the brief is itself nondeterministic, so it adds variance rather than damping
it).

The one that worked came from a forensic finding rather than a guess: whole
source did not fail from truncation, tail degradation or randomness. It
compressed DELIBERATELY - one value where the source listed several, a summary
where an enumeration stood. A generic lossless-organization contract, naming no
field or domain, recovered most of that. It failed operationally as a
whole-source arm (20% of calls hung), so it was moved to the chunked path where
it cost nothing.

**Shipped 2026-08-22**: the lossless block on `organizeLeadPrompt` and
`sectionsPrompt`. Replicated across two paired runs - source-backed placement
71.5% -> 77.1%, omissions 19.7 -> 15.7, every safety measure flat at zero,
output tokens 1.02x. `itemsOnlyPrompt` (Library, section_append) untouched.

Recorded, NOT pursued: six "shared blind spots" - bare unlabelled values alone
on a line - invisible to every strategy tried. That is a prompt gap, not a
chunking one, and nothing here addressed it.
