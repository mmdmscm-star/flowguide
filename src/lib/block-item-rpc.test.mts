// Focused contract tests for the atomic block item-content RPC. Introduced in
// R2-B (migration 0010) and SUPERSEDED by migration 0011 (multiple contacts per
// item), which redefines update_block_item_content to take an ordered p_contacts
// ARRAY. schema.sql carries the current (0011) definition, so the function body
// is sourced from 0011 here; 0011 keeps the 0010 signature and therefore does not
// restate the grants (they persist across create-or-replace). Static proof from
// the SQL because the migration is not applied in this slice; the LIVE runtime
// proofs (forced child failure, cross-packet, published/legacy, comprehensive
// save, block order/ids unchanged) run against disposable packets during the
// controlled application of the migration.
// Run: node --test src/lib/block-item-rpc.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/0011_multiple_item_contacts.sql"), "utf8");
const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");

function fnBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.update_block_item_content");
  assert.notEqual(start, -1, "function not found");
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, "terminator not found");
  return sql.slice(start, end);
}
const body = fnBody(migration);

test("atomicity: single SECURITY DEFINER function with NO exception handler (any failure rolls back all)", () => {
  assert.match(body, /security definer/, "SECURITY DEFINER");
  assert.match(body, /set search_path = ''/, "hardened search_path");
  // No BEGIN..EXCEPTION..END that could swallow an error and commit partial work.
  assert.ok(!/\bexception\s+when\b/i.test(body), "must not catch/swallow errors");
  // Fails closed on malformed child input (the forced-failure vector) -> rolls back.
  assert.match(body, /must be a JSON array/, "raises on malformed child input");
});

test("verifies owner, draft, block mode, and item-belongs-to-packet — each raises", () => {
  assert.match(body, /where id = p_packet_id for update/, "locks the packet row");
  assert.match(body, /v_user <> p_owner_id[\s\S]*?raise exception/, "owner id must match packets.user_id");
  assert.match(body, /v_status <> 'draft'[\s\S]*?raise exception/, "requires draft");
  assert.match(body, /v_mode <> 'blocks'[\s\S]*?raise exception/, "requires block mode");
  assert.match(body, /v_item_packet <> p_packet_id[\s\S]*?raise exception/, "item must belong to this packet");
});

test("never changes section_id, item/block ordering, or block membership", () => {
  assert.ok(!/packet_blocks/.test(body), "never references packet_blocks");
  // the items update sets ONLY content columns
  const upd = body.slice(body.indexOf("update public.items"), body.indexOf("-- Replace details"));
  assert.ok(!/section_id/.test(upd), "items update never sets section_id");
  assert.ok(!/sort_order/.test(upd), "items update never sets items.sort_order");
});

test("comprehensive save: core fields updated + all four child sets replaced", () => {
  assert.match(body, /update public\.items[\s\S]*set title =[\s\S]*description =[\s\S]*notes =[\s\S]*address =/, "core fields");
  for (const t of ["item_details", "item_links", "item_photos", "item_contacts"]) {
    assert.match(body, new RegExp(`delete from public\\.${t} where item_id = p_item_id`), `${t} replaced (delete)`);
  }
  assert.match(body, /insert into public\.item_details/, "details insert");
  assert.match(body, /insert into public\.item_links/, "links insert");
  assert.match(body, /insert into public\.item_photos/, "photos insert");
  assert.match(body, /insert into public\.item_contacts/, "contact insert");
  // photos still http-only
  assert.match(body, /like 'http%'/, "photos http-only filter");
});

test("migration/schema parity: function body byte-identical (current definition = 0011)", () => {
  assert.equal(fnBody(schema), fnBody(migration), "function body identical");
});

test("contacts is an ordered ARRAY (not a single object); every person + role/sort_order preserved", () => {
  // The regression: the old body took a single p_contact object, so a second
  // person was silently dropped. The current body must iterate an array.
  assert.match(body, /p_contacts jsonb/, "takes an ordered contacts array");
  assert.match(body, /contacts must be a JSON array/, "rejects a non-array (fails closed -> rollback)");
  assert.match(body, /for r in select value from jsonb_array_elements\(p_contacts\)/, "iterates every contact");
  assert.match(body, /insert into public\.item_contacts \(item_id, name, role, phone, email, website, sort_order\)/, "writes role + sort_order per person");
  assert.ok(!/p_contact\b(?!s)/.test(body), "no lingering singular p_contact");
});

test("grants persist across 0011 (unchanged signature): schema keeps one revoke + one grant", () => {
  // 0011 replaces the function with the SAME 11-arg signature, so Postgres keeps
  // the existing grants; 0011 deliberately does not restate them. schema.sql is
  // the running snapshot and must still carry exactly the one-revoke/one-grant
  // pair for the current signature.
  const grantLines = schema
    .split("\n")
    .filter((l) => /on function public\.update_block_item_content/.test(l));
  assert.equal(grantLines.length, 2, "one revoke + one grant in schema");
  assert.ok(grantLines.some((l) => /^revoke all/.test(l)), "revoke all from public/anon/authenticated/service_role");
  assert.ok(grantLines.some((l) => /^grant execute/.test(l) && /service_role/.test(l)), "grant execute to service_role only");
  // The signature the grants reference must end in the four jsonb params
  // (…, jsonb, jsonb, jsonb, jsonb) — proving they match the current definition.
  assert.ok(grantLines.every((l) => /jsonb, jsonb, jsonb, jsonb\)/.test(l)), "grants reference the 11-arg signature");
});
