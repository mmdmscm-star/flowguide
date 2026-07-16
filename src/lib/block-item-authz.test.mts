// Focused tests for the item-content route wiring. BOTH editors now delegate all
// verification + the atomic write to ONE shared helper (applyItemContentUpdate ->
// update_item_content RPC; see block-item-rpc.test.mts for the RPC contract). The
// block route passes the URL packet id + requireMode 'blocks'; the legacy route
// passes requireMode 'legacy' and keeps its own section/sort move handling.
// Run: node --test src/lib/block-item-authz.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(join(root, "src/app/api/packets/[id]/items/[itemId]/route.ts"), "utf8");
const legacy = readFileSync(join(root, "src/app/api/items/route.ts"), "utf8");
const helper = readFileSync(join(root, "src/lib/item-content.ts"), "utf8");

test("block item route delegates to the shared atomic helper with owner/packet/mode", () => {
  assert.match(route, /applyItemContentUpdate/, "uses the shared helper");
  assert.match(route, /ownerId:\s*session\.userId/, "passes the authenticated owner id");
  assert.match(route, /packetId:\s*id/, "passes the URL packet id for the cross-check");
  assert.match(route, /itemId\b/, "passes the URL item id");
  assert.match(route, /requireMode:\s*"blocks"/, "enforces block mode");
});

test("block item route performs no composition/order writes or item CRUD itself", () => {
  // Strip comments so prose describing what it does NOT do isn't matched.
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/packet_blocks|sort_order|section_id/.test(code), "no composition/order references in the route");
  assert.ok(!/\.from\(/.test(code), "route issues no direct table writes — all through the RPC helper");
});

test("legacy route uses the same shared helper, enforcing legacy mode + keeping moves", () => {
  assert.match(legacy, /applyItemContentUpdate/, "legacy route uses the shared helper");
  assert.match(legacy, /requireMode:\s*"legacy"/, "enforces legacy mode");
  assert.match(legacy, /moveUpdates/, "legacy keeps its section/sort move handling");
});

test("shared helper is ONE atomic RPC call (update_item_content) — no multi-call, no composition writes", () => {
  const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Single implementation: exactly one rpc() call to the canonical writer.
  assert.match(code, /\.rpc\(\s*["']update_item_content["']/, "delegates to update_item_content");
  const rpcCount = (code.match(/\.rpc\(/g) || []).length;
  assert.equal(rpcCount, 1, "exactly one RPC round-trip (atomic; not the old multi-call helper)");
  // No independent PostgREST reads/writes remain (the source of the old non-atomicity).
  assert.ok(!/\.from\(/.test(code), "no direct table ops — atomicity lives entirely in the RPC");
  assert.ok(!/section_id|sort_order|packet_blocks/.test(code), "never touches composition/order/membership");
});
