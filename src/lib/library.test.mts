// Library save-back decisions. Run: node --test src/lib/library.test.mts
//
// The scenario these exist for, using the founder's own example: a Library entry
// for a senior-living community carries AL studio/1BR/2BR pricing, memory-care
// pricing, a second-person fee and a pet fee. One client packet keeps only
// 2BR + second-person + pet; another keeps only memory care. Both are correct —
// the Library entry is the reusable base, the packet copy is an
// audience-specific communication.
//
// Two ways a replacement destroys work silently, and both are ordinary:
//   TAILORED  — the descendant was pruned, so replacing deletes the rest.
//   STALE     — the ancestor was edited after this copy was taken, so replacing
//               overwrites those newer edits with older-derived values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffItemContent, decideSaveBack, type LibraryAncestry } from "./library.ts";
import type { ItemContentPayload } from "./item-content.ts";

/** The comprehensive reusable base. */
const BASE: ItemContentPayload = {
  title: "Brookdale Chanate",
  address: "3800 Chanate Rd",
  description: "Assisted living and memory care.",
  notes: "",
  details: [
    { label: "AL Studio", value: "$4,500" },
    { label: "AL 1BR", value: "$5,200" },
    { label: "AL 2BR", value: "$6,100" },
    { label: "Memory Care", value: "$7,000" },
    { label: "Second person fee", value: "$900" },
    { label: "Pet fee", value: "$500" },
  ],
  links: [{ url: "https://example.invalid/chanate", label: "Website" }],
  photos: [{ url: "https://cdn.example.invalid/a.jpg" }, { url: "https://cdn.example.invalid/b.jpg" }],
  contacts: [{ name: "Dana Reed", role: "Director", phone: "555-0100" }],
};

/** What one client actually needs: 2BR + second person + pet. */
const TAILORED: ItemContentPayload = {
  ...BASE,
  details: [
    { label: "AL 2BR", value: "$6,100" },
    { label: "Second person fee", value: "$900" },
    { label: "Pet fee", value: "$500" },
  ],
};

const ancestry = (over: Partial<LibraryAncestry> = {}): LibraryAncestry => ({
  libraryItemId: "lib-1", copiedFromRevision: 1, currentRevision: 1, ...over,
});

// ---------------------------------------------------------------------------
// The diff itself
// ---------------------------------------------------------------------------
test("a tailored descendant reports the pruned entries as REMOVALS, by label", () => {
  const d = diffItemContent(BASE, TAILORED);
  const details = d.fields.find((f) => f.field === "details")!;
  assert.deepEqual(details.removed, ["AL Studio", "AL 1BR", "Memory Care"]);
  assert.deepEqual(details.added, []);
  assert.equal(d.hasRemovals, true);
  assert.equal(d.hasChanges, true);
});

test("direction is not symmetric — the reverse reads as additions, not removals", () => {
  // Inserting the base over a tailored ancestor ADDS; it destroys nothing.
  const d = diffItemContent(TAILORED, BASE);
  const details = d.fields.find((f) => f.field === "details")!;
  assert.deepEqual(details.added, ["AL Studio", "AL 1BR", "Memory Care"]);
  assert.equal(d.hasRemovals, false);
});

test("a changed price at the same label is a change, not an add plus a remove", () => {
  const raised = { ...BASE, details: BASE.details!.map((x) =>
    x.label === "AL 2BR" ? { ...x, value: "$6,400" } : x) };
  const d = diffItemContent(BASE, raised);
  const details = d.fields.find((f) => f.field === "details")!;
  assert.deepEqual(details.changed, ["AL 2BR"]);
  assert.deepEqual(details.removed, []);
  assert.equal(d.hasRemovals, false);
});

test("an identical copy reports no changes at all", () => {
  const d = diffItemContent(BASE, { ...BASE });
  assert.equal(d.hasChanges, false);
  assert.equal(d.hasRemovals, false);
});

// ---------------------------------------------------------------------------
// The four cases the founder asked to be pinned
// ---------------------------------------------------------------------------
test("1. UNCHANGED ancestor, no removals — the normal update confirmation", () => {
  const improved = { ...BASE, description: "Assisted living, memory care, respite." };
  const decision = decideSaveBack(ancestry(), diffItemContent(BASE, improved));

  assert.equal(decision.primary, "update", "replacement is the natural default here");
  assert.equal(decision.ancestorMovedOn, false);
  assert.equal(decision.wouldRemoveContent, false);
  assert.deepEqual(decision.warnings, [], "nothing to warn about");
});

test("2. INDEPENDENTLY CHANGED ancestor — the confirmation must say so", () => {
  // Inserted at revision 1; the Library entry has since been edited to 3.
  // Replacing would overwrite those newer edits with values derived from rev 1.
  const improved = { ...BASE, description: "Assisted living, memory care, respite." };
  const decision = decideSaveBack(
    ancestry({ copiedFromRevision: 1, currentRevision: 3 }),
    diffItemContent(BASE, improved),
  );

  assert.equal(decision.ancestorMovedOn, true);
  assert.ok(decision.warnings.includes("ancestor_moved_on"),
    "the professional must be told the Library moved on since they inserted this");
  assert.equal(decision.primary, "update", "still offered — but never silently");
  assert.ok(decision.secondary.includes("save_as_new"));
});

test("3. REPLACE ANYWAY stays available when the descendant was pruned", () => {
  const decision = decideSaveBack(ancestry(), diffItemContent(BASE, TAILORED));

  assert.equal(decision.wouldRemoveContent, true);
  assert.equal(decision.primary, "save_as_new",
    "replacement must NOT be the default when it would delete reusable content");
  assert.ok(decision.secondary.includes("update"),
    "but it remains an explicit professional decision — they may have pruned something obsolete");
  assert.ok(decision.warnings.includes("removals"));
});

test("4. SAVE AS NEW is the default when a pruned descendant meets a moved-on ancestor", () => {
  // The worst combination: stale AND tailored.
  const decision = decideSaveBack(
    ancestry({ copiedFromRevision: 1, currentRevision: 4 }),
    diffItemContent(BASE, TAILORED),
  );

  assert.equal(decision.primary, "save_as_new");
  assert.equal(decision.ancestorMovedOn, true);
  assert.equal(decision.wouldRemoveContent, true);
  assert.ok(decision.warnings.includes("removals"));
  assert.ok(decision.warnings.includes("ancestor_moved_on"),
    "both facts must reach the confirmation, not just the louder one");
});

// ---------------------------------------------------------------------------
// Ancestry edge cases
// ---------------------------------------------------------------------------
test("a deleted ancestor offers a NEW entry and never resurrects the old one", () => {
  const decision = decideSaveBack(
    ancestry({ libraryItemId: null, copiedFromRevision: 2, currentRevision: null }),
    diffItemContent(BASE, TAILORED),
  );
  assert.equal(decision.primary, "save_new_ancestor_gone");
  assert.deepEqual(decision.secondary, [], "there is nothing to update");
  assert.deepEqual(decision.warnings, ["ancestor_deleted"]);
});

test("an unchanged descendant offers nothing to do", () => {
  const decision = decideSaveBack(ancestry(), diffItemContent(BASE, { ...BASE }));
  assert.equal(decision.primary, "none");
  assert.ok(decision.warnings.includes("no_changes"));
});

test("an unchanged descendant of a moved-on ancestor still says the Library moved", () => {
  // Nothing to push, but the professional may want to know their copy is old.
  const decision = decideSaveBack(
    ancestry({ copiedFromRevision: 1, currentRevision: 5 }),
    diffItemContent(BASE, { ...BASE }),
  );
  assert.equal(decision.primary, "none");
  assert.equal(decision.ancestorMovedOn, true);
  assert.ok(decision.warnings.includes("ancestor_moved_on"));
});

test("a missing recorded revision never fabricates a moved-on warning", () => {
  // Pre-0017 rows, or a descendant whose lineage predates revision tracking.
  const decision = decideSaveBack(
    ancestry({ copiedFromRevision: null, currentRevision: 7 }),
    diffItemContent(BASE, { ...BASE, notes: "toured 3 Sep" }),
  );
  assert.equal(decision.ancestorMovedOn, false,
    "unknown is not the same as changed — do not warn on an absence");
  assert.equal(decision.primary, "update");
});
