# 0059 — item actions, held by a capability

**Applied to production 2026-09-17. No app change deployed yet.**

0058 stored correspondence. 0059 adds preference: a heart, which the person who
gave it can take back. The two shapes are explicit and the database refuses
every mixture.

## Objects

- `sendset_responses.kind` — `message` (0058 exactly: immutable, no capability,
  its own publication marker, notified) or `actions` (mutable, a capability, a
  required signature, no submission-level marker, never notified).
- `sendset_responses.session_hash bytea` — SHA-256 of a 256-bit capability.
  **The server generates the raw token; it reaches the browser only as an
  HttpOnly, Secure cookie scoped to `/p/<slug>`; JavaScript never receives or
  reads it; it never appears in JSON, logs, URLs or PostgreSQL. PostgreSQL gets
  the 32-byte hash only.**
- `sendset_responses.updated_at` — null for a message; moves on every addition
  and every withdrawal for an action session.
- `sendset_response_lines.parent_kind` + composite FK to `(id, kind)` — a like
  can only hang under an action session, a respond only under a message.
- Per-line `live_publication_published_at` / `rendered_publication_was_current`
  — staleness belongs to the line once lines are independently timed.
- `sendset_action_rate` — the only activity state: ONE row per Sendset,
  overwritten in place, self-erasing. No event rows, no identifiers.
- `set_sendset_item_action`, `clear_sendset_item_action`,
  `read_sendset_session_actions`, `sendset_publication_item`. Service role only.

## The rules that are structural rather than remembered

- **One target per call.** There is no "replace my lines" parameter, so a client
  that cannot render a tombstoned line cannot delete it by omission.
- **A removed item.** `set` refuses it (`PT409 target_absent`); the line stays,
  labelled from its frozen tombstone; `clear` still works.
- **Like switched off stops new expression, not withdrawal.** `clear` and `read`
  never read `response_actions` at all — the independence is structural, and the
  harness mutates the dependency back in to prove the difference is real.

## Limits

| Limit | Value | Measured from | Exactness |
|---|---|---|---|
| Mint / Sendset / hour | 200 | the durable rows it creates | exact (row lock) |
| Mint / global / hour | 2,000 | same | approximate |
| Mutations / capability / hour | 100 | two columns on the submission, overwritten | exact |
| Mutations / Sendset / hour | 2,000 | one counter row, overwritten | exact |
| Mutations / global / hour | 10,000 | the sum of those counters | approximate |
| Reads | none | — | **deliberately not enforced** |

Reads are unmetered because metering them means storing activity.

## Verification (2026-09-17)

- File SHA-256 `91593a22f6a2b8c024da146e8eeb7233066d8feb9d72e9baf711438bd1518989`
  = reviewed; harness `scripts/pg-harness/test-0059.mjs` 139 pass, 0 fail, with
  11 aborting mutants and 9 behavioural ones.
- Applied once with `db query --linked -f`; no error.
- Baseline before/after: every public table's row count and full-row digest
  identical (new columns excluded). The one real response and its line are
  **byte-for-byte identical** by explicit-column digest, `7f5baddf…`.
- After: 1 message, 0 action sessions, 0 capabilities, 0 like lines, 0 counter
  rows, 0 Sendsets with Like enabled, no proof rows left behind.
- Catalog query (columns, constraints, indexes, RLS, policies, grants, function
  source md5 and ACLs) — 68 rows, **identical** to a local replay of 0013..0059.
- `migration repair --status applied 0059`; `migration list` matches all 58
  versions; `db push --dry-run` reports up to date.

## Deploy order

Safe to be live before the app half: no action session can exist until the new
endpoints ship, so the deployed application — which only reads message rows — is
unaffected by the columns becoming nullable. **The app change that must ship
with the endpoints:** `loadOwnerResponses` feeds
`rendered_publication_was_current` into `stalenessLabel`, and a null would read
as false, labelling every action session as sent from an earlier version. It has
to branch on `kind`.

## Rollback

`supabase/rollbacks/0059_sendset_item_actions_down.sql`. Refuses while any action
session or like line exists, and while any Sendset still accepts `like`. Lossless
for correspondence otherwise — proved by comparing the digest across the drop.
