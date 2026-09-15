# 0054 — publication backfill

**Written and tested; not applied. No production publication rows written.**

Sendsets published before the publish route switched to `publish_packet` have no
`packet_publications` row. 0054 adds the one narrow door that stores a frozen
copy for them; the copy itself is built by `scripts/publication-backfill/` with
the same builder publish uses, and must equal what the live page renders today.

## The functions (service_role only, SECURITY DEFINER, empty search_path)

- `packet_backfill_token(packet)` — in one statement, every input the live page
  depends on beyond `draft_rev`: status, `published_at` (exact epoch text),
  `draft_rev`, `identity_mode`, `professional_snapshot`, and — only when that
  snapshot is SQL NULL or JSON null, so the page shows the live profile — profile
  existence and `identity_rev`; plus `has_publication`.
- `backfill_packet_publication(packet, expected token, format, content)` — lock
  the Sendset `FOR UPDATE`; refuse `PT404 not_found`, `PT409 not_published`
  (not published, or no `published_at`), `PT409 publication_exists`; recompute
  the token, refuse `PT409 changed`; validate with `publish_packet`'s block
  (`PT400 invalid_snapshot`); insert one row. Returns the SHA-256 of the stored
  jsonb text for the manifest.

The row: `published_at` = the Sendset's own; `source_draft_rev` = its
`draft_rev`; `identity_dependency` from `identity_mode` (as publish derives it);
`source_identity_rev` = the profile's `identity_rev` only when the card came from
the live profile, otherwise NULL ("may differ").

Never: a packets write of any kind (status, `published_at`,
`professional_snapshot`), `set_config` of the publication flag, publish gates,
`ON CONFLICT`, or touching an existing publication.

**Parity.** The validation block is copied verbatim from `publish_packet`, minus
its identity-snapshot check (a backfill takes no identity snapshot) and with the
message prefix `backfill:`. The migration aborts unless the block equals the one
in the INSTALLED `publish_packet`; `publication-backfill.test` checks the files.

## The script

`node --env-file=.env.local --import tsx scripts/publication-backfill/cli.mts`
is a dry run. `--apply --manifest <new file>` stores, one Sendset at a time:
token first → build → refuse unless equal to `getPublishedPacket` by value →
RPC with that token → read back and compare by value. Each stored row is written
to the manifest immediately; the run stops on a row it cannot verify.
Comparisons use `canonicalJson` (key order ignored), never bytes.

## Rollback

- Functions: `supabase/rollbacks/0054_publication_backfill_down.sql` drops both;
  touches no row.
- Rows: `cli.mts rollback-sql <manifest>` prints SQL (run as postgres) that
  deletes a manifest row only while its stored digest AND `published_at` still
  match to the microsecond, so a republished Sendset keeps its publication.
  Before the reader switch this affects no recipient; after it, the reader switch
  must be rolled back first.

## Verification

- In the migration: preconditions (0050 table, 0052 `publish_packet`, 0053
  door), catalog assertions (definer, search_path, grants, parity with installed
  `publish_packet`, no existing row changed) and a rolled-back proof.
- `node --import tsx scripts/pg-harness/test-0054.mjs` — 148 checks on real
  PostgreSQL 17: seven Sendset kinds, refusals with nothing written, parity with
  `publish_packet` and 0053 still refusing, grants, key-order-independent digest
  and manifest rollback, nine two-connection interleavings, rerun/rollback/
  re-apply/preconditions, 17 mutants.
- `src/lib/publication-backfill.test.mts` — 19 tests of the script against an
  in-memory database and the source rules; 12 mutants of the script, CLI and
  migration are all caught.
