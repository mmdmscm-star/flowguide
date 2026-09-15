# 0052 — atomic publication

**Applied 2026-09-15.** The publish route now uses it (route switch); readers still
render live rows, and there is no single-door trigger (0053) or backfill (0054) yet.

## What it adds

- `packet_publish_token(owner, packet)` — one statement: status, `draft_rev`,
  identity dependency (plus profile existence and `identity_rev` only for
  `default` identity), blocking import, title present, and a SHA-256 over every
  column `loadPacketOwnership` selects (raw_input; items' id, section, title,
  origin columns; photos; source runs' provenance; their chunks; media
  decisions). SECURITY DEFINER, service_role only.
- `publish_packet(owner, packet, expected_token, format_version, content,
  professional_snapshot)` — locks the Sendset, recomputes the token, refuses on
  any difference, validates the snapshot (slug; every section/item/block id
  belongs to this Sendset; format 1; recipient-safe per 0050's CHECKs), then
  upserts the publication and sets `status`, `published_at` (every successful
  publish) and `professional_snapshot` in one transaction, under the
  `app.publication_authorized_packet` flag 0053 will enforce.
  Errors: `PT404 not_found`, `PT409 changed`, `PT409 import_blocks`,
  `PT400 title_required`, `PT400 invalid_snapshot` (code + DETAIL).
  Route message for `changed`: "This Sendset changed while publishing. Try again."
- `unpublish_packet(owner, packet)` — deletes the publication, sets draft.
- Lock-only BEFORE row triggers taking `FOR SHARE` on Sendset rows in id order:
  `item_media_decisions` (OLD and NEW owners), `professional_profiles` (every
  Sendset of the owner).

## Differences from the design

1. **The token is SECURITY DEFINER, not invoker.** It calls
   `packet_has_blocking_run`, which 0051 made executable by its owner only, so an
   invoker token refused service_role. Found by the harness (the migration's own
   proof runs as `postgres` and could not see it). Still service_role-only and
   owner-filtered; a mutant back to invoker aborts the migration.
2. **Snapshot validation also checks section and block ids**, not only item ids.
3. **"Write before comparing" is enforced by a source test, not a behavioural
   one.** Inside one transaction a refusal rolls back any earlier write, so it
   cannot be observed; `ownership-route.test` asserts in the function body that
   the lock, recomputation and comparison precede every write.
4. **`ownership-route.test`'s migration scan now states the principle**: only
   `publish_packet` may assign `status = 'published'`, only after lock →
   recompute → compare, and only service_role may execute it.

## Verification (before applying)

- `node scripts/pg-harness/test-0052.mjs` — 90 checks on real PostgreSQL 17:
  token determinism, owner scoping and sensitivity to every input (17);
  publish/republish/unpublish including custom identity, no profile and block
  composition (10); eleven refusal modes each leaving the live publication
  byte-for-byte (11); grants and cascades (12); **21 two-connection
  interleavings** — Keep and undo-Keep vs publish in both orders, a control
  without the trigger showing the race, Keep moved between Sendsets (OLD and NEW
  owners), profile update and first insert in both orders, custom→default switch,
  custom Sendsets included in profile locking, active chunk mutation, publish vs
  unpublish both ways, content edited after the token and in flight, two tabs
  republishing, an import starting during publish; rollback (5); 14 mutants.
- `src/lib/publish-token.test.mts` — every column the ownership check selects is
  hashed, scoped to this Sendset.
- `src/lib/ownership-route.test.mts` — the one allowed door and its ordering.
- 10 mutants of the source tests, all caught.

## Deployment sequence

1. Apply 0052 (process in `README.md`). Inert until the route uses it.
2. Route: token → gates → snapshot builder (shared with `getPublishedPacket`,
   with an equivalence test) → `publish_packet` / `unpublish_packet`; route
   source tests updated.
3. 0053: the single-door status trigger.
4. 0054: `backfill_packet_publication`, then the backfill run.
5. Reader switch; then the status ⇔ publication invariant; then loosening the
   draft-only edit guards.

## Route switch

`POST /api/packets/:id/publish` now: reads `packet_publish_token` → runs every
existing gate in its original order with its original responses (import gate,
title, structure, identity readiness, ownership with 503/decline/blocking) →
builds the snapshot with `buildPublicationSnapshot` (the same assembly as
`getPublishedPacket`, reading strictly) → calls `publish_packet`. Refusals map
to: `changed` → 409 "This Sendset changed while publishing. Try again.";
`import_blocks` → the import gate's own response; `title_required` → the
existing 400; `PT404` → 404; anything else → 500 `publish_failed`, logged.
Unpublish calls `unpublish_packet`. No TypeScript writes a packet status.

Before deploying, for every published Sendset in production (read-only): the
snapshot passed publish_packet's validation rules (32/32), and equalled the live
render for all 23 with a stored identity snapshot (the other 9 predate snapshots
and render the live profile).
