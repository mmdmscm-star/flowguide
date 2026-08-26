# Production state — as of 2026-08-25

One page, so a later session does not have to reconstruct this from commit
messages. Everything here is live unless it says otherwise.

## What is on

| | state | rollback |
| --- | --- | --- |
| Packet semantic enforcement | **ON** — `FLOWGUIDE_ENFORCE_CONTRACT=1` in the Vercel Production environment | `vercel env rm FLOWGUIDE_ENFORCE_CONTRACT production`, then redeploy |
| Library semantic enforcement | **OFF by design** — destination guard inside `enforceChunkResult`, not the flag | n/a; see the limitation below |
| Lossless block in the organize prompts | **LIVE** — commit `fd62712` | `git revert fd62712`, then redeploy |
| Creator photo upload | **LIVE** — bucket `packet-photos` (0029) + `POST /api/packets/[id]/photos` | see below; two independent steps |
| Profile logo/headshot upload | **LIVE** — same bucket + `POST /api/profile/images` | revert the code; already-uploaded images keep working |
| Copy client message | **LIVE** — post-publish bar; deterministic, never persisted | revert the code; nothing stored |
| Email-ready FlowGuide | **LIVE** — commit `a5f05a2`; `GET /api/packets/[id]/email`, renders on demand | revert the code; nothing stored, no schema, no flag |
| Print / Save as PDF | **LIVE** — commit `259724a`; `/p/[slug]/print`, renders on demand | revert the code; nothing stored, no schema, no flag |
| Professional identity surface | **LIVE** — commit `ddeb494`; `/settings`, existing `PATCH /api/profile` | revert the code; no schema, no flag |
| Public landing page + neutral demo | **LIVE** — commit `89fd869`; `/`, `/p/demo`, `/og.png` | revert the code; no schema, no flag |
| Quick navigation toggle | **LIVE** — commit `eba04b3`; `packets.show_quick_nav` (0030), default true | set the column back to true; the code default is also true |
| Delete from the editor | **LIVE** — commit `bb18833`; reuses `DELETE /api/packets/:id` | revert the code; the endpoint is unchanged |
| Bare hostname persisted as a link | **LIVE** — commit `74511a1`; staging-time normalization, no schema | revert the code; nothing stored differently |
| Neutral recipient link previews | **LIVE** — commit `3975048`; `src/lib/recipient-metadata.ts` + `/og-recipient.png` | revert the code; no schema, no flag |
| Migrations | `0001`–`0032` applied; local and remote in sync | per-migration; none pending |

Both rollbacks are independent, carry no state, and need no migration.

## Photo upload rollback

Two independent steps, in this order if both are wanted:

1. **Code**: `git revert` the photo-upload commit and redeploy. The editor loses
   the Upload button; pasted URLs keep working; photos already uploaded keep
   rendering, because they are ordinary URLs in `item_photos`.
2. **Bucket**: only if you also want the files gone. Reverting the code does NOT
   remove them, and removing the bucket BREAKS any packet already using an
   uploaded photo. Check `select count(*) from item_photos where url ~
   '/storage/v1/object/public/packet-photos/'` first; if it is non-zero, do not
   drop the bucket.

Step 1 is safe and reversible. Step 2 is destructive and usually wrong.

## The creator-supplied media rule

`src/lib/creator-media.ts` is the single statement of it, consulted by name from
`media-ledger.ts` and `media-ownership.ts`.

A photo whose URL sits under the `packet-photos` bucket was uploaded by the
authenticated creator through a server route that verified they own the packet.
It is authorized by construction and needs no AI source provenance.

**This is load-bearing.** Without it, the next finalize of ANY run on a packet
reports an uploaded photo as `media_not_in_source` — a BLOCKING failure — and
parks the packet in review for using the product correctly. Verified end to end:
an append import after an upload finalized clean, while a pasted external URL
absent from the source was still reported.

The discriminator is the URL and NOT `item_photos.storage_path`, which stays ''.
storage_path is written by `update_item_content` (0011), the atomic writer shared
by both editors, which hardcodes '' and takes photos as plain URLs. Changing that
is a large edit to a mature write path; the URL proves the same thing because the
bucket grants no write to anon or authenticated.

## Creator image upload: one helper, two surfaces

`storeCreatorImage` in `src/lib/photo-upload.ts` is the single implementation of
everything security-critical about storing a creator's image: the type comes
from sniffed magic bytes (never the browser's Content-Type or the filename), the
object name is 32 random bytes carrying neither filename nor identity, and
nothing is ever overwritten.

Both upload routes call it:

| route | ownership check |
| --- | --- |
| `POST /api/packets/[id]/photos` | the packet must belong to the session |
| `POST /api/profile/images` | the profile IS the session |

Ownership stays at the routes precisely because it differs. Everything else is
shared, so the two surfaces cannot drift apart. Tests assert that neither route
reimplements the randomness or the sniffing.

Both use the `packet-photos` bucket. **The bucket name is an implementation
detail** - profile logos live there too. A second bucket would be a second
policy to keep correct for no gain, since the object path is what carries the
privacy.

## Snapshot behaviour (why a rebrand does not rewrite delivered packets)

Publishing reads the LIVE professional profile and freezes it into
`packets.professional_snapshot`; the recipient render path reads the snapshot.

- updating logo/headshot changes the profile;
- a newly published FlowGuide snapshots the current images;
- an already-published FlowGuide does NOT change when the professional later
  rebrands.

Verified end to end, and pinned by a test. **If publish ever stops snapshotting,
image upload silently starts rewriting packets that were already delivered.**

Caveat, pre-existing: packets whose snapshot is NULL (published before the
snapshot feature) still fall back to the live profile, and those WOULD change on
a rebrand.

## One unattributed object in packet-photos

`ee/ee97e720….jpg` sits in the bucket with ZERO referencing rows in
`item_photos`, `library_items` or `packet_blocks`. It is not from the upload
verification (that used a PNG, since removed) and no script or smoke uploads a
JPEG.

**Left in place deliberately.** v1 has no reaper precisely because deleting
bytes you cannot account for is the wrong default, and that reasoning applies to
our own cleanup too. Delete it only if someone can say what it was.

## The email renderer stores nothing, and that is the design

`GET /api/packets/[id]/email` builds the HTML on demand through
`getPublishedPacket` — the same function the live recipient page uses — and
persists nothing. A stored copy would be a second source of truth that goes
stale the moment the packet changes. Rollback is therefore just reverting code:
there is no flag, no table, no migration and no cached artefact.

**Both delivery options are live and neither replaces the other:** the short
client message + live link, and the full formatted email version.

**Known constraint:** a FlowGuide beyond roughly 10–11 photo-rich items exceeds
Gmail's ~102KB clip threshold and arrives as "[Message clipped] View entire
message". Nothing is lost — every photo is one click away and the live link
appears twice. Photos are deliberately NOT reduced to avoid this. See the
roadmap entry.

`scripts/ingestion-runtime/verify-renderers-prod.mts` re-runs the production
check for BOTH supporting renderers (46 assertions, disposable data,
self-cleaning) whenever this needs proving again rather than assuming.

## THE DATABASE IS A LAB NOTEBOOK, NOT A USAGE LOG

Nearly everything in this database exists because the founder was **building and
probing the software** — learning what it could do, where it broke, and what
commercial use would require — with a few genuinely real client FlowGuides
mixed in (which served a real purpose and also taught something).

That makes almost any behavioural inference from this data unsound, not just
counts. What looks like usage is mostly the record of someone testing their own
tool.

**Two specific claims made from it, both retracted:**

- *"67 packets, 46 of them drafts"* — a draft ratio produced by
  experimentation, not by professionals abandoning work.
- *"51 general vs 16 senior-placement, so the product has generalised beyond its
  origin vertical"* — the general-typed packets are largely test material chosen
  to probe the software against different content shapes (a training plan, a
  food test), not evidence of demand outside the origin vertical.

The horizontal public positioning does **not** rest on that second claim and is
unaffected: it was decided on noncompete grounds, which is a constraint rather
than an inference. But the statistic must not be re-used as supporting evidence.

**Also true from 2026-08-24:** the founder is deliberately deleting old test and
unused FlowGuides, so totals are falling for housekeeping reasons. Deletion is
hard and cascades cleanly, so there is no audit trail to reconstruct what an
earlier count included.

**What to reach for instead.** Published-packet counts are steadier. Recipient
`viewed` data is usable only for rows created after 2026-08-19, when owner views
stopped being counted. Neither substitutes for the real thing: **evidence from a
professional who is not the founder.** Until that exists, say "we don't know"
rather than dressing a development artefact as a finding.


## show_quick_nav is presentation, and must stay that way

`packets.show_quick_nav` (0030) is deliberately absent from the column list in
`ingest_bump_packet_self()`, so toggling it does not bump `content_rev` and
cannot disturb ingestion offsets or the block/item bijection. **Do not add it to
that list** — that would reclassify a display preference as content. The
migration header says the same thing at the point someone would change it.

It is also mutable after publish, unlike `professional_snapshot`: the toggle
changes what an already-shared link renders. `scripts/ingestion-runtime/verify-quick-nav.mts`
proves both properties (23 checks, disposable, self-cleaning).

## The public surface is horizontal, deliberately

Nothing public names a vertical. Senior-living data is fine internally; it must
not appear in the landing page, the demo, or anything a stranger can read. The
demo's entities and facts are wholly invented — reserved `555-01xx` numbers and
`.example.com` domains — because the demo it replaced attached invented prices
and staff to four real companies on a live URL.

Public copy says "guide"; `packet` is internal only. `src/lib/public-surface.test.mts`
pins all of it, including that the demo carries no private note.

## One rule decides whether a profile is ready

`src/lib/professional-identity.ts` is the single answer to "is this professional
ready to publish?" — a name, and at least one way to reply. **The publish route
and the dashboard's first-run prompt both call it**, so onboarding cannot tell
someone they are set up while publish refuses them. Changing that rule changes
both at once, which is the point; do not reintroduce a local check in either
place.

`scripts/ingestion-runtime/verify-identity.mts` proves it end to end (26 checks,
disposable, self-cleaning), including that an already-published packet keeps its
snapshot when the profile later changes.

## Paper is verified as paper

`/p/[slug]/print` is the third supporting renderer and carries no flag, table
or migration. What the production check CANNOT prove is pagination — that
needs a real Letter PDF read page by page, which is how the one real defect
(details tables splitting across pages) was found. To re-prove it:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --no-pdf-header-footer --run-all-compositor-stages-before-draw \
  --print-to-pdf=out.pdf https://flowguide-ruddy.vercel.app/p/<slug>/print
```

Needs `poppler` (`brew install poppler`) to read the pages back.

## Verifying the live state rather than assuming it

`scripts/ingestion-runtime/probe-enforcement-state.mts` drives one bounded
disposable import against production and reports what the deployed process
ACTUALLY did — telemetry, scope, counts, permanent failures. Add
`PROBE_DESTINATION=library` for the Library path. A configuration listing says
what someone intended; the probe says what the server does, and the two have
disagreed before.

## The destination guard is the rollout boundary

Enforcement is allowed to act on the packet path only. Library is excluded
because a held review unit there would be cleared by `library_close_import_run`
before anyone saw it, whereas without enforcement a model-placed private note
stays visible to its owner. **Declining preserves content; enforcing without a
surfacing path would delete it.** Extending enforcement to Library requires
building somewhere its held units are shown FIRST.

`ENFORCED_DESTINATIONS` / `KNOWN_DESTINATIONS` are exhaustive and pinned against
0020's check constraint, so a new destination fails the suite rather than
inheriting packet behaviour.

## The silent-loss workstream is CLOSED, and the conclusion is bounded

Recorded exactly as the founder worded it, on 2026-08-25:

> Zero genuine silent omissions were found in the 16-input reliability corpus
> when measured against the persisted recipient-visible FlowGuide.

**Do not restate this as a universal claim that FlowGuide can never lose
information.** It is 16 inputs, measured one way, on one date.

What "measured against the persisted recipient-visible FlowGuide" means: the
published `/p/<slug>` page was fetched as a client would fetch it, and both the
visible text and every `href` were searched — a link's destination is the fact,
and it lives in an attribute rather than in the prose. A positive control ran
first, because "0 missing" is otherwise indistinguishable from a broken metric:
the page renders real content rather than an SSR loading shell, present facts
are found, and fabricated ones are correctly reported absent.

Nine reported misses were all `labelled` claims and all artifacts. The parser
splits on a colon, so `Mon 9:00 — Kickoff, 90 min` becomes label `Mon 9` and
value `00 — Kickoff, 90 min` — a string that never existed in the source. One
was an email `Subject:` header, which belongs in no packet. `4.1k` -> `$4,100`
is canonicalisation, not loss. A follow-up pass checked the CONSTITUENT facts on
the real pages: 49 of 50 present, and the fiftieth was that `$4,100`.

**`03-numbered-prose` counts as CORRECT BEHAVIOUR.** It was held at
`needs_review` — "1 piece of information needs a decision before publishing" —
and publish returned 409. The import was held for a decision rather than
silently published. That is the objective working, not a failure, and it must
not be recorded as one.

**The founder's 2026-08-24 creation failure remains OPEN.** It is neither
resolved nor disproven. The corpus never contained that input, so a clean
corpus is not evidence against it.

**No further reliability expansion** — no detector heuristics, no TSV
investigation, no PDF or image/OCR work, no additional synthetic corpus
building — unless a NEW REAL failure gives a reason. The next input is real use.
If normal creation attempts are stable, the next step is the external
professional sessions.

## A dropped function signature drops its grants

Migration 0031 added `p_delimiter_hint` to `create_organize_run`, which meant
dropping the nine-argument signature and creating a ten-argument one. 0012's
`revoke ... from public, anon, authenticated` was attached to the signature that
no longer existed, and a newly created function is granted `EXECUTE` to `PUBLIC`
by default. The function is `SECURITY DEFINER` and the anon key ships in every
browser, so for about a day anon could execute it as the owner, bypassing RLS.

Fixed by **0032** (grants only, no behaviour change). It was found by probing
rather than by reading: anon reached the function BODY and was stopped only by a
foreign key on `packets.user_id` — a data constraint, not an authorization
control — while its untouched siblings answered "permission denied for
function". **A validation or constraint error means the body RAN.** Only
"permission denied for function" proves a grant is closed.
`scripts/security/verify-0032-grants.mts` encodes that distinction.

## Marketing and recipient link previews are separate, deliberately

A FlowGuide was about to be texted to a client in a sensitive family situation,
and iMessage previewed it as *"Everything you found, in one thing your client
can actually use."* The send was stopped by hand. Fixed 2026-08-25.

**Why it was invisible:** Next.js merges metadata SHALLOWLY. `/p/[slug]` and
`/p/[slug]/print` each set `title`, `description` and `robots` but omitted
`openGraph`, so both inherited the root layout's ENTIRE marketing OpenGraph
block — the promotional description, `/og.png`, and an `og:url` pointing at the
homepage rather than the packet. The routes looked correct and carried a comment
claiming their metadata was "entirely generic". The leak was in what they did
not declare. **Declaring `openGraph` partially would re-inherit the rest.**

`src/lib/recipient-metadata.ts` is the single source for both routes:
title `FlowGuide`, description `Information has been shared with you in
FlowGuide.`, `/og-recipient.png`, `noindex, nofollow`, and no `og:url`.

**It is a CONSTANT, and that is the point.** It takes no packet, no slug and no
arguments, so there is no code path by which a packet title, a client name, a
personal note or a subject matter could reach a preview card. One neutral image
serves every recipient link. **Do not build per-packet OG images** — a generated
card leaks private content into unfurl caches FlowGuide does not control and
cannot retract.

Verified on production against a disposable published packet whose title,
client name and note were deliberately sensitive, fetched with the user agents
that actually generate previews — Apple Messages (`facebookexternalhit/1.1
Facebot Twitterbot/1.0`), Slack, WhatsApp, Discord, Signal. All five: neutral
card, no leak, no marketing. The homepage keeps its marketing card.

The OG image is a static PNG. `docs/og-recipient-source.html` is the HTML it was
rendered from at 1200x630, so it can be regenerated rather than reverse-engineered.

## Known limitation, deliberately not fixed

**Six "shared blind spots"** in the senior-living corpus: a bare unlabelled
value alone on its own line — e.g. a phone number with no label and no
surrounding sentence. Every ingestion strategy tested missed them, chunked and
whole-source alike, in every repetition. This is a PROMPT gap, not a chunking
one.

Not pursued on purpose. It is six facts out of 429 on one corpus, and the fix
would mean prompt wording about unlabelled values, which is the kind of change
that has repeatedly produced side effects elsewhere. **Revisit only if real
usage shows it costs someone something.**

## What is measured but not shipped

The lossless block is on `organizeLeadPrompt` and `sectionsPrompt` only.
`itemsOnlyPrompt` — which serves `section_append` AND `library_import` — is
untouched and was never measured. A source gate enforces that split.

## Where the evidence lives

`scripts/experiments/context-aware/` — ten preserved run directories, 174 raw
transcripts, including the invalid and contaminated runs. `README.md` there
records what each run proved and what it did not. Do not rewrite those
conclusions to match later findings; the wrong turns are the useful part.
