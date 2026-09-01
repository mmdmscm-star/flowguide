// COMPOSING A FLOWGUIDE FROM LIBRARY MATERIAL.
//
// The gesture looks exactly like the Library's own drag and means the opposite
// thing: inside the Library a drag MOVES the master, and out of it a drag
// COPIES a snapshot. These tests are about the second one, and they are in
// their own file for the same reason the planner is in its own module — the day
// the two share a rule is the day a copy becomes a move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCompose, libDragId, parseComposeId, planCompose, trayDragId, TRAY_END,
} from "./compose-drag.ts";

/** Source with comments removed.
 *
 *  These modules explain themselves at length, and the explanations legitimately
 *  name the things the CODE must not do — "the master keeps its section, its
 *  labels" is the promise, not a violation of it. Asserting over raw text would
 *  make a file that documents its boundary fail for documenting it. */
const codeOf = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const tray = ["a", "b", "c"];
const plan = (from: string, to: string | null, t: string[] = tray) => planCompose(from, to, t);
const after = (from: string, to: string | null, t: string[] = tray) => applyCompose(t, plan(from, to, t));

test("ids name their side of the screen, and nothing else parses", () => {
  assert.deepEqual(parseComposeId(libDragId("x")), { zone: "lib", id: "x" });
  assert.deepEqual(parseComposeId(trayDragId("x")), { zone: "tray", id: "x" });
  assert.deepEqual(parseComposeId(TRAY_END), { zone: "end", id: "" });
  for (const bad of ["", "x", "lib:", "tray:", "item:x", "section:x", null, undefined, 3])
    assert.equal(parseComposeId(bad), null, `${String(bad)} was read as a compose id`);
});

// ---------------------------------------------------------------------------
// ADDING
// ---------------------------------------------------------------------------

test("a Library item dropped on an EMPTY tray becomes its first entry", () => {
  assert.deepEqual(plan(libDragId("z"), TRAY_END, []), { kind: "add", id: "z", index: 0 });
  assert.deepEqual(after(libDragId("z"), TRAY_END, []), ["z"]);
});

test("dropped BETWEEN two pending entries, it lands exactly there", () => {
  // On "b" means "take b's place and push it down" — what the insertion line
  // above b showed.
  assert.deepEqual(plan(libDragId("z"), trayDragId("b")), { kind: "add", id: "z", index: 1 });
  assert.deepEqual(after(libDragId("z"), trayDragId("b")), ["a", "z", "b", "c"]);
  // And on the first entry, it becomes the first.
  assert.deepEqual(after(libDragId("z"), trayDragId("a")), ["z", "a", "b", "c"]);
});

test("dropped on the tray ITSELF, it appends", () => {
  assert.deepEqual(after(libDragId("z"), TRAY_END), ["a", "b", "c", "z"]);
});

test("ONE COPY PER ITEM — the product's existing rule, kept", () => {
  // `chosen` was always a set: choosing something twice chose it once. A drag
  // of something already pending is not an error and not a duplicate.
  assert.equal(plan(libDragId("b"), TRAY_END), null);
  assert.equal(plan(libDragId("b"), trayDragId("a")), null);
  assert.deepEqual(after(libDragId("b"), trayDragId("a")), tray, "the tray changed");
  // Even if a plan were forged, applying it cannot duplicate.
  assert.deepEqual(applyCompose(tray, { kind: "add", id: "b", index: 0 }), tray);
});

// ---------------------------------------------------------------------------
// ARRANGING AND REMOVING
// ---------------------------------------------------------------------------

test("a pending entry reorders within the tray", () => {
  assert.deepEqual(after(trayDragId("c"), trayDragId("a")), ["c", "a", "b"]);
  assert.deepEqual(after(trayDragId("a"), trayDragId("c")), ["b", "c", "a"]);
  assert.deepEqual(after(trayDragId("a"), TRAY_END), ["b", "c", "a"], "dropped past the end");
  assert.equal(plan(trayDragId("a"), trayDragId("a")), null, "dropped on itself");
});

test("a pending entry dragged back over the Library does NOTHING", () => {
  // Dropping something "away" to delete it is a gesture people make by
  // accident. Removal is a button, on the row, that says so.
  assert.equal(plan(trayDragId("a"), libDragId("q")), null);
  assert.deepEqual(after(trayDragId("a"), libDragId("q")), tray);
});

test("removal is a list operation and touches nothing else", () => {
  // The tray is ids in order. Removing one leaves the rest in order, and there
  // is no Library call anywhere in this module to make.
  assert.ok(!/fetch\(|supabase|\/api\//.test(codeOf("./compose-drag.ts")),
    "the compose planner reaches the network or the database");
  assert.deepEqual(tray.filter((x) => x !== "b"), ["a", "c"]);
});

test("THE LIBRARY IS NEVER THE SUBJECT of a compose plan", () => {
  // Every plan names a tray operation. None of them can express a change to a
  // section, a group, a label or a favourite, because those words are not here.
  const src = codeOf("./compose-drag.ts");
  for (const forbidden of ["sectionId", "groupId", "labels", "isFavorite", "sort_order", "library_move"])
    assert.ok(!src.includes(forbidden),
      `the compose planner can express "${forbidden}", which belongs to MOVE`);
  for (const p of [
    plan(libDragId("z"), TRAY_END), plan(libDragId("z"), trayDragId("b")),
    plan(trayDragId("a"), trayDragId("c")),
  ]) {
    assert.ok(p && (p.kind === "add" || p.kind === "reorder"));
    assert.deepEqual(Object.keys(p).sort(), ["id", "index", "kind"]);
  }
});

test("the two planners are separate modules, and stay that way", () => {
  const compose = codeOf("./compose-drag.ts");
  const library = codeOf("./library-drag.ts");
  assert.ok(!compose.includes("library-drag"), "the compose planner imports the MOVE planner");
  assert.ok(!library.includes("compose-drag"), "the MOVE planner imports the compose planner");
});
