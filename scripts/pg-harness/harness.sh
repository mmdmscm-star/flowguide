#!/bin/bash
# Disposable local PostgreSQL 17 for migration and concurrency tests.
# NEVER points at production: it only ever talks to a Unix socket inside
# $PGHARNESS_DIR, with TCP disabled. See scripts/pg-harness/README.md.
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
DIR="${PGHARNESS_DIR:-$HOME/.sendset-pg-harness}"
PORT="${PGHARNESS_PORT:-55432}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8

psql_h() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

case "${1:-}" in
  init)
    [ -d "$DIR/data" ] && { echo "already initialised: $DIR/data"; exit 0; }
    mkdir -p "$DIR"
    "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust --encoding=UTF8 --locale=en_US.UTF-8 > "$DIR/initdb.log"
    echo "initialised $DIR/data" ;;
  start)
    "$PGBIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" \
      -o "-p $PORT -k $DIR -c listen_addresses=''" start ;;
  stop)
    "$PGBIN/pg_ctl" -D "$DIR/data" stop -m fast ;;
  status)
    "$PGBIN/pg_ctl" -D "$DIR/data" status ;;
  remove)
    "$PGBIN/pg_ctl" -D "$DIR/data" stop -m fast 2>/dev/null || true
    rm -rf "$DIR"
    echo "removed $DIR" ;;
  psql)
    shift; psql_h "$@" ;;
  replay)
    # replay <database> <last-version>: a fresh database holding schema.sql
    # (which covers through 0012) plus every migration from 0013 up to and
    # including <last-version>, applied exactly as written except for the two
    # platform-only statements listed below.
    db="${2:?database name}"; last="${3:?last migration version, e.g. 0050}"
    psql_h -c "drop database if exists \"$db\"" -c "create database \"$db\""
    psql_h -d "$db" -f "$ROOT/scripts/pg-harness/platform-stubs.sql"
    psql_h -d "$db" -f "$ROOT/supabase/schema.sql" > /dev/null 2>&1
    psql_h -d "$db" -f "$ROOT/scripts/pg-harness/seed.sql"
    tmp="$(mktemp -d)"
    for f in "$ROOT"/supabase/migrations/0*.sql; do
      v="$(basename "$f" | cut -c1-4)"
      [[ "$v" < "0013" ]] && continue
      [[ "$v" > "$last" ]] && break
      src="$f"
      if [ "$v" = "0024" ]; then
        # pg_cron is not installable here; platform-stubs.sql provides cron.*.
        sed -e 's/^create extension if not exists pg_cron;$/-- (harness) pg_cron stubbed/' \
            -e "s/if not exists (select 1 from pg_extension where extname = 'pg_cron') then/if false then/" \
            "$f" > "$tmp/$(basename "$f")"
        src="$tmp/$(basename "$f")"
      fi
      if ! out="$(psql_h -d "$db" -f "$src" 2>&1 >/dev/null)"; then
        echo "FAILED at $(basename "$f")"; echo "$out" | grep -E "ERROR|LINE|CONTEXT" | head -5; rm -rf "$tmp"; exit 1
      fi
    done
    rm -rf "$tmp"
    echo "replayed schema.sql + 0013..$last into $db" ;;
  *)
    echo "usage: $0 init|start|stop|status|remove|psql [args]|replay <db> <last-version>"; exit 2 ;;
esac
