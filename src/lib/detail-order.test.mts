import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moveDetail, detailsPayload } from "./detail-order.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const EDITOR = "src/components/editor/legacy-packet-editor.tsx";

// The screenshot's list: Type sits far down, and the professional wants it up top.
const rows = () => [
  { id: "a", label: "Memory Care Shared Suite", value: "$8,990/month" },
  { id: "b", label: "Community Fee", value: "$4,000" },
  { id: "c", label: "Type", value: "MC" },
  { id: "d", label: "Contact Name", value: "Sean Baron" },
];
const labels = (d: Array<{ label: string }>) => d.map((x) => x.label);

test("a row can be moved to the top", () => {
  const moved = moveDetail(rows(), "c", "a");
  assert.deepEqual(labels(moved), ["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]);
});

test("a row can be moved down, and the gap behind it closes", () => {
  const moved = moveDetail(rows(), "a", "d");
  assert.deepEqual(labels(moved), ["Community Fee", "Type", "Contact Name", "Memory Care Shared Suite"]);
});

test("REORDERING CHANGES ONLY SEQUENCE — never a label or a value", () => {
  const before = rows();
  const after = moveDetail(before, "c", "a");
  assert.deepEqual(
    [...after].sort((x, y) => x.id.localeCompare(y.id)),
    [...before].sort((x, y) => x.id.localeCompare(y.id)),
    "a value changed during a move");
  assert.equal(after.length, before.length);
  assert.notEqual(after, before, "the array should be a new reference once something moved");
});

test("a drop on itself, or on an unknown row, changes nothing and saves nothing", () => {
  const before = rows();
  assert.equal(moveDetail(before, "c", "c"), before, "a self-drop produced a new array, which would save");
  assert.equal(moveDetail(before, "c", "zzz"), before);
  assert.equal(moveDetail(before, "zzz", "a"), before);
});

test("the saved payload is the list IN ORDER, carrying no ordinal of its own", () => {
  const moved = moveDetail(rows(), "c", "a");
  const payload = detailsPayload(moved);
  assert.deepEqual(payload, [
    { label: "Type", value: "MC" },
    { label: "Memory Care Shared Suite", value: "$8,990/month" },
    { label: "Community Fee", value: "$4,000" },
    { label: "Contact Name", value: "Sean Baron" },
  ]);
  // Position is the only thing carrying order. A second field could disagree
  // with the array, and update_item_content would believe the array.
  for (const row of payload) assert.deepEqual(Object.keys(row).sort(), ["label", "value"]);
});

test("EDITING A REORDERED ROW LEAVES IT WHERE IT WAS PUT", () => {
  const moved = moveDetail(rows(), "c", "a");
  // ...the edit the editor performs, by id, exactly as updateDetail does.
  const edited = moved.map((d) => (d.id === "c" ? { ...d, value: "MC, AL" } : d));
  assert.deepEqual(labels(edited), ["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]);
  assert.equal(edited[0].value, "MC, AL");
  assert.deepEqual(detailsPayload(edited)[0], { label: "Type", value: "MC, AL" });
});

test("ADDING appends without disturbing the chosen order", () => {
  const moved = moveDetail(rows(), "c", "a");
  const added = [...moved, { id: "new", label: "", value: "" }];
  assert.deepEqual(labels(added).slice(0, 4), ["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]);
  assert.equal(added.length, 5);
});

test("DELETING removes one row and the rest keep their sequence", () => {
  const moved = moveDetail(rows(), "c", "a");
  const removed = moved.filter((d) => d.id !== "b");
  assert.deepEqual(labels(removed), ["Type", "Memory Care Shared Suite", "Contact Name"]);
  // ...and a move still works afterwards, against the shortened list: dropping
  // Contact Name onto the row at index 1 puts it AT index 1.
  assert.deepEqual(labels(moveDetail(removed, "d", "a")),
    ["Type", "Contact Name", "Memory Care Shared Suite"]);
});

test("order survives a round trip through the save payload", () => {
  const moved = moveDetail(rows(), "c", "a");
  // What update_item_content does with it: sort_order = array position.
  const stored = detailsPayload(moved).map((d, sort_order) => ({ ...d, sort_order }));
  // What every read path does: order by sort_order.
  const reloaded = [...stored].sort((x, y) => y.sort_order - x.sort_order).reverse();
  assert.deepEqual(labels(reloaded), ["Type", "Memory Care Shared Suite", "Community Fee", "Contact Name"]);
});

// ---------------------------------------------------------------------------
// The editor wiring — that the interaction exists, and is not mouse-only.
// ---------------------------------------------------------------------------
test("detail rows are draggable with the SAME system the rest of the editor uses", () => {
  const src = codeOf(EDITOR);
  assert.match(src, /function DetailRows\(/, "there is no sortable detail list");
  assert.match(src, /function SortableDetailRow\(/);
  assert.match(src, /useSortable\(\{\s*id: detail\.id,?\s*\}\)/,
    "detail rows are not registered as sortables by their own id");
  assert.ok(!/onDragEnd=\{[^}]*onReorderDetail[^}]*\}[\s\S]{0,200}?arrayMove/.test(src),
    "the detail list should reorder through moveDetail, not a second implementation");
  assert.match(src, /moveDetail\(item\.details, activeId, overId\)/,
    "the editor does not use the shared reorder semantics");
});

test("the drag handle is reachable by KEYBOARD, not mouse only", () => {
  const src = codeOf(EDITOR);
  const block = src.slice(src.indexOf("function DetailRows("), src.indexOf("function SortableDetailRow("));
  assert.match(block, /KeyboardSensor/,
    "the detail list has no keyboard sensor, so keyboard users cannot reorder");
  assert.match(block, /sortableKeyboardCoordinates/);
  assert.match(block, /PointerSensor/);
});

test("the handle and the delete control both NAME the row they act on", () => {
  const src = codeOf(EDITOR);
  const block = src.slice(src.indexOf("function SortableDetailRow("));
  assert.match(block, /aria-label=\{named \? `Reorder detail: \$\{named\}` : "Reorder detail"\}/,
    "the drag handle does not identify which detail it moves");
  assert.match(block, /aria-label=\{named \? `Remove detail: \$\{named\}` : "Remove detail"\}/);
});

test("reordering saves through the SAME endpoint editing already uses", () => {
  const src = codeOf(EDITOR);
  const fn = src.slice(src.indexOf("function reorderDetail("), src.indexOf("function removeDetail("));
  assert.match(fn, /fetch\("\/api\/items"/, "reordering does not save");
  assert.match(fn, /method: "PATCH"/);
  assert.match(fn, /details: detailsPayload\(updatedDetails\)/,
    "reordering sends something other than the ordered list");
  assert.ok(!/reorder/i.test(fn.replace(/function reorderDetail\(|\/\/.*$/gm, "")) ||
            !/\/api\/reorder/.test(fn),
    "details should not go through the items/sections reorder endpoint, which orders different tables");
});

test("a move that changes nothing does not trigger a save", () => {
  const src = codeOf(EDITOR);
  const fn = src.slice(src.indexOf("function reorderDetail("), src.indexOf("function removeDetail("));
  assert.match(fn, /if \(updatedDetails === item\.details\) return;/,
    "a self-drop would still PATCH the order it already had");
});
