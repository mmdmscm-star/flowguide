# Persisted creator-visible unresolved source units — design

*Design only. Nothing implemented. Enforcement remains OFF.*

## The substrate already exists

I looked before designing, and 0013 built this for the same reason:

> `needs_review` is a NON-TERMINAL state entered on an OBJECTIVE accounting
> failure … "the content was applied, but it provably does not match the source."

That is our case exactly. Four pieces are already in place:

| piece | what it does today | fits? |
|---|---|---|
| `ingestion_runs.review` jsonb | `{ok, summary, failures:[{code, url, offset, itemIds}]}` — per-failure, with a **source offset** and the **items** it concerns | **yes**, with two fields added |
| `needs_review` run status | non-terminal; holds the one-active-run slot | yes |
| `block_publish_during_ingest()` (0013) | a run in `needs_review` **blocks publishing** | yes |
| `ImportProgress.tsx` | already renders a review panel with summary + exit | yes, needs a list |

0013's own comment says the shape is *"structured so the editor can render each
unresolved item WITH the source offset it came from — a professional cannot
adjudicate ownership from a count, only from seeing where the media sat."*
That is the same argument, for prose instead of photos.

**No second review system.** The media-accounting failures and the semantic
unresolved units are the same kind of thing: objective, source-anchored, and
requiring a human decision.

## 1. Persistence — extend the existing shape

`review.failures[]` gains what semantic units need and photos never did:

```jsonc
{
  "code": "privacy_rejected",        // | source_unresolved | attribution_unresolved
  "text": "Why it made the list: …", // the exact source prose, verbatim
  "offset": 4213, "len": 168,        // source span — already the 0013 convention
  "record": 3,                       // envelope index (source record identity)
  "itemIds": ["…"],                  // the packet item, when known
  "status": "unresolved"             // | resolved | ignored
}
```

`text` and `record` are new; `status` is new and is what makes a unit
*actionable* rather than merely reported.

**Lifetime.** `review` lives on `ingestion_runs`, and `purge_ingestion_evidence`
does **not** touch it — verified: 0026's purge clears `source_text`, `error`,
segments, results and ledgers, and never mentions `review`. So unresolved units
outlive the 30-day diagnostic window, exactly as required, while the evidence
they point at expires on schedule. The `offset`/`len` remain meaningful for
provenance even after the source text is purged; the `text` copy is what keeps
the unit actionable.

## 2. Creator-visible — extend, don't build

`ImportProgress` already shows a `needs_review` panel. It gains a list: one row
per unresolved unit, showing the item it belongs to and the source text
verbatim, so the decision is made **in context** rather than from a count.

Wording target: *"FlowGuide organized this item, but there is source information
that needs your decision."*

## 3. Resolution is a human choice

Four actions, none of them automatic:

- **incorporate into Description** — the creator edits; FlowGuide inserts nothing
- **add as a Detail** — creator supplies the label
- **make it a Private Note** — deliberate, and now the *only* way prose becomes private
- **Ignore** — explicit, recorded as `ignored`, never silent

FlowGuide picks none of these to clear an exception. That is the whole point:
the model choosing `notes` and FlowGuide choosing `description` are the same
error wearing different clothes.

## 4. What it blocks

Items **materialize normally** — finalize is unchanged, and other records in the
same import are unaffected. What is held is **publishing**, through the existing
0013 trigger, until every unit is `resolved` or `ignored`.

**Stated plainly:** this is packet-level, not item-level. A packet with one
unresolved item cannot be published. True per-item "complete" state would need a
column on `items` and a migration, and I am not proposing that here — the
existing gate already prevents an item silently appearing fully accounted-for,
which is the property that matters. If you want strict per-item granularity, say
so and it becomes a migration.

## 5. The write path — one open choice

Setting `status` needs a write. Two options:

- **A. Route + service-role, ownership-checked.** No migration. Consistent with
  how the Library review screen saves proposals.
- **B. An RPC** (`set_review_unit_status`), consistent with how *run* mutations
  are done elsewhere. Needs a migration, which would take **0027** and push photo
  normalization to 0028 again.

I lean **A**: it is smaller, and this is a status field on a jsonb the app
already owns, not a lifecycle transition.

## 6. Control test to add

An injected model result that deliberately puts ordinary recipient prose into
`notes`, proving: rejected · not lost · not auto-placed into Description ·
persisted as an unresolved unit on the correct record · still visible after
reload · cleared only by an explicit resolve or ignore.

The live ice-cream run produced `privacyRejected: 0` because the prompt fix
worked, so this path needs a deliberate control rather than a hopeful one.

## Not in this patch

The first-class reusable public narrative/content type. These units are the
honest interim: the content is preserved, attached, visible, and awaiting a
decision — rather than being placed somewhere convenient.
