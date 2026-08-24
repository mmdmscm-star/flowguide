# Production state — as of 2026-08-22

One page, so a later session does not have to reconstruct this from commit
messages. Everything here is live unless it says otherwise.

## What is on

| | state | rollback |
| --- | --- | --- |
| Packet semantic enforcement | **ON** — `FLOWGUIDE_ENFORCE_CONTRACT=1` in the Vercel Production environment | `vercel env rm FLOWGUIDE_ENFORCE_CONTRACT production`, then redeploy |
| Library semantic enforcement | **OFF by design** — destination guard inside `enforceChunkResult`, not the flag | n/a; see the limitation below |
| Lossless block in the organize prompts | **LIVE** — commit `fd62712` | `git revert fd62712`, then redeploy |
| Creator photo upload | **LIVE** — bucket `packet-photos` (0029) + `POST /api/packets/[id]/photos` | see below; two independent steps |
| Migrations | `0001`–`0029` applied; local and remote in sync | per-migration; none pending |

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
