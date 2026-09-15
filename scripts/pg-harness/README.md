# Local PostgreSQL harness

A disposable PostgreSQL 17 for testing migrations and genuine multi-connection
interleavings — the things PGlite (one backend) cannot show.

**It never touches production.** The server listens only on a Unix socket inside
`~/.sendset-pg-harness` (TCP is disabled), trusts local connections, and every
script connects to that socket. Nothing here reads `.env.local`.

## One-time setup

```bash
brew install postgresql@17
scripts/pg-harness/harness.sh init
npm install --prefix scripts/pg-harness
```

No Homebrew background service is used (`brew services` stays untouched).

## Start / stop

```bash
scripts/pg-harness/harness.sh start
scripts/pg-harness/harness.sh stop
scripts/pg-harness/harness.sh status
scripts/pg-harness/harness.sh psql -d <database>
```

## Rebuild the schema

```bash
scripts/pg-harness/harness.sh replay pre0051 0050
```

Creates database `pre0051` from `supabase/schema.sql` (which covers migrations
through 0012), a small invented seed (`seed.sql` — 0049's own proof needs a
real packet), then every migration from 0013 to the version given, as written.

Two platform-only statements are stubbed (`platform-stubs.sql`): `pg_cron` (0024
schedules the evidence purge) and Supabase `storage` (0029 registers the photo
bucket). Supabase's roles and default grants are recreated, so privilege checks
have something to fail on.

**Fidelity, measured against production on 2026-09-15:** constraints, indexes,
triggers, policies, table ACLs/RLS and the table count match exactly, as do the
definitions 0051 replaces. Known differences, all pre-dating this harness:
`items.address`, `packets.map_url` and `packets.raw_input` are nullable in
production, and nine 0006/0007-era block-editor functions have slightly
different source text there.

## Tests

```bash
scripts/pg-harness/harness.sh replay pre0051 0050 && node scripts/pg-harness/test-0051.mjs
scripts/pg-harness/harness.sh replay pre0052 0051 && node scripts/pg-harness/test-0052.mjs
scripts/pg-harness/harness.sh replay pre0053 0052 && node scripts/pg-harness/test-0053.mjs
scripts/pg-harness/harness.sh replay pre0054 0053 && node --import tsx scripts/pg-harness/test-0054.mjs
scripts/pg-harness/harness.sh replay pre0055 0054 && node scripts/pg-harness/test-0055.mjs
```

Each test file clones its template (the schema just before that migration),
applies the migration, and checks behaviour, real two-connection interleavings
(`pg_stat_activity` shows the waiting lock), the rollback, and mutants of the
migration. A mutant counts as caught if the migration aborts on it or a targeted
harness check observes the defect. Test databases are dropped afterwards.

## Remove everything

```bash
scripts/pg-harness/harness.sh remove        # stops the server, deletes ~/.sendset-pg-harness
rm -rf scripts/pg-harness/node_modules
brew uninstall postgresql@17                 # optional
```
