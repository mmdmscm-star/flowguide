import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChunkResponse, CHUNK_NETWORK_FAILURE } from "./chunk-outcome.ts";

const c = (status: number, ok: boolean, data: Record<string, unknown> = {}) =>
  classifyChunkResponse(status, ok, data);

test("the transient provider failure that halted the runtime proof is RETRIED", () => {
  // The exact body observed: a real OpenRouter hiccup on a split child.
  assert.deepEqual(
    c(502, false, { error: "chunk_failed", message: "AI service error. Please try again.", permanent: false }),
    { kind: "retry" });
  // ...and at any status, because `permanent` is the authoritative signal.
  assert.deepEqual(c(429, false, { error: "chunk_failed", permanent: false }), { kind: "retry" });
  assert.deepEqual(c(400, false, { error: "chunk_failed" }), { kind: "retry" },
    "an absent `permanent` is not a claim of permanence");
});

test("a PERMANENT provider rejection is fatal, not an endless retry", () => {
  const out = c(402, false, { error: "chunk_failed", message: "Out of credit.", permanent: true });
  assert.equal(out.kind, "fatal");
  assert.match((out as { message: string }).message, /Out of credit/);
});

test("a chunk that cannot be subdivided is fatal", () => {
  const out = c(422, false, { error: "cannot_subdivide", message: "A block is too large." });
  assert.equal(out.kind, "fatal");
});

test("platform failures are retried without consulting the body", () => {
  for (const s of [500, 502, 504]) assert.deepEqual(c(s, false, {}), { kind: "retry" });
});

test("success statuses map to their outcomes", () => {
  assert.deepEqual(c(200, true, { status: "split" }), { kind: "split" });
  assert.deepEqual(c(200, true, { status: "completed" }), { kind: "completed" });
  assert.deepEqual(c(200, true, { status: "processing" }), { kind: "retry" });
  assert.deepEqual(c(200, true, {}), { kind: "retry" },
    "an unrecognised success must loop, because stopping is unrecoverable and looping is not");
});

test("a run that is no longer active is fatal rather than retried forever", () => {
  const out = c(409, false, { error: "run_not_active", status: "discarded" });
  assert.equal(out.kind, "fatal");
});

test("a network failure is always retryable", () => {
  assert.deepEqual(CHUNK_NETWORK_FAILURE, { kind: "retry" });
});
