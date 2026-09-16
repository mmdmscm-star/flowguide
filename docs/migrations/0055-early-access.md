# 0055 — early access: invite codes

**Written and tested; not applied. No app change deployed.**

A new Sendset account needs a single-use invite code. Sign-in for existing
accounts is untouched, and the homepage, demos and published Sendsets stay
public.

## Objects

- `public.invite_codes` — `code_hash` (SHA-256 of the normalised code, unique),
  `label`, `created_at`, `revoked_at`, `used_at`, `used_by`. CHECKs: the hash is
  64 hex characters, a label is present, a code is never both used and revoked,
  and `used_by` only exists once used.
- `public.early_access_requests` — `name`, `email`, `use_case`, `created_at`,
  with the same length and shape limits the form states. Purged after 90 days by
  the `sendset-purge-early-access-requests` pg_cron job.
- `public.redeem_invite(magic token, code hash)` — SECURITY DEFINER,
  service_role only. Locks the magic link (`PT401 link_invalid` when used or
  expired); signs in an email that already has an account without looking at the
  code; locks the invite (`PT403 invite_invalid` for unknown, used, revoked or
  malformed alike); creates the user and its empty profile, marks the invite used
  by that user, and marks the link used — all in one transaction.

**Grants:** nothing for `anon`/`authenticated`. service_role may read both
tables, insert an invite's hash and label, set `revoked_at`, insert and delete
requests, and execute `redeem_invite`. It cannot mark an invite used except
through the function, and cannot delete invites.

## The app half (branch `early-access`)

`/api/auth/verify` no longer creates accounts. A verified link for an unknown
email leaves the link unused, extends it to 30 minutes (never beyond an hour
after it was sent), sets the httpOnly `flowguide_signup` cookie and redirects to
`/join`. `/api/auth/redeem-invite` reads that cookie, normalises and hashes the
code from the request body, calls `redeem_invite` and starts the session.
`/early-access` stores one request row, then best-effort notifies the owner.

## One row per email

The request form is idempotent for review: a new submission is inserted, then
earlier rows for the same address are deleted, so the newest answer is the one
on file. The table has no unique index and the service role cannot UPDATE it, so
this is done in `storeEarlyAccessRequest` — insert first, tidy after, so a
failure leaves a request rather than none. Past the daily limit nothing is
written and the person is told the ordinary thing: their request is on file.

## Using it

```bash
node --env-file=.env.local --import tsx scripts/invites/invites.mts create "Jane Doe (jane@example.com)"
node --env-file=.env.local --import tsx scripts/invites/invites.mts list
node --env-file=.env.local --import tsx scripts/invites/invites.mts revoke <id>
node --env-file=.env.local --import tsx scripts/invites/invites.mts requests 30
```

`create` prints the code once; it is stored only as a hash and cannot be
recovered. Revoking works only on an unused code.

## Verification

- In the migration: preconditions, catalog assertions (no anon/authenticated
  access, service_role cannot mark an invite used, definer function, RLS, the
  90-day job, no existing row changed) and a rolled-back behavioural proof.
- `node scripts/pg-harness/test-0055.mjs` — 73 checks on real PostgreSQL 17:
  grants and constraints, the purge, redemption and every refusal, a failed
  signup not burning a code, six two-connection races, rerun/rollback/re-apply,
  and 12 mutants.
- `src/lib/early-access.test.mts` and `src/lib/signup-forms-dom.test.mts` — 20
  tests covering the code helpers, the request form, the source rules that keep
  redemption the only door, and both forms in a DOM. 17 mutants of the app code
  are caught.

## Rollback

`supabase/rollbacks/0055_early_access_down.sql` drops the job, the function and
both tables — deleting every invite and request, keeping accounts. It refuses
while any unused, unrevoked invite exists. Revert the app change first, or
nothing can create an account.
