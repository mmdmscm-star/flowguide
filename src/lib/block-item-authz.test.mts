// Focused authorization-contract test for the block item-content route (R2-B).
// Static assertions on the route source: a live packet-A + packet-B's-item test
// is run against disposable packets during runtime verification.
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

test("block item route enforces all four guards", () => {
  // 1. ownership: packet filtered by user_id
  assert.match(route, /from\("packets"\)[\s\S]*\.eq\("id", id\)[\s\S]*\.eq\("user_id", session\.userId\)/, "owns packet");
  // 2. draft
  assert.match(route, /status !== "draft"/, "requires draft");
  // 3. block mode
  assert.match(route, /composition_mode !== "blocks"/, "requires block mode");
  // 4. item belongs to THIS packet (item -> section -> packet_id === id)
  assert.match(route, /section\.packet_id !== id/, "item must belong to this packet");
});

test("block item route is content-only (no order/membership/composition writes)", () => {
  assert.match(route, /applyItemContentUpdate/, "delegates to the content helper");
  assert.ok(!/sort_order/.test(route), "never writes sort_order");
  assert.ok(!/section_id\s*[:=]/.test(route), "never sets section_id");
  assert.ok(!/packet_blocks/.test(route), "never touches packet_blocks");
});

test("legacy route reuses the same shared content helper (no duplication)", () => {
  assert.match(legacy, /applyItemContentUpdate/, "legacy route also uses the shared helper");
  // legacy retains its section-move capability (unchanged behavior)
  assert.match(legacy, /moveUpdates/, "legacy keeps section/sort move handling");
});

test("shared helper never touches composition/order/membership", () => {
  // Strip comments so prose (which explains what it does NOT do) isn't matched.
  const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // It may set child-row sort_order (links/details/photos), but never item order/membership.
  assert.ok(!/section_id\s*[:=]/.test(code), "helper never writes items.section_id");
  assert.ok(!/\.update\([^)]*sort_order/.test(code), "helper never updates items.sort_order");
  assert.ok(!/packet_blocks|from\("sections"\)|from\("packets"\)/.test(code), "helper never touches composition tables");
});
