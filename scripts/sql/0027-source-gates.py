#!/usr/bin/env python3
"""0027 source gates — invariants provable from the migration text alone.

These run BEFORE the migration is applied, so they cannot touch the database at
all. They catch the class of mistake that a post-apply verifier would only find
after the change is already live: a missing revoke, an unqualified object name
under `search_path = ''`, a mutation reaching a table it has no business
touching.

SELF-REFERENCE: every "must NOT appear" gate scans code with `--` comments
STRIPPED. The prose explaining why a thing is forbidden contains the forbidden
words, and a gate that matched its own rationale would fail forever — and the
fix for that is to narrow the scan, never to loosen the pattern.
"""
import io, re, sys

SRC = "supabase/migrations/0027_resolve_review_unit.sql"
raw = io.open(SRC, encoding="utf-8").read()
code = "\n".join(re.sub(r"--.*$", "", ln) for ln in raw.splitlines())

rows, failed = [], 0

def gate(name, ok, detail=""):
    global failed
    rows.append(("PASS" if ok else "FAIL", name, detail))
    if not ok: failed += 1

# ---- security -------------------------------------------------------------
gate("SECURITY DEFINER declared", re.search(r"\bsecurity\s+definer\b", code, re.I) is not None)
gate("search_path pinned to empty", re.search(r"set\s+search_path\s*=\s*''", code, re.I) is not None)

# Under search_path='' every object reference must carry its schema or the
# function fails at runtime — a check the SQL parser will not make for us.
bare = [m.group(0) for m in re.finditer(r"(?<!\.)\bingestion_runs\b", code)
        if not re.search(r"public\.$", code[:m.start()])]
gate("every ingestion_runs reference is schema-qualified", not bare,
     f"{len(bare)} bare reference(s)")

gate("EXECUTE revoked from PUBLIC explicitly",
     re.search(r"revoke\s+all\s+on\s+function\s+public\.resolve_review_unit\([^)]*\)\s*from\s+public\s*;", code, re.I) is not None)
gate("EXECUTE revoked from anon and authenticated",
     re.search(r"revoke\s+all\s+on\s+function\s+public\.resolve_review_unit\([^)]*\)\s*from\s+anon\s*,\s*authenticated\s*;", code, re.I) is not None)
gate("EXECUTE granted to service_role only",
     re.search(r"grant\s+execute\s+on\s+function\s+public\.resolve_review_unit\([^)]*\)\s*to\s+service_role\s*;", code, re.I) is not None)
grants_to = re.findall(r"grant\s+[^;]*?\bto\s+([a-z_, ]+);", code, re.I)
bad_grant = [g for g in grants_to if re.search(r"\b(anon|authenticated|public)\b", g, re.I)]
gate("nothing is granted to anon/authenticated/PUBLIC", not bad_grant, str(bad_grant))
gate("caller's ownership of the run is verified",
     re.search(r"v_run\.user_id\s*<>\s*p_owner", code) is not None)

# ---- mutation contract ----------------------------------------------------
gate("p_status restricted to resolved|ignored",
     re.search(r"p_status\s+not\s+in\s*\(\s*'resolved'\s*,\s*'ignored'\s*\)", code, re.I) is not None)
gate("run must be in needs_review",
     re.search(r"v_run\.status\s*<>\s*'needs_review'", code) is not None)
gate("row locked FOR UPDATE before read-modify-write",
     re.search(r"select\s+\*\s+into\s+v_run\s+from\s+public\.ingestion_runs[^;]*for\s+update", code, re.I|re.S) is not None)
gate("zero matches raises not-found", re.search(r"v_matches\s*=\s*0", code) is not None)
gate("duplicate unit ids fail rather than mutate one of them",
     re.search(r"v_matches\s*>\s*1", code) is not None
     and re.search(r"if\s+v_matches\s*>\s*1\s+then\s*\n\s*raise\s+exception", code, re.I) is not None)
gate("units addressed by stable id, never array position",
     re.search(r"f->>'id'\s*=\s*p_unit_id", code) is not None
     and not re.search(r"failures\s*->\s*\d", code))
gate("stale/already-handled unit is idempotent, not overwritten",
     re.search(r"coalesce\(v_unit->>'status',\s*'unresolved'\)\s*<>\s*'unresolved'", code) is not None
     and re.search(r"'changed',\s*false", code) is not None)

# Legacy rows written before `status` existed have no such key. Counting them
# with a bare `f->>'status' = 'unresolved'` would read NULL, exclude them, and
# finalize a run that still has unresolved work in it.
unresolved_tests = re.findall(r"[^\n]*->>'status'[^\n]*'unresolved'[^\n]*", code)
gate("every unresolved test defaults a missing status to 'unresolved'",
     bool(unresolved_tests) and all("coalesce(" in t for t in unresolved_tests),
     f"{len(unresolved_tests)} test(s)")
gate("unrelated units pass through untouched",
     re.search(r"else\s+f\s+end", code) is not None)
gate("unrelated review keys preserved (jsonb_set, not replacement)",
     re.search(r"jsonb_set\(v_review,\s*'\{failures\}'", code) is not None)
gate("failure array order preserved", re.search(r"order\s+by\s+ord", code, re.I) is not None)

# ---- last-unit transition -------------------------------------------------
gate("transition happens only at zero remaining",
     re.search(r"if\s+v_remaining\s*=\s*0\s+then", code, re.I) is not None)
# Scope to the zero-remaining BRANCH only. Slicing from the first mention of
# `v_remaining = 0` swept in the else-branch and the return expression too, and
# then "one UPDATE" counted three statements across two branches. Narrow the
# scan; do not relax the assertion.
_b = code.find("if v_remaining = 0 then")
tail = code[_b:code.find("\n  else", _b)]
gate("terminal status is finalized", re.search(r"status\s*=\s*'finalized'", tail) is not None)
gate("finalized_at stamped without clobbering an earlier one",
     re.search(r"finalized_at\s*=\s*coalesce\(finalized_at,\s*now\(\)\)", tail) is not None)
gate("review.ok flipped true in the same statement",
     re.search(r"'ok',\s*true", tail) is not None)
gate("stale failure summary cleared so the JSON cannot contradict the status",
     re.search(r"'summary',\s*''", tail) is not None)
gate("status and review move in one UPDATE",
     len(re.findall(r"update\s+public\.ingestion_runs", tail, re.I)) == 1)

# ---- retention & blast radius --------------------------------------------
gate("verbatim text removed on resolve/ignore", re.search(r"\(\s*f\s*-\s*'text'\s*\)", code) is not None)
gate("audit metadata and timestamp retained",
     re.search(r"'status',\s*p_status", code) is not None
     and re.search(r"'resolved_at',\s*to_jsonb\(now\(\)\)", code) is not None)
touched = set(m.group(1).lower() for m in
              re.finditer(r"(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?([a-z_]+)", code, re.I))
gate("mutates ingestion_runs and nothing else — no packet or item content",
     touched == {"ingestion_runs"}, f"touches {sorted(touched)}")
gate("wrapped in an explicit transaction",
     code.lower().strip().startswith("begin;") and code.lower().rstrip().endswith("commit;"))

w = max(len(r[1]) for r in rows)
for res, name, detail in rows:
    print(f"{res}  {name.ljust(w)}  {detail}")
print(f"\n{sum(1 for r in rows if r[0]=='PASS')} PASS / {failed} FAIL  over {len(rows)} source gates")
sys.exit(1 if failed else 0)
