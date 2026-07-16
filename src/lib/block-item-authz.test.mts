// Focused tests for the block item-content route wiring (R2-B). The route now
// delegates all verification + the atomic write to the update_block_item_content
// RPC (see block-item-rpc.test.mts for the RPC contract). The legacy route keeps
// the shared multi-call helper (behavior unchanged in this slice).
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

test("block item route delegates to the atomic RPC, passing the server owner id", () => {
  assert.match(route, /update_block_item_content/, "calls the atomic RPC");
  assert.match(route, /p_owner_id:\s*session\.userId/, "passes the authenticated owner id");
  assert.match(route, /p_packet_id:\s*id/, "passes the URL packet id");
  assert.match(route, /p_item_id:\s*itemId/, "passes the URL item id");
});

test("block item route performs no composition/order writes or item CRUD itself", () => {
  // Strip comments so prose describing what it does NOT do isn't matched.
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/packet_blocks|sort_order|section_id/.test(code), "no composition/order references in the route");
  assert.ok(!/applyItemContentUpdate/.test(code), "route no longer uses the multi-call helper");
});

test("legacy route still uses the shared content helper (unchanged behavior)", () => {
  assert.match(legacy, /applyItemContentUpdate/, "legacy route uses the shared helper");
  assert.match(legacy, /moveUpdates/, "legacy keeps its section/sort move handling");
});

test("shared helper (legacy path) never touches composition/order/membership", () => {
  const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/section_id\s*[:=]/.test(code), "helper never writes items.section_id");
  assert.ok(!/\.update\([^)]*sort_order/.test(code), "helper never updates items.sort_order");
  assert.ok(!/packet_blocks|from\("sections"\)|from\("packets"\)/.test(code), "helper never touches composition tables");
});
