#!/usr/bin/env python3
"""Parse every .sql file we hand to Supabase, using the REAL PostgreSQL grammar.

Exists because the 0025 preflight shipped with `check` as a bare column alias.
`check` is fully reserved: PostgreSQL accepts it as a column label after AS and
then rejects it in the outer select list, so the script parsed most of the way
and died on its last statement — a failure no amount of reading catches
reliably, and one a parser catches instantly.

    pip3 install pglast && python3 scripts/sql/parse-check.py

WHAT THIS DOES NOT COVER. libpg_query parses SQL. A plpgsql function body is a
dollar-quoted string literal to it, so `create function ... $$ begin ... end $$`
proves the envelope is well formed and says NOTHING about the body. Bodies
re-issued from already-applied migrations are proven by having run; genuinely
new plpgsql is not proven by this script.
"""
import sys, glob, pglast

TARGETS = sorted(glob.glob("scripts/sql/*.sql")) + sorted(glob.glob("supabase/migrations/*.sql"))
WRITE_KINDS = {"InsertStmt", "UpdateStmt", "DeleteStmt", "AlterTableStmt",
               "CreateStmt", "CreateFunctionStmt", "DropStmt", "TruncateStmt"}
bad = 0
for f in TARGETS:
    src = open(f).read()
    try:
        stmts = pglast.parse_sql(src)
    except Exception as e:
        print(f"FAIL  {f}\n        {e}")
        bad += 1
        continue
    kinds = sorted({type(s.stmt).__name__ for s in stmts})
    # A preflight must be read-only. This is the property, not a naming habit.
    if f.startswith("scripts/sql/") and "preflight" in f:
        writes = [k for k in kinds if k in WRITE_KINDS]
        if writes:
            print(f"FAIL  {f}\n        preflight is not read-only: {', '.join(writes)}")
            bad += 1
            continue
        print(f"ok    {f}  ({len(stmts)} stmt, read-only)")
    else:
        print(f"ok    {f}  ({len(stmts)} stmt: {', '.join(kinds)})")
sys.exit(1 if bad else 0)
