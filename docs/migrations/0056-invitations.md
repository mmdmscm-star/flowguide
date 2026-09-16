# 0056 — invitations: an approved request is the invite

**Written and tested; not applied. No app change deployed.**

0055 made a new account cost a code the person typed. 0056 keeps that for direct
invitations and removes it from the ordinary path: approving an early-access
request reserves an invite **for that address**, and the invitation email's
button is itself the sign-in link.

Founder: request arrives → **Approve & send invite**.
Requester: invitation email → **Get started** → landing page → **Get started** →
account created and signed in.

## Objects

- `invite_codes.email` — NULL is a 0055 typed code; set means reserved for that
  address, with no code at all (`code_hash` may now be NULL, and a CHECK requires
  one of the two). A partial unique index allows at most one LIVE reservation per
  address.
- `early_access_requests.approved_at`, `.invite_id`, `.invitation_sent_at`, with a
  CHECK that nothing is marked sent before it is approved.
- `consume_link_and_create_account(link, email, invite)` — the account-creation
  body BOTH redemptions share. Callable by nobody: both callers run as owner.
- `redeem_invite(token, code_hash)` — replaced in place (same signature, so its
  grants survive) to call the shared body. Behaviour unchanged.
- `redeem_bound_invite(token)` — claims the invite reserved for the link's own
  address. `PT403 no_invitation` when there is none; if an account appeared while
  it waited on the lock, it signs in rather than refusing.
- `approve_early_access_request(id)` — reserves once and records it. Returns
  `approved`, `already_approved` (same invite, so no second email) or
  `has_account`. `PT404 not_found`.
- `record_invitation_sent(id)` — notes a send; `PT409 not_approved` otherwise.

**Grants:** nothing for anon or authenticated. service_role executes the three
route functions and still has no UPDATE on either table, so approval and
consumption happen only inside them.

## The app half (branch `invitation-flow`)

`/invites` is founder-only (`FOUNDER_EMAILS`, 404 for anyone else, re-checked in
every action). Approve reserves the invite and sends a **7-day** magic link;
ordinary sign-in stays 15 minutes. `/invited?token=…` only READS — no account, no
spent link, no consumed invitation — so a mail scanner's GET costs nothing; the
POST behind **Get started** is what accepts. `/api/auth/verify` tries
`redeem_bound_invite` for unknown addresses, which is what makes an expired
invitation recover through ordinary sign-in. `/join` and typed codes are
untouched.

**Security invariants under test:** the token is never logged (except the
development branch that runs only without a mailer, as sign-in already does),
`/invited` sends `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, GET
is side-effect-free, and no analytics exist anywhere in the app.

## Verification

- In the migration: preconditions, catalog assertions (grants, definer, shared
  body, partial index, no account or link row changed) and a rolled-back proof.
- `node scripts/pg-harness/test-0056.mjs` — 75 checks on real PostgreSQL 17,
  including five two-connection races and 9 mutants.
- `src/lib/invitation.test.mts` (10) and `src/lib/invitation-dom.test.mts` (6),
  with 18 app mutants caught.

## Rollback

`supabase/rollbacks/0056_invitations_down.sql` restores 0055's `redeem_invite`
byte for byte, drops the invitation functions and columns, and refuses while any
reserved invitation is live. Spent reservations keep their row with a random
placeholder hash, so the NOT NULL column can be restored without deleting
history. Revert the app first.
