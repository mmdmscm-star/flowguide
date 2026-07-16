// Focused tests for the single-flight mutation runner (R2-A overlapping-mutation
// safety). Run: node --test src/lib/serial-mutation.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SerialMutations } from "./serial-mutation.ts";

type S = string[];

function harness(initial: S) {
  let state: S = initial;
  const r = new SerialMutations<S>(initial, (s) => { state = s; }, () => {});
  return { r, state: () => state, saved: () => r.getSaved() };
}

const ok = async () => {};
const fail = async () => { throw new Error("boom"); };

test("commit on success — state and persisted baseline match", async () => {
  const h = harness(["a"]);
  assert.equal(await h.r.run(["a", "b"], ok), "ok");
  assert.deepEqual(h.state(), ["a", "b"]);
  assert.deepEqual(h.saved(), ["a", "b"]);
});

test("rollback on failure — reverts to last persisted, error surfaced", async () => {
  const h = harness(["a"]);
  assert.equal(await h.r.run(["a", "b"], fail), "failed");
  assert.deepEqual(h.state(), ["a"]);
  assert.deepEqual(h.saved(), ["a"]);
});

test("single-flight — an overlapping mutation is rejected and never applied", async () => {
  const h = harness(["a"]);
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const p1 = h.r.run(["a", "b"], () => gate);            // stays pending
  const r2 = await h.r.run(["a", "b", "c"], ok);          // attempted during p1
  assert.equal(r2, "rejected");
  release();
  assert.equal(await p1, "ok");
  assert.deepEqual(h.saved(), ["a", "b"]);                // only p1 committed
});

test("rapid reorder then heading edit — edit rejected while reorder pending, applies after", async () => {
  const h = harness(["a", "b"]);
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const reorder = h.r.run(["b", "a"], () => gate);        // reorder pending
  assert.equal(await h.r.run(["b", "a", "edited"], ok), "rejected");
  release();
  assert.equal(await reorder, "ok");
  assert.equal(await h.r.run(["b", "a-edited"], ok), "ok");
  assert.deepEqual(h.saved(), ["b", "a-edited"]);
});

test("edit then immediate delete — serialized, both persist in order", async () => {
  const h = harness(["h", "i"]);
  assert.equal(await h.r.run(["h2", "i"], ok), "ok");     // edit heading text
  assert.equal(await h.r.run(["i"], ok), "ok");           // delete the heading
  assert.deepEqual(h.saved(), ["i"]);                     // adjacent item "i" kept
});

test("failed request then successful request — failure rolls back, success wins, no clobber", async () => {
  const h = harness(["a"]);
  assert.equal(await h.r.run(["a", "x"], fail), "failed");
  assert.deepEqual(h.saved(), ["a"]);                     // rolled back
  assert.equal(await h.r.run(["a", "y"], ok), "ok");      // newer success
  assert.deepEqual(h.state(), ["a", "y"]);
  assert.deepEqual(h.saved(), ["a", "y"]);                // final = successful
});

test("add pattern — save produces the definitive state (real id known after server)", async () => {
  const h = harness(["a"]);
  assert.equal(await h.r.run(null, async () => ["a", "new-id"]), "ok");
  assert.deepEqual(h.state(), ["a", "new-id"]);
  assert.deepEqual(h.saved(), ["a", "new-id"]);
});
