// Shape validation for staged model results. The defect this guards: finalize
// coalesces a missing key to '[]', so a wrong-shape or empty result stages
// cleanly, every chunk reports "completed", and the run finalizes with ZERO
// content — a successful-looking import that added nothing.
// Run: npx tsx --test src/lib/ingest-validate.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEntryPointResult, shapeFor } from "./ingest-validate.ts";

const ITEM = { title: "Blue Bottle", address: "300 Webster St" };
const SECTIONS = { sections: [{ title: "Coffee", items: [ITEM] }] };
const ITEMS = { items: [ITEM] };

test("entry points map to the shape finalize actually reads", () => {
  assert.equal(shapeFor("organize"), "sections");
  assert.equal(shapeFor("append"), "sections");
  assert.equal(shapeFor("section_append"), "items");
});

test("valid results pass and report a usable item count", () => {
  for (const ep of ["organize", "append"]) {
    const r = validateEntryPointResult(ep, SECTIONS);
    assert.ok(r.ok, `${ep} should accept sections`);
    assert.equal(r.ok && r.itemCount, 1);
    assert.deepEqual(r.ok && r.result, { sections: SECTIONS.sections });
  }
  const r = validateEntryPointResult("section_append", ITEMS);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.result, { items: ITEMS.items });
});

// --- the two silent-no-op cases the acceptance pass called out -------------

test("items-only output CANNOT pass an append run", () => {
  for (const ep of ["organize", "append"]) {
    const r = validateEntryPointResult(ep, ITEMS);
    assert.ok(!r.ok, `${ep} must reject items-only`);
    assert.equal(!r.ok && r.code, "wrong_shape_expected_sections");
    assert.match(!r.ok ? r.message : "", /bare list of items/);
    assert.match(!r.ok ? r.message : "", /retry/i, "must be a retryable message");
  }
});

test("sections-only output CANNOT pass a section_append run", () => {
  const r = validateEntryPointResult("section_append", SECTIONS);
  assert.ok(!r.ok);
  assert.equal(!r.ok && r.code, "wrong_shape_expected_items");
  assert.match(!r.ok ? r.message : "", /sections/);
  assert.match(!r.ok ? r.message : "", /retry/i);
});

// --- empty / malformed ------------------------------------------------------

test("empty and contentless results are rejected, not silently finalized", () => {
  const cases: Array<[string, unknown, string]> = [
    ["append", { sections: [] }, "no_sections"],
    ["append", { sections: [{ title: "Empty" }] }, "no_items_in_sections"],
    ["append", { sections: [{ title: "Empty", items: [] }] }, "no_items_in_sections"],
    ["append", { sections: [{ title: "T", items: [{ title: "  " }] }] }, "no_usable_item"],
    ["section_append", { items: [] }, "no_items"],
    ["section_append", { items: [{ address: "no title" }] }, "no_usable_item"],
  ];
  for (const [ep, data, code] of cases) {
    const r = validateEntryPointResult(ep, data);
    assert.ok(!r.ok, `${ep} ${JSON.stringify(data)} must be rejected`);
    assert.equal(!r.ok && r.code, code, JSON.stringify(data));
    assert.match(!r.ok ? r.message : "", /retry/i);
  }
});

test("malformed containers are rejected", () => {
  const cases: Array<[string, unknown, string]> = [
    ["append", null, "result_not_object"],
    ["append", "a string", "result_not_object"],
    ["append", [], "result_not_object"],
    ["append", { sections: "nope" }, "sections_not_array"],
    ["append", { sections: ["not an object"] }, "section_not_object"],
    ["append", { sections: [{ title: "T", items: "nope" }] }, "section_items_not_array"],
    ["append", { sections: [{ title: "T", items: ["nope"] }] }, "item_not_object"],
    ["section_append", { items: "nope" }, "items_not_array"],
    ["section_append", { items: ["nope"] }, "item_not_object"],
  ];
  for (const [ep, data, code] of cases) {
    const r = validateEntryPointResult(ep, data);
    assert.ok(!r.ok, `${JSON.stringify(data)} must be rejected`);
    assert.equal(!r.ok && r.code, code, JSON.stringify(data));
  }
});

test("a bare contact object is rejected so two people cannot collapse into one", () => {
  const r = validateEntryPointResult("section_append", {
    items: [{ title: "T", contacts: { name: "Solo" } }],
  });
  assert.ok(!r.ok);
  assert.equal(!r.ok && r.code, "contacts_not_array");
});

test("nested list entries must be objects", () => {
  for (const key of ["details", "links", "contacts"]) {
    const r = validateEntryPointResult("section_append", { items: [{ title: "T", [key]: ["scalar"] }] });
    assert.ok(!r.ok, key);
    assert.equal(!r.ok && r.code, `${key}_entry_not_object`);
  }
  const p = validateEntryPointResult("section_append", { items: [{ title: "T", photos: [{ url: "x" }] }] });
  assert.ok(!p.ok);
  assert.equal(!p.ok && p.code, "photo_not_string");
});

// --- deliberately permissive ------------------------------------------------

test("optional fields may be absent or null — only structure is required", () => {
  const r = validateEntryPointResult("section_append", {
    items: [{ title: "Minimal" }, { title: "Nulls", details: null, links: null, contacts: null, photos: null }],
  });
  assert.ok(r.ok, !r.ok ? r.message : "");
  assert.equal(r.ok && r.itemCount, 2);
});

test("a section needs no title, and extra unknown fields are tolerated", () => {
  const r = validateEntryPointResult("append", {
    sections: [{ items: [{ title: "T", somethingNew: 1 }] }],
  });
  assert.ok(r.ok, !r.ok ? r.message : "");
});

test("one good section carries a run even if another has no items", () => {
  const r = validateEntryPointResult("append", {
    sections: [{ title: "Heading only" }, { title: "Real", items: [ITEM] }],
  });
  assert.ok(r.ok, !r.ok ? r.message : "");
  assert.equal(r.ok && r.itemCount, 1);
});
