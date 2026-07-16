// Contract tests for the atomic item-content RPC. Item-content editing began in
// R2-B (migration 0010, update_block_item_content — block-only, single contact)
// and is SUPERSEDED by migration 0011's update_item_content: ONE atomic writer
// shared by BOTH editors, taking an ordered p_contacts ARRAY and presence-aware
// so the legacy editor's partial autosaves and the block editor's full save go
// through the same transaction. schema.sql carries the current definition. Static
// proof from the SQL because the migration is not applied in this slice; the LIVE
// runtime proofs (forced child failure, cross-packet, published/legacy,
// comprehensive save, block order/ids unchanged) run against disposable packets
// during the controlled application of the migration.
// Run: node --test src/lib/block-item-rpc.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/0011_multiple_item_contacts.sql"), "utf8");
const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, "terminator not found");
  return sql.slice(start, end);
}
const body = fnBody(migration, "update_item_content");

test("atomicity: single SECURITY DEFINER function with NO exception handler (any failure rolls back all)", () => {
  assert.match(body, /security definer/, "SECURITY DEFINER");
  assert.match(body, /set search_path = ''/, "hardened search_path");
  // No BEGIN..EXCEPTION..END that could swallow an error and commit partial work.
  assert.ok(!/\bexception\s+when\b/i.test(body), "must not catch/swallow errors");
  // Fails closed on malformed child input (the forced-failure vector) -> rolls back.
  assert.match(body, /must be a JSON array/, "raises on malformed child input");
});

test("verifies item-exists, packet cross-check, owner, draft, and mode — each raises", () => {
  assert.match(body, /where it\.id = p_item_id;[\s\S]*?v_packet_id is null[\s\S]*?raise exception/, "item must exist");
  assert.match(body, /p_packet_id is not null and v_packet_id <> p_packet_id[\s\S]*?raise exception/, "optional packet cross-check");
  assert.match(body, /where id = v_packet_id for update/, "locks the packet row");
  assert.match(body, /v_user <> p_owner_id[\s\S]*?raise exception/, "owner id must match packets.user_id");
  assert.match(body, /v_status <> 'draft'[\s\S]*?raise exception/, "requires draft");
  assert.match(body, /p_require_mode is not null and v_mode <> p_require_mode[\s\S]*?raise exception/, "optional mode guard (blocks|legacy)");
});

test("never changes section_id, item/block ordering, or block membership", () => {
  assert.ok(!/packet_blocks/.test(body), "never references packet_blocks");
  const upd = body.slice(body.indexOf("update public.items"), body.indexOf("-- Replace details"));
  assert.ok(!/section_id/.test(upd), "items update never sets section_id");
  assert.ok(!/sort_order/.test(upd), "items update never sets items.sort_order");
});

test("presence-aware: core fields coalesce to existing; each child replace is guarded by is-not-null", () => {
  // NULL param leaves the column unchanged (legacy partial save); provided value wins.
  assert.match(body, /set title = coalesce\(p_title, title\)/, "title unchanged when null");
  assert.match(body, /description = coalesce\(p_description, description\)/);
  assert.match(body, /notes = coalesce\(p_notes, notes\)/);
  assert.match(body, /address = coalesce\(p_address, address\)/);
  // Children only touched when their array is provided.
  for (const g of ["p_details", "p_links", "p_photos", "p_contacts"]) {
    assert.match(body, new RegExp(`if ${g} is not null then`), `${g} replace is guarded (untouched when null)`);
  }
});

test("comprehensive save: all four child sets replaced; photos http-only", () => {
  for (const t of ["item_details", "item_links", "item_photos", "item_contacts"]) {
    assert.match(body, new RegExp(`delete from public\\.${t} where item_id = p_item_id`), `${t} replaced (delete)`);
  }
  assert.match(body, /insert into public\.item_details/, "details insert");
  assert.match(body, /insert into public\.item_links/, "links insert");
  assert.match(body, /insert into public\.item_photos/, "photos insert");
  assert.match(body, /like 'http%'/, "photos http-only filter");
});

test("contacts is an ordered ARRAY; every person + role/sort_order preserved, blanks dropped", () => {
  assert.match(body, /for r in select value from jsonb_array_elements\(p_contacts\)/, "iterates every contact");
  assert.match(body, /insert into public\.item_contacts \(item_id, name, role, phone, email, website, sort_order\)/, "writes role + sort_order per person");
  // Only non-blank contacts are written.
  assert.match(body, /coalesce\(r->>'name', ''\) <> ''[\s\S]*?coalesce\(r->>'website', ''\) <> ''/, "blank rows dropped");
  // No lingering singular-object shape.
  assert.ok(!/p_contact\b(?!s)/.test(body), "no singular p_contact in the new writer");
});

test("migration/schema parity: update_item_content body byte-identical + granted only to service_role", () => {
  assert.equal(fnBody(schema, "update_item_content"), body, "function body identical in schema.sql");
  const grantLines = schema.split("\n").filter((l) => /on function public\.update_item_content/.test(l));
  assert.equal(grantLines.length, 2, "one revoke + one grant");
  assert.ok(grantLines.some((l) => /^revoke all/.test(l)), "revoke all from public/anon/authenticated/service_role");
  assert.ok(grantLines.some((l) => /^grant execute/.test(l) && /service_role/.test(l)), "grant execute to service_role only");
  // Exact signature (3 uuid, 5 text, 4 jsonb) — a wrong type count here would make
  // the grant target a non-existent function and abort the migration.
  const SIG = "public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb)";
  assert.ok(grantLines.every((l) => l.includes(SIG)), "grants reference the exact 12-arg signature");
});

test("migration 0011 is wrapped in one explicit transaction (all-or-nothing)", () => {
  const stmts = migration
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"));
  assert.equal(stmts[0], "begin;", "first executable statement is begin;");
  assert.equal(stmts[stmts.length - 1], "commit;", "last executable statement is commit;");
});

test("grant signature matches the update_item_content parameter list exactly", () => {
  // Derive the type list from the function DEFINITION and assert the grants use it,
  // so a hand-written grant signature can never drift from the real parameters.
  const def = body.slice(body.indexOf("("), body.indexOf(")") + 1);
  const types = def
    .slice(1, -1)
    .split(",")
    .map((p) => p.trim().split(/\s+/)[1]) // "p_name uuid" -> "uuid"
    .join(", ");
  assert.equal(types, "uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb", "definition is 3 uuid, 5 text, 4 jsonb");
  const grantLines = migration.split("\n").filter((l) => /on function public\.update_item_content/.test(l));
  assert.ok(grantLines.length === 2 && grantLines.every((l) => l.includes(`public.update_item_content(${types})`)), "migration grants use the definition's exact type list");
});

test("0010 update_block_item_content is left intact for the migrate->deploy window (not redefined by 0011)", () => {
  // 0011 must NOT redefine update_block_item_content (can't rename its param; the
  // deployed app still calls it with a singular p_contact during the window).
  assert.equal(migration.indexOf("function public.update_block_item_content"), -1, "0011 does not touch update_block_item_content");
  // schema.sql still carries the 0010 singular-contact version for reference.
  const legacy = fnBody(schema, "update_block_item_content");
  assert.match(legacy, /p_contact jsonb/, "0010 writer keeps its singular p_contact param");
});
