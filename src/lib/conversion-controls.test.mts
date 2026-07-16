// Focused tests for the R2-C conversion controls (routes + warning copy +
// published gating). Static assertions on source; live convert/revert behavior
// is validated against disposable packets in the runtime pass.
// Run: node --test src/lib/conversion-controls.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const convertRoute = read("src/app/api/packets/[id]/convert/route.ts");
const revertRoute = read("src/app/api/packets/[id]/revert/route.ts");
const control = read("src/components/editor/composition-mode-control.tsx");
const legacy = read("src/components/editor/legacy-packet-editor.tsx");
const block = read("src/components/editor/block-packet-editor.tsx");

for (const [name, route, rpc] of [
  ["convert", convertRoute, "convert_packet_to_blocks"],
  ["revert", revertRoute, "revert_packet_to_legacy"],
] as const) {
  test(`${name} route: authenticated, owner-checked, calls the right RPC`, () => {
    assert.match(route, /getSession/, "requires a session");
    assert.match(route, /status: 401/, "401 when unauthenticated");
    assert.match(route, /from\("packets"\)[\s\S]*\.eq\("id", id\)[\s\S]*\.eq\("user_id", session\.userId\)/, "owner-scoped packet check");
    assert.match(route, /status: 404/, "404 when not owned/found");
    assert.match(route, new RegExp(`rpc\\("${rpc}"`), `calls ${rpc}`);
    assert.match(route, /status: 400/, "400 on RPC failure (packet left unchanged)");
    assert.ok(!/update\(|delete\(|insert\(/.test(route), "route performs no direct writes itself");
  });
}

test("convert warning copy covers all required consequences", () => {
  // item content preserved; sections -> heading blocks; switches to flat editor;
  // revert discards block-only headings/order.
  assert.match(control, /item content is preserved/i);
  assert.match(control, /section becomes a heading block/i);
  assert.match(control, /flat block composition editor/i);
  assert.match(control, /revert.*headings.*ordering are discarded/i);
});

test("revert warning copy is stronger and covers all required consequences", () => {
  // item content remains; block-only headings + ordering discarded; legacy structure returns.
  assert.match(control, /item content remains/i);
  assert.match(control, /Block-only headings and the block ordering will be permanently discarded/i);
  assert.match(control, /frozen legacy section structure returns/i);
  assert.match(control, /danger: true/, "revert is styled as a stronger/danger action");
});

test("controls are gated to owned DRAFT packets (published never shows them)", () => {
  // legacy editor: convert control only under a draft check
  assert.match(legacy, /packet\.status === "draft"[\s\S]*?direction="convert"/, "convert only for draft legacy");
  // block editor: revert control only when not read-only (i.e. draft)
  assert.match(block, /!readOnly &&[\s\S]*?direction="revert"/, "revert only for draft block");
});

test("success flows navigate back into the correct editor with a notice", () => {
  assert.match(control, /window\.location\.href = `\/edit\/\$\{packetId\}\?\$\{c\.successParam\}=1`/, "hard-navigates to the editor with a success param");
  assert.match(block, /justConverted/, "block editor shows a converted notice");
  assert.match(legacy, /reverted"\) === "1"/, "legacy editor shows a reverted notice");
});
