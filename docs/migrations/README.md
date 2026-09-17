# How a migration reaches production

The standard path, written down after 0050 (2026-09-15). Every step is either
read-only or explicitly approved; nothing here is automatic, and nothing in CI
applies migrations.

## The tools

- The Supabase CLI is a devDependency: `node_modules/.bin/supabase`.
- The project is linked (`supabase/.temp/`, gitignored) to the same project as
  `.env.local`. Authentication is the CLI access token in the macOS keychain.
  No database password or `DATABASE_URL` is stored, and none is needed.
- `supabase db query --linked -f <file>` runs **one SQL file** through the
  Management API as `postgres` (not a superuser — the same role as the SQL
  Editor). Explicit `begin`/`commit`, `do` blocks, savepoints and
  `temp … on commit drop` all work. A `raise` comes back as an HTTP 400 error.
  `NOTICE`s are **not** returned, and the CLI's exit status is unreliable through
  a pipe — judge success by the output.

## The sequence

### 1. Verify the migration before anyone applies it

- Execute it in disposable Postgres (PGlite in a scratch directory), against a
  fixture rebuilt from the real DDL, with Supabase's roles and default grants and
  a control that proves privilege checks are not vacuous.
- Mutate the migration (drop a revoke, a column, a constraint) and confirm each
  mutant aborts. A proof that cannot fail proves nothing.
- Catalog facts (RLS, policies, grants, FK delete rules) belong in assertions
  **inside** the migration's own transaction, so a violation rolls it back.
- Commit the migration and its rollback (`supabase/rollbacks/`) and record the
  file's SHA-256.

### 2. Baseline

Immediately before applying, capture read-only:

- `shasum -a 256` of the exact file — it must equal the reviewed hash;
- row counts and digests of every table the migration could touch
  (`id|updated_at|<revision columns>`), through PostgREST;
- the preconditions the migration expects (objects absent, no in-flight runs);
- `supabase migration list --linked` — Local and Remote must already match up to
  the previous version.

A post-apply comparison is only meaningful against a pre-apply snapshot, and one
cannot be taken retroactively.

### 3. Apply the exact reviewed file

```bash
node_modules/.bin/supabase db query --linked -f supabase/migrations/NNNN_name.sql
```

Run it **once**. Any error: stop and report. Do not retry and do not edit the
SQL — an aborted migration rolled back completely, and a changed file is a
different, unreviewed migration.

### 4. Verify production

- Re-run the baseline: counts and digests must match exactly where the migration
  promised not to write.
- Read-only catalog query for everything the migration created or changed
  (columns, constraints, triggers, function source md5, grants, RLS).
- Confirm no probe rows from the migration's own proof survived.

### 5. Record it in the migration history

`db query` does **not** write `supabase_migrations.schema_migrations`. Record the
version as soon as step 4 passes, or the history silently falls behind:

```bash
node_modules/.bin/supabase migration repair --status applied NNNN --linked
```

`repair` writes history rows only — no schema, no data.

### 6. Confirm alignment

```bash
node_modules/.bin/supabase migration list --linked
```

Local and Remote must match for every version.

### 7. Before any future `db push`, dry-run first

```bash
node_modules/.bin/supabase db push --dry-run --linked
```

It must report `Remote database is up to date` (or list exactly the migrations
you intend to push). A real `db push` applies **every** local version missing
from Remote, in order — never run one without this check.

## History notes

- **2026-09-15 reconciliation.** History had stopped at 0038 while 0039–0049 were
  live (applied through the SQL Editor). They were recorded with
  `migration repair` after production evidence was checked for each.
- **0040 and 0041 are recorded as state-satisfied, not proven executions.** Their
  data effects are no longer observable: both read `library_items.category`,
  which 0042 dropped, so neither can run again, and current production satisfies
  their postconditions. Every other version from 0039 to 0050 was established
  from direct catalog evidence or from a later migration's md5 guard on it.

- **0051–0054 (2026-09-15)** were applied with this process and recorded one at a
  time; `migration list` matches through 0054. 0054's first attempt stopped at the
  baseline step during Supabase scheduled maintenance (503) and was resumed from
  step 1 afterwards.

- **0058 (2026-09-17)** applied with this process before its app half deployed;
  baseline was a full-row digest of every public table. See
  [0058-sendset-responses.md](0058-sendset-responses.md).

## Fallback: the SQL Editor

If the CLI path is unavailable, paste the exact file into the Supabase SQL
Editor. It warns about `CREATE TABLE` without RLS when a migration uses
`create temp table … on commit drop`; choose **Run without RLS** (the migration
enables RLS on its real tables itself). Never choose "Run and enable RLS" — it
appends a statement after `COMMIT`. Steps 2 and 4–7 still apply.
