// Fault injection is test scaffolding that ships in the source tree. These tests
// pin the property that matters: it CANNOT be activated in production, and a
// stray environment variable is not sufficient to activate it anywhere.
// Run: npx tsx --test src/lib/test-faults.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "fg-faults-"));
const specPath = join(dir, "faults.json");
const write = (o: unknown) => writeFileSync(specPath, JSON.stringify(o));

// A spec that WOULD fire: opted in, and targets ordinal 0 on its first attempt.
const LIVE_SPEC = { flowguideFaultInjection: true, failAttempts: { "0": 1 } };

// nextFault reads process.env on every call, so each case re-imports nothing and
// simply mutates the environment around the call.
const { nextFault, injectPrivateNote } = await import("./test-faults.ts");

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test("sanity: the spec DOES fire outside production with the env var and opt-in", () => {
  write(LIVE_SPEC);
  const f = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.ok(f, "fault should fire in development — otherwise the tests below prove nothing");
  assert.equal(f?.kind, "error");
});

test("PRODUCTION cannot activate faults even with the env var and a valid opted-in spec", () => {
  write(LIVE_SPEC);
  const f = withEnv({ NODE_ENV: "production", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f, null, "production must never return a fault");
});

test("production is refused for EVERY fault kind, not just the first branch", () => {
  const kinds = [
    { flowguideFaultInjection: true, failAttempts: { "0": 5 } },
    { flowguideFaultInjection: true, truncate: [0] },
    { flowguideFaultInjection: true, wrongShape: [0] },
    { flowguideFaultInjection: true, emptyResult: [0] },
    { flowguideFaultInjection: true, permanent: { "0": 402 } },
  ];
  for (const spec of kinds) {
    write(spec);
    const prod = withEnv({ NODE_ENV: "production", FLOWGUIDE_TEST_FAULT_FILE: specPath },
      () => nextFault("run-1", 0, 1));
    assert.equal(prod, null, `production must refuse ${JSON.stringify(spec)}`);
    // ...and the same spec is genuinely live outside production, so the null
    // above is the environment gate rather than an inert spec.
    const dev = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
      () => nextFault("run-1", 0, 1));
    assert.ok(dev, `spec should fire in development: ${JSON.stringify(spec)}`);
  }
});

test("an env var alone is not sufficient — the spec must explicitly opt in", () => {
  // Same faults, but without the opt-in key: a stray path at unrelated JSON.
  write({ failAttempts: { "0": 1 }, truncate: [0], permanent: { "0": 402 } });
  const f = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f, null, "a spec without flowguideFaultInjection:true must be ignored");

  write({ flowguideFaultInjection: "yes", failAttempts: { "0": 1 } });
  const truthy = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(truthy, null, "opt-in must be exactly true, not merely truthy");
});

test("no env var, missing file, and non-object specs all yield no faults", () => {
  assert.equal(withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: undefined },
    () => nextFault("run-1", 0, 1)), null, "no env var");
  assert.equal(withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: join(dir, "nope.json") },
    () => nextFault("run-1", 0, 1)), null, "missing file");
  writeFileSync(specPath, "not json at all");
  assert.equal(withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1)), null, "unparseable");
  write([1, 2, 3]);
  assert.equal(withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1)), null, "array is not a spec");
});

test("faults are scoped to a run id when one is given", () => {
  write({ ...LIVE_SPEC, runId: "run-A" });
  const hit = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-A", 0, 1));
  const miss = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-B", 0, 1));
  assert.ok(hit, "targeted run fires");
  assert.equal(miss, null, "other runs are untouched");
});

// Build-time elimination: the call site must compare NODE_ENV to the literal
// "production" so the bundler drops the branch from the production build. The
// runtime gate above is the backstop, not the only defence.
test("the chunk route guards the call site with a literal NODE_ENV comparison", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const route = readFileSync(join(root, "src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts"), "utf8");
  assert.match(
    route,
    /process\.env\.NODE_ENV === "production" \? null : nextFault\(/,
    "call site must be statically eliminable",
  );
});

// ---------------------------------------------------------------------------
// privateNote: the forced unauthorized private placement.
//
// This one exists because the prompt fix worked - the model no longer routes
// recipient-intended prose into the private field on demand, so the behaviour
// the semantic contract is built to catch cannot be summoned from a provider.
// It is held to exactly the same inertness rule as every other fault.
// ---------------------------------------------------------------------------

test("privateNote fires outside production and carries its text", () => {
  write({ flowguideFaultInjection: true, privateNote: { "0": "held prose" } });
  const f = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f?.kind, "privateNote");
  assert.equal((f as { text: string }).text, "held prose");
});

test("privateNote is INERT in production", () => {
  write({ flowguideFaultInjection: true, privateNote: { "0": "held prose" } });
  const f = withEnv({ NODE_ENV: "production", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f, null, "a private-note fault fired in production");
});

test("privateNote is inert without the explicit opt-in key", () => {
  write({ privateNote: { "0": "held prose" } });
  const f = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f, null, "a spec without flowguideFaultInjection was honoured");
});

test("an empty note is not a fault", () => {
  // Otherwise a half-written spec would silently mark an item with nothing.
  write({ flowguideFaultInjection: true, privateNote: { "0": "" } });
  const f = withEnv({ NODE_ENV: "development", FLOWGUIDE_TEST_FAULT_FILE: specPath },
    () => nextFault("run-1", 0, 1));
  assert.equal(f, null);
});

test("the injection marks the first item and changes nothing else", () => {
  const before = { sections: [{ title: "S", items: [{ title: "A" }, { title: "B" }] }] };
  const after = injectPrivateNote(structuredClone(before), "held prose") as typeof before & {
    sections: { items: { notes?: string }[] }[] };
  assert.equal(after.sections[0].items[0].notes, "held prose");
  assert.equal(after.sections[0].items[1].notes, undefined, "a second item was marked too");
  assert.equal(after.sections[0].items[0].title, "A", "the item's own content was altered");
});

test("the injection is a no-op when there is no item to mark", () => {
  assert.deepEqual(injectPrivateNote({ sections: [] }, "x"), { sections: [] });
  assert.deepEqual(injectPrivateNote({}, "x"), {});
});

test("the route applies the injection behind a literal NODE_ENV comparison", () => {
  // Same discipline as the fault lookup itself: the bundler must be able to
  // eliminate the whole branch from the production build, so the comparison has
  // to be literal rather than routed through a helper.
  const route = readFileSync(
    "src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts", "utf8");
  assert.match(route,
    /process\.env\.NODE_ENV !== "production" && fault\?\.kind === "privateNote"/,
    "the private-note injection is not guarded by a literal NODE_ENV comparison");
});
