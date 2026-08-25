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

1. **Creator-side typography and readability — LEGACY EDITOR DONE 2026-08-22.**
   The creator UI was 12px-heavy while the recipient experience is 16px-led. A
   size policy, not a redesign: decision-making text, field values and
   actionable controls at `text-sm` minimum; `text-xs` kept only for genuine
   metadata.

   **Legacy editor, final:** `text-xs` **50 -> 28**, `text-[11px]` **2 -> 0**,
   `text-sm` 54 -> 78. 26 sites raised, 17 deliberately left alone. The item
   card grew 6% with no reflow break and no spacing changes; hierarchy is
   carried by weight (title 14/500, values 14/400, structural labels 12/500).

   Kept at 12px on purpose: structural section labels (DETAILS/LINKS/PHOTOS/
   Contacts), explanatory hint text, the Saved/Draft pill, uppercase field
   labels, `Remove` on a contact (so a destructive action does not outweigh the
   fields it deletes), and the photo delete badge (its icon sits in a fixed 20px
   circle that larger text overflows).

   **Optional follow-ups, both left at 12px on scope boundaries:**
   - `Convert to block editor` in `composition-mode-control.tsx` — shared chrome
     rendered by BOTH editors, so raising it reaches past the legacy editor.
   - the item-level `Save to Library` in `library/item-library-actions.tsx` — a
     Library component, excluded from that pass, though it renders inside the
     item card.

   **Library pass done 2026-08-22.** Same policy, 42 sites raised, 12 kept.
   `components/library` `text-xs` **54 -> 12**. Raised: every dialog control,
   every error and success notice, the workspace conflict explanation, and the
   save-back dialog's explanations - "Keep both ... or replace ..." IS the
   choice, not a hint about it, and raising them together stopped the dialog
   being half one size. Kept: intro hints, "Loading…"/"Comparing…" status, the
   detail panel's structural labels and its "Only you see this." privacy note,
   and the "From your Library ·" provenance row, which is deliberately quiet.
   The detail panel needed nothing - its values were already `text-sm`.

   **POLICY COMPLETE for the two surfaces a professional lives in.** Final
   counts, all deliberate keeps rather than backlog:

   | surface | `text-xs` | `text-[11px]` |
   | --- | --- | --- |
   | legacy editor | 28 | 0 |
   | components/library | 12 | 0 |

   **Parked, not dropped — 28 sites:** block editor (17, a prototype with one
   live packet), dashboard (6), `/new` (3), nav (2), plus `Convert to block
   editor` and one other in `composition-mode-control.tsx` (2) which is shared
   chrome rendered by BOTH editors and needs a decision before sweeping.

   The save-back dialog was verified by measurement and source review, not
   visually: reaching it needs an item inserted from the Library, edited in a
   packet, then saved back.

2. **Canonical Library photo normalization, and historical repair — 0030.**
   Migration numbers follow APPLICATION order, so parked work loses its
   reservation every time something else ships first: this was pencilled in as
   0024, then 0025, then 0026, then 0027, then 0028, then 0029, and is now **0030** — 0025
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


## Copy client message — SHIPPED, v1 COMPLETE 2026-08-22

A deterministic wrapper around the live FlowGuide, so a professional goes from
"it's ready" to "I can send this now" without writing anything.

**The v1 scope, deliberately drawn here so a later change knows what it is
changing:**

- **Post-publish bar only.** The moment the work ends. The panel takes plain
  values rather than a packet so the dashboard or editor could adopt it without
  rework — gated on someone actually returning to send a packet published
  earlier, which is not yet known to happen.
- **Deterministic, never generated.** Client name, packet title, live link,
  professional name. Each missing value removes its own line. A four-sentence
  message is the first thing a client reads and has no contract behind it, so
  run-to-run variation is worse here than it was in ingestion.
- **Never summarises the packet's contents.** No "12 communities with photos and
  pricing". That is a second account of the content that goes stale when an item
  changes, and it competes with the link instead of driving to it. A source gate
  fails the build if a content-describing clause is added.
- **Editable, not persisted.** A stored message is a second source of truth that
  drifts from the packet. Regenerating is free. A professional asking for their
  edit to be remembered is the signal that would change this.
- **Copy message leads, Copy link only steps back.** The message contains the
  link, so it takes precedence; the link behaviour itself is unchanged and both
  read one shared URL definition.
- **Explicitly out of scope:** sending from FlowGuide, email integration,
  delivery tracking, AI generation, per-channel (email/SMS) variants, subject
  lines, stored messages, dashboard/editor placement.

**What would earn a v2:** professionals pasting into email and writing their own
subject line (earns a second variant), or asking for the message somewhere other
than the publish moment (earns the second placement). Both are cheap once
observed and speculative before.

## Native packet photo upload — SHIPPED, v1 COMPLETE 2026-08-22

A creator uploads an image from the editor instead of going to an outside
service, copying a URL and pasting it back. Before this, 407 of 429 live photos
were hand-uploaded to Cloudinary.

**The v1 scope, as shipped:**

- **Supabase Storage, one `packet-photos` bucket**, public-read, 10MB,
  jpeg/png/webp/gif. No SVG - it is a script container and these objects are
  served publicly. Zero write policies: there is no client-side upload path.
- **Upload OR paste, in the existing photo row.** Both work. A professional who
  already keeps images somewhere is not forced to re-upload them.
- **`POST /api/packets/[id]/photos`**: ownership checked before the body is
  read; type sniffed from magic bytes, never the browser's Content-Type or the
  filename; object path is 32 random bytes carrying no filename, user id or
  packet id; `upsert: false`.
- **No schema migration.** 0029 creates the bucket only. `item_photos.url`,
  `storage_path` and `sort_order` are unchanged, and storage_path stays ''.
- **Legacy editor only** - 66 of 67 packets. The block editor is a prototype.

### Uploaded creator media is exempt from source provenance. Pasted URLs are not.

This is the load-bearing rule, stated once in `src/lib/creator-media.ts` and
consulted by name from `media-ledger.ts` and `media-ownership.ts`.

A photo whose URL sits under the `packet-photos` bucket was uploaded by the
authenticated creator through a route that verified they own the packet. It is
creator-supplied content: authorized by construction, requiring no AI source
provenance, and taking NO part in source accounting.

A pasted external URL gets none of that exemption. It is still subject to the
existing provenance and accounting rules, including `media_not_in_source`.

**Why it is load-bearing:** without it, the next finalize of ANY run on the
packet reports an uploaded photo as `media_not_in_source` - a BLOCKING failure -
parking the packet in review because the professional used the product
correctly. Verified end to end: an append after an upload finalized clean while a
pasted external URL absent from the source was still reported, in the same run.

The discriminator is the URL, NOT `storage_path`. See docs/production-state.md.

### Profile logo and headshot upload — SHIPPED 2026-08-22

The other half of the same problem. Item photos were native; the professional's
own logo and headshot - which appear in the contact footer of EVERY published
FlowGuide - were still URL-paste only.

- Reuses the `packet-photos` bucket. The name is an implementation detail: the
  object path carries the privacy, and a second bucket is a second policy to
  keep correct for no gain.
- `POST /api/profile/images` stores bytes and returns a URL. It does NOT write
  the profile - which field the URL lands in stays with the existing save path.
- Ownership differs from the packet route and that is why it is a separate
  route: a packet must belong to the session; a profile IS the session.
- One shared `storeCreatorImage` now holds the byte-sniffed type, the
  32-random-byte object name and the no-upsert rule, so the two upload surfaces
  cannot drift apart.
- Upload sits beside the URL box on all four identity fields (account logo and
  headshot, per-packet custom logo and headshot). Pasted URLs keep working.

**Snapshot behaviour, verified end to end:** updating the profile changes the
profile; a newly published FlowGuide snapshots the current images; an
already-published FlowGuide does NOT change when the professional later
rebrands - its recipient page still served the old logo after the profile had
moved on. A test pins the snapshot path so it cannot regress silently.

### Parked, deliberately

**Replaced-image cleanup.** Profile upload creates a NEW orphan pattern that
item photos did not: every time a professional changes their logo or headshot,
the previous object stays in the bucket with nothing referencing it. Item photos
mostly die with their packet; a logo is replaced in place. This is the strongest
future argument for a reaper - but a reaper must not delete an object a
published packet's SNAPSHOT still points at, which is exactly the case that
looks orphaned and is not. Deliberately not built.

Deletion and an orphan reaper (removing bytes another packet may point at is
worse than an orphaned file); drag reorder; crop and editing; a shared asset
library with reference counting; migrating the 407 existing Cloudinary photos;
profile logo/headshot upload (same mechanism, different surface, now cheap);
and canonical Library photo normalization, **now 0030**.

## Dashboard at scale — SHIPPED 2026-08-22

The Library had search at 65 items; the dashboard had none at 67, and the
dashboard is where a professional lands every time. `packets.map(...)` rendered
every packet, drafts and published mixed, ordered by `updated_at desc`.

**v1, as shipped:** client-side search over title, client name and slug; an
All / Drafts / Published filter with live counts; a distinct no-matches state
offering Clear filters. No API change, no schema change.

`src/lib/packet-filter.ts` holds the logic as a pure function so two things that
are easy to break later stay asserted: **filtering never re-sorts** (the API's
`updated_at desc` survives it), and **"no matches" returns `[]`** rather than
the whole list - which is what lets the dashboard tell "nothing matches" apart
from "no FlowGuides yet" and offer the right way out. Anything not published
counts as a draft, so an unanticipated status appears under Drafts rather than
vanishing from every view.

Verified at 0, 1 and 25 packets; search alone, status alone, combined, and
cleared; Viewed / Not yet viewed unchanged.

**Deliberately not in v1:** pagination, archive, tags, folders, bulk actions,
sort controls. 67 rows is a finding problem, not a rendering one.

**Not pursued, and recorded only:** 46 of 67 packets are drafts. That may be
development debris rather than behaviour, and search makes a long list navigable
without saying whether it should be long. Out of scope by instruction.

## Recipient contents index — SHIPPED 2026-08-22

Measured first, at 375x812: an item card is **759-809px against an 812px
viewport**. A client reads one option per screen and can never see two at once,
so a twenty-community FlowGuide is twenty screens and "which of these fits?"
requires holding the previous option in your head.

**v1:** a section with more than one item renders a numbered contents list of
its item titles, in packet order, each a real anchor to the existing card.

- It says NOTHING about an item - no summary, no chosen "key detail". A test
  forbids the component from reading any item field except `title`, because the
  moment it describes an option it becomes a second account of the packet that
  can disagree with the card.
- Real `<a href="#item-…">` anchors, so back, keyboard and screen-reader
  behaviour come for free. `<nav aria-label>`, `<ol>`, numbers `aria-hidden`.
- The anchor target is a wrapper div; **ItemCard is byte-unchanged**.
- No data, no schema, no state.

**Row height was the whole design.** The first attempt used `py-2.5`, giving 45px
rows - twenty items came to ~900px, taller than the viewport it exists to save.
Tightened to **39px**, so twenty items total 781px and fit one screen. No
tighter: it is a tap target on a phone for often-older readers.

Verified at 1 (no index), 3, 15 and 20 items, locally and in production.

**Deliberately not built:** collapsible cards, sticky navigation, filtering,
comparison mode, key-detail selection. This is navigation over the FlowGuide,
not a new presentation mode. Collapsible cards remain the thing that would
actually solve comparison, and they need a design decision first - which detail
earns the collapsed row differs by vertical.

## Email-ready FlowGuide — SHIPPED, v1 COMPLETE 2026-08-24

The second delivery method, for a client who would rather read the content in
the email body than follow a link. **A renderer of the packet, not email
content**: `src/lib/email-render.ts` reads the packet through
`getPublishedPacket` — the same function the live recipient page uses — and
nothing is stored, so an email cannot drift from what the client sees online.

**Both delivery options stand side by side** in the post-publish bar, and both
are kept deliberately: the short client message + live link (which drives to
the mobile experience), and the full formatted email version (for the client who
wants it inline). Neither replaces the other.

### Built for hostile clients

Tables and inlined styles only, one column at 600px, no `<style>`, no classes,
no flex/grid, no `object-fit`. Gmail strips style blocks and drops classes;
Outlook renders through Word. Modern CSS here does not degrade, it disappears.

Copying is three-tiered — `ClipboardItem` with `text/html`, then a real
selection plus `execCommand`, then an honest "your browser blocked the copy".
**It never silently degrades to plain text**, which would defeat the feature
while looking like success.

### Every photo, after the first Gmail paste said otherwise

v1 rendered `photos[0]` and dropped the rest — 9 of 51 on the test packet. That
is not a smaller gallery, it is a different packet.

Now: one hero, the rest as a square thumbnail index, one stated
`View all N photos` link to the item. That mirrors the live `PhotoGallery`
(one photo prominent, the rest behind "View all N") rather than inventing an
email-only idea. Stacking 51 full-width images would have added ~18 phone
screens and buried the prices under the pictures.

Tiles are cropped square **by the source**, via `squareThumbnailUrl()` beside
the existing `thumbnailUrl()` in `image-source.ts`. `object-fit` does not exist
in Outlook and **32 of the 51 photos are not square**, so a CSS-squared tile is
a stretched tile.

### The professional identity is the live one

The footer carries all nine `professional_snapshot` fields, matching
`ProfessionalFooter` and `PacketHeader` field for field — logo, business,
label, headshot, name, phone, text, email, website, custom links. There is no
email-only identity system.

It is shaped as a **contact card**, and that shape was the fix for a second
report: a bare "name · phone · email" line reads as an email signature, so a
personal note ending "Thank you, Ramona" read as signed twice. The note is
never touched; the footer stopped imitating a sign-off.

The headshot is sized by height alone rather than cropped to the live circle —
Outlook ignores `object-fit` and would squash a 920x560 portrait, and a rounded
rectangle is a smaller departure than a distorted face.

### KNOWN CONSTRAINT — Gmail clips a large FlowGuide

Measured on the real 9-item / 51-photo packet: **85,537 bytes of HTML, 83.5% of
Gmail's reported ~102KB clip threshold.** At roughly 9.5KB per item of that
richness, **clipping begins around 10–11 items**; a 20-item packet lands near
190KB.

**Photos were NOT reduced to stay under it, and should not be.** Gmail clips to
`[Message clipped] View entire message` rather than discarding — every photo
survives one click away, and the email carries the live link twice. This is a
presentation blemish, not a fidelity failure.

Two caveats on the number: ~102KB is reported, not measured here, and the
threshold counts the whole message including quoted history.

**What would earn work:** a professional reporting that a real client hit the
clip and was confused by it. The fix then is bounding the *markup*, not the
photos — the per-item text is the larger share above ten items.

Counter-intuitive but measured: preserving all 51 photos made the email
**lighter** — image payload fell 1.56MB → 1.18MB, because the heroes stopped
being raw originals and became bounded `q_auto/f_auto` renditions.

### Verified

Two real rich-copy → Gmail pastes into a real mailbox, at desktop and narrow
width, before and after the photo/identity fixes. In production,
`scripts/ingestion-runtime/verify-email-prod.mts` drives one disposable
published packet through the deployed route: 31 checks covering photo count and
order, source-side square crops, all nine identity fields, both delivery
options still present, and **private notes not escaping**. It is repeatable and
cleans up after itself.

The private-note guarantee is enforced three ways: `getPublishedPacket` strips
`notes` before a recipient surface can see it, a source-level test forbids this
renderer from reading `.notes` at all, and the production check asserts a
planted note never appears.

**Explicitly out of scope, and staying there:** sending from FlowGuide, Gmail
or any provider integration, delivery tracking, templates, subject lines, AI
copy, per-channel content, stored email state, and clipping optimisation.

## Print / Save as PDF — SHIPPED, v1 COMPLETE 2026-08-24

The third supporting renderer, and **the last one named in
product-direction.md** — mobile/web, email, print, copy client message are now
all real. `/p/[slug]/print` renders the same published packet through the same
`getPublishedPacket` the live page and the email version use.

**No PDF generator.** The browser's print dialog does both printing and Save as
PDF, so FlowGuide hands a professional a PDF without owning a PDF pipeline, a
dependency, or a stored artefact.

### Why it is a dedicated route and not a print stylesheet

The cheap version — `@media print` over the live page — would have been
**silently wrong**. `PhotoGallery` mounts only the slides within two of the
current index, so paper would have carried at most five photos per item and
looked entirely fine doing it. That is the same failure class as the email
renderer's `photos[0]`, which took a real Gmail paste to catch. A static
server-rendered route lays every photo out instead.

### Verified as paper, not as a preview

Headless Chrome printed the real 9-item / 51-photo packet to **Letter (8.5x11,
read from the PDF MediaBox)** and every page was inspected.

**The first proof found a real defect**: details tables split across pages in
three places, one of them after a single `Type` row, leaving an orphan line in
a box the page edge had cut open. Prices are the comparison surface, so a table
divided across a leaf is the worst break this document can make. `.pg-details`
now avoids breaking. The second proof had no table splits, the **same 12
pages**, and nothing displaced.

**Fragmentation is tuned per unit, not per card.** An item MAY break internally
— forcing a dense community whole would either overflow a page or push a
mostly-empty one ahead of it — while item heads, tables, photo tiles, contacts
and the footer each stay intact, and `break-after: avoid` keeps a community's
name from ending a page with its photographs overleaf.

**Known cosmetic cost:** trailing gaps of 1.5–2.5in on four of twelve pages,
where a photo grid moves to the next page as a unit. That is the price of not
splitting a grid mid-row, and it costs **no extra pages**. Not worth trading.

### Completeness, checked against the database rather than by eye

9/9 items · 6/6 sections · **60/60 detail labels and values** · 53 embedded
images (51 photos + logo + headshot, plus one alpha mask) · **0 private notes**.
A photo-less 11-item packet also prints cleanly: 4 pages, 0 images, no empty
photo frames.

One flagged "missing" label turned out to be the measurement, not the document:
the Supabase CLI returned `Washer \u0026 Dryer` JSON-encoded and the harness did
not decode it. The PDF had it correctly all along.

### Print-specific presentation decisions

- **Links print as URLs.** A hyperlink is inert on paper, so every destination
  is shown as text a reader can type. The same link, said the only way paper
  can say it.
- **The live address is printed twice**, header and footer, and taken from the
  request so it is right in production, in previews and locally. Paper is a
  supporting renderer; its job is to lead back to the phone.
- **No contents index.** On screen it is a jump target; on paper it would be a
  list of titles with no page numbers beside them, and page numbers are out of
  scope.
- **The identity appears once, at the end**, not as a running footer. Repeating
  it needs `position: fixed`, which reserves its height on every page.

### Deliberately not built

Server-side PDF generation, stored or downloadable PDFs, cover pages, page
numbers or a table of contents, print-specific content editing, paper-size
settings, and include/exclude controls. All of those are a document product;
this is a renderer.

**Adjacent fix, bounded as instructed:** `copyLink()` in `preview-actions.tsx`
now awaits and catches the clipboard write instead of reporting "Copied!"
unconditionally, and shows the link when a browser blocks the copy. This clears
the backlog entry below.

## Professional identity surface (/settings) — SHIPPED 2026-08-24

**The problem was reachability, not capability.** The nine profile fields were
always editable — inside the 2,131-line legacy packet editor and nowhere else.
So a **block-editor user had no route to them at all**, and a new professional
had to open a packet to discover they existed. Every renderer FlowGuide has —
web, email, print — reads that profile, and a professional who never found it
published anonymous FlowGuides.

### One rule

"Is this profile ready?" now has a single answer in
`src/lib/professional-identity.ts`, and **the publish route asks it** rather
than keeping its own copy. The rule is unchanged and is publish's own: **a name,
and at least one way to reply** (email or phone).

This was the explicit instruction and it matters: a separate "has a name"
heuristic for onboarding could tell a professional they were set up and then
have publish refuse them, or nag someone whose profile publish would accept.
A `null` contact stays ready — that is `identity_mode: "none"`, a deliberate
absence, not an omission.

### One form

The fields moved into `professional-profile-fields.tsx`, rendered by **both**
the legacy editor and `/settings`. It is presentational — it renders and
reports, never saves — so the editor keeps its own debounced PATCH and its own
save indicator, and its behaviour is unchanged. The **per-packet custom
identity's** logo and headshot stayed in the editor, because those save to the
PACKET, not to `/api/profile`. Per-packet identity semantics are untouched.

The block editor gained `CreatorNav` — a link to the one form, never a second
one.

### The prompt

One line, in the **server shell** rather than the client workspace: a first-run
prompt that appears after a spinner is one the new professional has already
scrolled past. It names the actual gap, advances when the first gap closes, and
disappears for good when there is none.

No wizard, no completeness score, no repeated nudges, nothing to dismiss.

### Verified — 26 checks, disposable professional, local and production

Brand-new with no profile row · half-configured · fully configured, with **the
prompt and the publish refusal naming the same gap at every step**; an
already-published packet keeping its snapshot across a later profile edit while
the next publish picks the change up; skip-profile publishing still storing an
empty snapshot; image upload unchanged; both editors still loading.

Five checks first "failed" against server-rendered HTML because the dashboard
and block editor draw client-side — a `fetch` sees only `Loading...`, and
`BLOCK COMPOSITION` is uppercased by CSS. Confirmed in a real browser, and the
prompt was moved to the shell so the server can answer for it honestly.
`scripts/ingestion-runtime/verify-identity.mts` re-runs the whole thing.

### Deliberately not built

Onboarding wizard, profile scoring, repeated nudges, billing or plans, teams or
roles, starter content, a marketing or signup funnel, and any change to
per-packet identity semantics.

## Public front door — SHIPPED 2026-08-24

One landing page, a neutral public demo, a gate on `/new`, rewritten metadata
and one static OG card. Built so that approaching another professional does not
require explaining the product first.

### The demo replacement was the urgent part

Not for positioning reasons. The old `/p/demo` attributed **invented prices,
invented staff and invented phone numbers to four real companies** — Sunrise,
Brookdale, Oakmont, Pacifica — on a public URL. It also **leaked its own private
note**: `/p/demo` resolves the fixture directly rather than through
`getPublishedPacket`, so the note stripping never ran, and `ItemCard` is a
client component, so the note sat in the RSC payload and was readable in
view-source. Both were verified live before replacing them.

The replacement is an event consultant presenting offsite venues to a company.
**Every entity and every fact is invented** — venues, people, addresses, prices,
capacities. Phone numbers use the `555-01xx` block reserved for fiction, domains
use `.example.com` (RFC 2606, unregistrable), photographs are generic interiors
so no identifiable building is presented as an invented venue. It carries **no
`notes` field at all**, which is the safe shape for a fixture on that code path.

### POSITIONING IS HORIZONTAL, AND THAT IS A CONSTRAINT

No vertical is named anywhere public. Senior-living data remains fine as
internal test data; it must not appear in marketing copy, the hero, the demo,
screenshots, the "why it exists" story, or examples. Gating `/new` also removed
"Senior placement" from the publicly visible packet-type selector.

Public copy says **guide**, never *packet*. `packet` stays the internal name in
the schema, API, and docs.

### The `/new` dead end

`/new` used to render for anyone: a signed-out visitor could paste real client
notes, press Organize, get a 401, and be pushed to `/login` with the text gone.
Preserving the draft was considered and **rejected as the wrong shape for magic
links** — request, open email, often on another device — so carrying it through
would mean redesigning the token. The box now never renders before there is a
session to save it to, and login says why they arrived.

### Trust-model language

The page does not claim the model "doesn't invent facts". It claims the review
step the product actually enforces: FlowGuide organises the material you give
it, and nothing reaches a client until the professional has read and corrected
it. Absolute claims about model output are not ones we can stand behind.

### Deliberately not built

Pricing, blog, SEO programme, CMS, testimonials, logos, customer counts,
animation system, multi-page marketing site, OG generation system, or any
change to the application's design.

## Backlog — recorded, not started

**`/p/demo` bypasses the recipient payload path.** `resolvePacket` returns
`samplePacket` directly, so `getPublishedPacket`'s stripping of `notes` never
runs for the demo. The current fixture carries nothing private and a test
enforces that, so there is nothing to leak today — but the *mechanism* is still
there for any future fixture. Closing it properly means routing the demo through
the same shaping as a real packet. Not urgent; recorded so it is not
rediscovered.

**Copy Link reports success it did not have — FIXED 2026-08-24** (see the print entry above; kept here for the record).

Original report: `copyLink()` in
`src/components/preview-actions.tsx` calls `navigator.clipboard.writeText()`
without awaiting or catching it, then sets "Copied!" unconditionally. When the
clipboard rejects — an insecure context, a denied permission, a browser that
refuses without a user gesture — the professional is told the link was copied
and it was not. Observed live: the browser pane denies clipboard writes and the
button still reported success.

Pre-existing, unrelated to the client-message work, and deliberately NOT fixed
there so that change stayed to what was verified. The fix is small: await the
promise, catch it, and show the same fallback the client-message panel already
shows. Do it whenever that file is next open for another reason.

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


> **Live production state, rollback commands and known limitations:
> [docs/production-state.md](production-state.md).**

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
