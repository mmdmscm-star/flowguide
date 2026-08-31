// WHAT A DROP MEANS — every edge of it, without pretending to be a pointer.
//
// The gesture is the easy half. The half worth testing is what a drop RESOLVES
// TO: which container, which neighbour, which side of it, and the drops that
// must be refused rather than interpreted. None of that should only be
// reachable by simulating pointer events in jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { containerKey, dragId, parseDragId, planDrop, type DropContext } from "./library-drag.ts";

// Two sections. S1 has G1 and G2 and some loose rows; S2 has loose rows.
const SECTIONS = [{ id: "S1" }, { id: "S2" }];
const GROUPS = [
  { id: "G1", sectionId: "S1" },
  { id: "G2", sectionId: "S1" },
  { id: "G9", sectionId: "S2" },
];
const PLACES: Array<[string, string | null, string | null]> = [
  ["a", "S1", "G1"], ["b", "S1", "G1"], ["c", "S1", "G1"],
  ["p", "S1", null], ["q", "S1", null],
  ["z", "S2", null],
  ["u1", null, null], ["u2", null, null],          // the unorganized remainder
];
function ctx(): DropContext {
  const placeOf = new Map(PLACES.map(([id, s, g]) => [id, { sectionId: s, groupId: g }]));
  const rowOrder = new Map<string, string[]>();
  for (const [id, s, g] of PLACES) {
    const k = containerKey(s, g);
    rowOrder.set(k, [...(rowOrder.get(k) ?? []), id]);
  }
  return { placeOf, rowOrder, sections: SECTIONS, groups: GROUPS };
}
const plan = (from: string, to: string | null) =>
  planDrop(from, to, ctx());
const payload = (from: string, to: string) => {
  const p = plan(from, to);
  assert.ok(p && p.kind === "move", `expected a move, got ${JSON.stringify(p)}`);
  return (p as { payload: Record<string, unknown> }).payload;
};

test("ids round-trip, and anything else is not a drag id", () => {
  assert.equal(dragId("item", "x"), "item:x");
  assert.deepEqual(parseDragId("group:G1"), { kind: "group", id: "G1" });
  // A uuid contains no colon-prefixed kind; a bare id is not addressable.
  for (const bad of ["", "x", "nope:1", "item:", null, undefined, 7])
    assert.equal(parseDragId(bad), null, `${String(bad)} was read as a drag id`);
});

// ---------------------------------------------------------------------------
// ITEMS
// ---------------------------------------------------------------------------

test("SAME CONTAINER: dragging down lands AFTER, dragging up lands BEFORE", () => {
  // The neighbour, and which side of it — not an index, and not an order.
  assert.deepEqual(payload(dragId("item", "a"), dragId("item", "c")),
    { kind: "item", id: "a", sectionId: "S1", groupId: "G1", after: "c" });
  assert.deepEqual(payload(dragId("item", "c"), dragId("item", "a")),
    { kind: "item", id: "c", sectionId: "S1", groupId: "G1", before: "a" });
  // Adjacent rows are the same rule, which is what makes Move up/down the same
  // operation as a one-row drag.
  assert.deepEqual(payload(dragId("item", "a"), dragId("item", "b")),
    { kind: "item", id: "a", sectionId: "S1", groupId: "G1", after: "b" });
});

test("CROSS CONTAINER: a row dropped on a row takes that row's place", () => {
  // There is no "down" between containers, so it goes before the neighbour and
  // pushes it along — which is what the insertion line showed.
  assert.deepEqual(payload(dragId("item", "a"), dragId("item", "q")),
    { kind: "item", id: "a", sectionId: "S1", groupId: null, before: "q" });
  assert.deepEqual(payload(dragId("item", "a"), dragId("item", "z")),
    { kind: "item", id: "a", sectionId: "S2", groupId: null, before: "z" });
});

test("ONTO A SECTION HEADING: loose in that section, at the true end, group CLEARED", () => {
  const p = payload(dragId("item", "a"), dragId("section", "S2"));
  assert.deepEqual(p, { kind: "item", id: "a", sectionId: "S2", groupId: null });
  // No neighbour at all — the server appends to the end of the stored
  // container, which is not the end of whatever page was loaded.
  assert.ok(!("before" in p) && !("after" in p), "a heading drop named a neighbour");
  assert.equal(p.groupId, null, "the old group survived a move to a Section");
});

test("ONTO A GROUP HEADING: into that group, at the true end, section inferred", () => {
  const p = payload(dragId("item", "a"), dragId("group", "G2"));
  assert.deepEqual(p, { kind: "item", id: "a", sectionId: "S1", groupId: "G2" });
  // A group in ANOTHER section carries that section with it — the destination
  // is the group, and its section is whatever the group's section is.
  assert.deepEqual(payload(dragId("item", "a"), dragId("group", "G9")),
    { kind: "item", id: "a", sectionId: "S2", groupId: "G9" });
  assert.ok(!("before" in p) && !("after" in p), "a heading drop named a neighbour");
});

test("UNORGANIZED IS NOT A DESTINATION, and not a sequence", () => {
  // Newest-first by design. Dropping into it would be asking for an order it
  // does not have.
  const into = plan(dragId("item", "a"), dragId("item", "u1"));
  assert.equal(into?.kind, "refused");
  assert.match((into as { message: string }).message, /newest first/i);
  // And dragging OUT of it is deferred rather than guessed — Move… does it.
  const outOf = plan(dragId("item", "u1"), dragId("item", "a"));
  assert.equal(outOf?.kind, "refused");
  assert.match((outOf as { message: string }).message, /Move…/);
});

// ---------------------------------------------------------------------------
// SECTIONS AND GROUPS
// ---------------------------------------------------------------------------

test("SECTIONS reorder against the whole sibling list", () => {
  assert.deepEqual(payload(dragId("section", "S1"), dragId("section", "S2")),
    { kind: "section", id: "S1", after: "S2" });
  assert.deepEqual(payload(dragId("section", "S2"), dragId("section", "S1")),
    { kind: "section", id: "S2", before: "S1" });
});

test("GROUPS reorder inside their own section, and REFUSE to leave it", () => {
  assert.deepEqual(payload(dragId("group", "G1"), dragId("group", "G2")),
    { kind: "group", id: "G1", after: "G2" });
  // G9 is in S2. Dragging G1 onto it is a section change wearing a drag's
  // clothes, and it moves everything inside the group.
  const across = plan(dragId("group", "G1"), dragId("group", "G9"));
  assert.equal(across?.kind, "refused");
  assert.match((across as { message: string }).message, /inside its own section/i);
});

test("MIXED KINDS are not interpreted", () => {
  // A section dropped on a group, or a group on a section, means nothing —
  // and guessing what it might have meant is how a drag moves the wrong thing.
  assert.equal(plan(dragId("section", "S1"), dragId("group", "G1")), null);
  assert.equal(plan(dragId("group", "G1"), dragId("section", "S1")), null);
  assert.equal(plan(dragId("item", "a"), dragId("item", "a")), null, "dropped on itself");
  assert.equal(plan(dragId("item", "a"), null), null, "dropped on nothing");
});

test("NO ORDER IS EVER SENT — only one thing and at most one neighbour", () => {
  // The property the paged Library depends on. If a payload ever carried a
  // list, the loaded page would be posing as the container.
  const every = [
    payload(dragId("item", "a"), dragId("item", "c")),
    payload(dragId("item", "a"), dragId("section", "S2")),
    payload(dragId("item", "a"), dragId("group", "G2")),
    payload(dragId("section", "S1"), dragId("section", "S2")),
    payload(dragId("group", "G1"), dragId("group", "G2")),
  ];
  for (const p of every) {
    assert.ok(!("orderedIds" in p) && !("ids" in p), `a payload carried a list: ${JSON.stringify(p)}`);
    assert.ok(!Object.values(p).some(Array.isArray), `a payload carried an array: ${JSON.stringify(p)}`);
    const neighbours = ["before", "after"].filter((k) => k in p);
    assert.ok(neighbours.length <= 1, `two neighbours in ${JSON.stringify(p)}`);
    assert.ok(!("p_owner" in p) && !("userId" in p), "the client named an owner");
  }
});

test("a container the client has only partly loaded still resolves a neighbour", () => {
  // The rowOrder map holds LOADED rows. Whether "a" is above "c" is used only
  // to pick a side; the identity of the neighbour is what the server acts on,
  // and it reads the whole container to place it.
  const partial: DropContext = {
    ...ctx(),
    rowOrder: new Map([[containerKey("S1", "G1"), ["b", "c"]]]),   // "a" not loaded
  };
  const p = planDrop(dragId("item", "a"), dragId("item", "c"), partial);
  assert.ok(p && p.kind === "move");
  const payloadOut = (p as { payload: Record<string, unknown> }).payload;
  assert.equal(payloadOut.id, "a");
  assert.ok("before" in payloadOut || "after" in payloadOut, "no neighbour was named");
  assert.equal(payloadOut.sectionId, "S1");
});
