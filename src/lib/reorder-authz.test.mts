// OWNERSHIP ON THE PACKET REORDER ROUTE.
//
// The defect: the route checked that SOMEBODY was signed in, then wrote
// `sort_order` on the service-role client — which bypasses RLS — filtered by
// `.eq("id", id)` and nothing else. Any signed-in person who knew a row id
// could reorder anyone's FlowGuide, and the ids are published: the recipient
// page renders each item's uuid as a quick-nav anchor, so reading a public
// FlowGuide hands over everything needed to rewrite its order.
//
// These are properties of the WIRING, in the same shape as
// ownership-route.test.mts: each one is a mistake that type-checks perfectly
// and that no unit test of a function would notice, because the damage is in
// what the code is connected to and in what order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ROUTE = read("src/app/api/reorder/route.ts");
const EDITOR = read("src/components/editor/legacy-packet-editor.tsx");
const PUBLIC_ITEM = read("src/components/section-group.tsx");

test("PREMISE: the ids this route accepts are published in recipient HTML", () => {
  // If this stops being true the defect is less severe, but the fix is still
  // right — and the comment explaining WHY should be corrected rather than
  // left claiming something the code no longer does.
  assert.match(PUBLIC_ITEM, /id=\{`item-\$\{item\.id\}`\}/,
    "item uuids are no longer rendered publicly; revisit the route's rationale");
});

test("the type is NAMED, never defaulted into a table", () => {
  // `const table = type === "sections" ? "sections" : "items"` sent every
  // unrecognised value to `items`.
  assert.ok(!/\?\s*"sections"\s*:\s*"items"/.test(ROUTE),
    "an unknown type still falls through to a table");
  assert.match(ROUTE, /type !== "sections" && type !== "items"/,
    "the route does not reject an unknown type outright");
});

test("the packet is verified against the SESSION, not taken from the body", () => {
  assert.match(ROUTE, /\.from\("packets"\)[\s\S]{0,120}\.eq\("user_id", session\.userId\)/,
    "the packet lookup is not scoped to the caller");
  assert.ok(!/user_id[^\n]*body|body[^\n]*user_id/.test(ROUTE),
    "an owner id is being read from the request body");
});

test("A GATE AFTER THE WRITE IS NOT A GATE — ownership is checked first", () => {
  const gate = ROUTE.indexOf('.eq("user_id", session.userId)');
  const firstWrite = ROUTE.indexOf(".update(");
  assert.ok(gate > 0, "there is no ownership check");
  assert.ok(firstWrite > 0, "there is no write");
  assert.ok(gate < firstWrite, "the ownership check happens after the first write");
});

test("every id is proved to be in that packet BEFORE anything is written", () => {
  // A request mixing one of the caller's ids with a stranger's must be refused
  // whole, not applied to whichever rows happened to match.
  const checks = ROUTE.match(/\(owned \?\? \[\]\)\.length !== ids\.length/g) ?? [];
  assert.equal(checks.length, 2, "both branches must prove membership for every id");
  for (const m of checks) assert.ok(m);
  const firstWrite = ROUTE.indexOf(".update(");
  assert.ok(ROUTE.indexOf("(owned ?? []).length !== ids.length") < firstWrite,
    "membership is proved after the first write");
});

test("EVERY WRITE REPEATS THE PREDICATE — no bare id filter survives", () => {
  // The exact shape of the defect, asserted as absent.
  assert.ok(!/\.update\(\{ sort_order: index \}\)\s*\.eq\("id", id\)\)/.test(ROUTE),
    "a write is still filtered by id alone");
  assert.match(ROUTE,
    /\.from\("sections"\)\.update\(\{ sort_order: index \}\)[\s\S]{0,80}\.eq\("packet_id", packetId\)/,
    "the section write is not scoped to the packet");
  assert.match(ROUTE,
    /\.from\("items"\)\.update\(\{ sort_order: index \}\)[\s\S]{0,80}\.in\("section_id", sectionIds\)/,
    "the item write is not scoped to the packet's sections");
});

test("items are reached only through THIS packet's sections", () => {
  // items carry no packet_id, so the join has to be made explicit.
  assert.match(ROUTE, /\.from\("sections"\)\.select\("id"\)\.eq\("packet_id", packetId\)/,
    "the item branch does not derive its sections from the packet");
  assert.match(ROUTE, /\.from\("items"\)\.select\("id"\)\.in\("section_id", sectionIds\)\.in\("id", ids\)/,
    "the item membership read is not constrained to those sections");
});

test("ORDER ONLY: nothing but sort_order is writable here", () => {
  const updates = ROUTE.match(/\.update\(\{[^}]*\}\)/g) ?? [];
  assert.equal(updates.length, 2, "the route has grown a write");
  for (const u of updates)
    assert.equal(u, ".update({ sort_order: index })", `this write reaches beyond order: ${u}`);
});

test("a failed write is reported, not swallowed", () => {
  assert.match(ROUTE, /writes\.some\(\(w\) => w\.error\)/,
    "write errors are discarded, so the editor can show saved over an order that never landed");
});

test("both editor call sites send the packet they are reordering", () => {
  const calls = EDITOR.match(/body: JSON\.stringify\(\{ type: "(items|sections)"[^)]*\)/g) ?? [];
  assert.equal(calls.length, 2, "the editor no longer has exactly two reorder calls");
  for (const c of calls)
    assert.match(c, /packetId/, `a reorder call omits the packet: ${c}`);
});

test("a duplicated id is refused rather than given two positions", () => {
  assert.match(ROUTE, /new Set\(ids\)\.size !== ids\.length/,
    "a repeated id would be assigned two different positions");
});
