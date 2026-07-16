// Focused cross-packet authorization test (R2-A). Because migration 0009 is not
// yet applied to any database (and this environment has no DDL access), this is a
// STATIC contract test: it proves the update/delete RPCs bind the block to the
// URL packet id, so "packet A's id + packet B's block id" cannot mutate anything.
// A live two-disposable-fixture test (documented in the report) should run once
// 0009 is applied.
// Run: node --test src/lib/block-authz.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/0009_block_composition_editing.sql"), "utf8");
const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");

function fnBody(sql: string, sig: string): string {
  const start = sql.indexOf("create or replace function public." + sig);
  assert.notEqual(start, -1, `function ${sig} not found`);
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `function ${sig} has no terminator`);
  return sql.slice(start, end);
}

for (const [name, sig] of [
  ["update_heading_block", "update_heading_block(p_packet_id uuid, p_block_id uuid"],
  ["delete_heading_block", "delete_heading_block(p_packet_id uuid, p_block_id uuid"],
] as const) {
  test(`${name}: takes (p_packet_id, p_block_id) and binds the block to the packet`, () => {
    const body = fnBody(migration, sig);
    // locks the URL packet
    assert.match(body, /from public\.packets where id = p_packet_id for update/, "must lock p_packet_id");
    // requires draft + block mode
    assert.match(body, /is not draft/, "must require draft");
    assert.match(body, /is not in block mode/, "must require block mode");
    // binds the block to THIS packet — the key cross-packet guard
    assert.match(body, /where id = p_block_id and packet_id = p_packet_id/, "must bind block to packet");
    // rejects a cross-packet block with a clear error
    assert.match(body, /does not belong to packet/, "must reject a block not in the packet");
    // rejects item blocks
    assert.match(body, /is an item block and cannot be (edited|deleted) here/, "must reject item blocks");
    // preserves the invariant
    assert.match(body, /assert_packet_block_consistency\(p_packet_id\)/, "must assert consistency");
  });

  test(`${name}: schema.sql parity uses the same bound signature`, () => {
    assert.ok(schema.includes("create or replace function public." + sig), "schema.sql must define the bound signature");
    // the old unbound signature must be gone from both files
    const unbound = name === "update_heading_block"
      ? "update_heading_block(p_block_id uuid, p_text"
      : "delete_heading_block(p_block_id uuid)";
    assert.ok(!migration.includes(unbound), `migration must not keep the unbound ${name} signature`);
    assert.ok(!schema.includes(unbound), `schema must not keep the unbound ${name} signature`);
  });
}

test("delete only removes the one heading row (item content untouched)", () => {
  const body = fnBody(migration, "delete_heading_block(p_packet_id uuid, p_block_id uuid");
  assert.match(body, /delete from public\.packet_blocks where id = p_block_id and packet_id = p_packet_id/);
  // no delete of items/sections/item_* content
  assert.ok(!/delete from public\.items/.test(body), "must not delete item rows");
  assert.ok(!/delete from public\.(sections|item_)/.test(body), "must not delete item content");
});
