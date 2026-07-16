// Static contract proof that the "Add items with AI" path (append into an
// existing section) preserves MULTIPLE contacts (migration 0011). The route
// imports next/server and can't be loaded under node --test, and the RPC is not
// applied in this slice, so — like block-item-rpc.test.mts — this asserts the
// invariants from the source text. LIVE runtime proof runs against a disposable
// packet during the controlled application of the migration.
// Run: node --test src/lib/ai-append-contacts.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(
  join(root, "src/app/api/packets/[id]/sections/[sectionId]/append/route.ts"),
  "utf8"
);
const migration = readFileSync(join(root, "supabase/migrations/0011_multiple_item_contacts.sql"), "utf8");

// Isolate the insert_items_into_section body.
function insertFn(sql: string): string {
  const start = sql.indexOf("create or replace function public.insert_items_into_section");
  assert.notEqual(start, -1, "function not found");
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}
const fn = insertFn(migration);

test("route schema + validation use an ordered contacts ARRAY, not a single object", () => {
  // Allowed keys list the array, never the singular.
  assert.match(route, /ALLOWED_ITEM_KEYS = new Set\(\[[\s\S]*?"contacts"[\s\S]*?\]\)/, "allows contacts");
  assert.ok(!/"contact"[,\s]/.test(route.slice(route.indexOf("ALLOWED_ITEM_KEYS"), route.indexOf("ALLOWED_ITEM_KEYS") + 200)), "does not allow singular contact key");
  // Output schema shows an array.
  assert.match(route, /"contacts":\s*\[\{[^}]*"name"[^}]*"role"[^}]*\}\]/, "schema emits a contacts array with role");
  // A bare object (the old single-contact shape) is rejected — can't collapse two people to one.
  assert.match(route, /"contacts" in raw[\s\S]*?!Array\.isArray\(raw\.contacts\)[\s\S]*?contacts_not_array/, "rejects a non-array contacts");
});

test("insert_items_into_section iterates contacts, keeps role + sort_order, skips blanks, has legacy fallback", () => {
  // Iterates an array (never a single object).
  assert.match(fn, /jsonb_array_elements\([\s\S]*?it->'contacts'/, "iterates the contacts array");
  // Legacy singular fallback so any older payload still works.
  assert.match(fn, /jsonb_typeof\(it->'contact'\) = 'object'[\s\S]*?jsonb_build_array\(it->'contact'\)/, "legacy singular fallback");
  // Writes role + sort_order per person.
  assert.match(fn, /insert into public\.item_contacts \(item_id, name, role, phone, email, website, sort_order\)/, "role + sort_order columns");
  // Deterministic per-person ordering via ci.
  assert.match(fn, /ci := ci \+ 1/, "increments contact sort_order");
  // Skips fully-blank contacts.
  assert.match(fn, /coalesce\(c->>'name', ''\) <> ''[\s\S]*?coalesce\(c->>'website', ''\) <> ''/, "only writes non-blank contacts");
});
