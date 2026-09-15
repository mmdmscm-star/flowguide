// The publish token must cover every input the ownership gate reads. If
// loadPacketOwnership starts selecting a column the token does not hash, a
// change to that column could slip between the gate and the publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync("src/lib/ownership-service.ts", "utf8");
const migration = readFileSync("supabase/migrations/0052_publication_infrastructure.sql", "utf8");
const tokenStart = migration.indexOf("create function public.packet_publish_token(");
const tokenBody = migration.slice(migration.indexOf("as $$", tokenStart), migration.indexOf("$$;", tokenStart));

// table -> the column list the token hashes for it, as written in the function.
function hashedColumns(table: string): string[] {
  const patterns: Record<string, RegExp> = {
    packets: /with p as \(\s*select ([^\n]*)\n/,
    items: /its as \(\s*select ([^\n]*)\n/,
    item_photos: /jsonb_build_array\((ph\.[^)]*)\)/,
    ingestion_runs: /jsonb_build_array\((r\.[^)]*)\)/,
    ingestion_chunks: /jsonb_build_array\((c\.[^)]*)\)/,
    item_media_decisions: /jsonb_build_array\((d\.[^)]*)\)/,
  };
  const m = tokenBody.match(patterns[table]);
  assert.ok(m, `the token does not hash ${table}`);
  return m[1].split(",").map((c) => c.trim().replace(/^\w+\./, ""));
}

test("every column loadPacketOwnership selects is hashed into the publish token", () => {
  const start = service.indexOf("export async function loadPacketOwnership");
  assert.ok(start >= 0, "loadPacketOwnership moved; point this test at it");
  const body = service.slice(start);
  const reads = [...body.matchAll(/\.from\("(\w+)"\)\s*\.select\("([^"]+)"\)/g)];
  assert.ok(reads.length >= 6, `expected the ownership reads, found ${reads.length}`);
  for (const [, table, cols] of reads) {
    if (table === "sections") continue;   // only ids, used to reach items; the token joins through sections itself
    const hashed = hashedColumns(table);
    for (const col of cols.split(",").map((c) => c.trim())) {
      assert.ok(hashed.includes(col), `ownership reads ${table}.${col} but the publish token does not hash it`);
    }
  }
});

test("the token's items join matches the ownership scope (items of this Sendset's sections)", () => {
  assert.match(tokenBody, /from public\.items i\s+join public\.sections s on s\.id = i\.section_id\s+where s\.packet_id = p_packet_id/);
  for (const table of ["item_photos ph where ph.item_id in (select id from its)", "ingestion_runs r where r.id in (select origin_run_id from its)",
                       "ingestion_chunks c where c.run_id in (select origin_run_id from its)", "item_media_decisions d where d.item_id in (select id from its)"]) {
    assert.ok(tokenBody.includes(table), `the token no longer scopes ${table.split(" ")[0]} to this Sendset`);
  }
});
