// THE DESTINATION GUARD.
//
// Enforcement strips content it cannot place and holds it for a decision. That
// is only safe where the held unit is surfaced, which today is the packet path
// alone. These tests exist so that "enforcement reaches the Library" is a test
// failure rather than a discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  enforcementScope, enforceChunkResult,
  ENFORCED_DESTINATIONS, KNOWN_DESTINATIONS,
} from "./enforce-chunk.ts";

const read = (p: string) => readFileSync(p, "utf8");

const SOURCE = [
  "1. Alpha House", "Phone: (206) 555-0101", "alphahouse.com",
  "", "2. Beta Place", "Phone: (206) 555-0102", "betaplace.com",
  "", "3. Gamma Court", "Phone: (206) 555-0103", "gammacourt.com",
].join("\n");
const NOTE = "They are wonderful with families and will meet you on a weekend.";
const modelResult = () => ({
  sections: [{ title: "S", items: [
    { title: "Alpha House", description: "A.", notes: NOTE,
      details: [{ label: "Phone", value: "(206) 555-0101" }],
      links: [{ label: "Website", url: "https://alphahouse.com" }] },
    { title: "Beta Place", description: "B.",
      details: [{ label: "Phone", value: "(206) 555-0102" }],
      links: [{ label: "Website", url: "https://betaplace.com" }] },
    { title: "Gamma Court", description: "C.",
      details: [{ label: "Phone", value: "(206) 555-0103" }],
      links: [{ label: "Website", url: "https://gammacourt.com" }] },
  ] }],
});
const run = (destination: unknown) => {
  const prev = process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  try {
    return enforceChunkResult({
      segmentText: SOURCE, chunkOrdinal: 0, sourceStart: 0, sourceText: SOURCE,
      result: modelResult(), runId: "run-1", destination: destination as string,
    });
  } finally {
    if (prev === undefined) delete process.env.FLOWGUIDE_ENFORCE_CONTRACT;
    else process.env.FLOWGUIDE_ENFORCE_CONTRACT = prev;
  }
};

test("scope: packet is enforced, library is out of scope, anything else unsupported", () => {
  assert.equal(enforcementScope("packet"), "enforced");
  assert.equal(enforcementScope("library"), "out-of-scope");
  // Never guessed. A destination nobody has decided about is not assumed to
  // behave like a packet just because packet is the common case.
  for (const d of [null, undefined, "", "PACKET", "packets", "crm", "email"]) {
    assert.equal(enforcementScope(d), "unsupported", `${String(d)} was not treated as unsupported`);
  }
});

test("sanity: a packet run DOES enforce — otherwise the tests below prove nothing", () => {
  const e = run("packet");
  assert.equal(e.telemetry.scope, "enforced");
  assert.equal(e.telemetry.privacyRejected, 1, "the unauthorized note was not rejected");
  assert.equal(e.reviewUnits.length, 1);
});

test("a library run is returned BYTE-IDENTICAL", () => {
  const before = modelResult();
  const e = run("library");
  assert.equal(e.telemetry.scope, "out-of-scope");
  // Not "mostly unchanged" — the same JSON. Any strip, canonicalization or
  // reordering would show up here.
  assert.deepEqual(e.result, before);
  assert.equal((e.result as typeof before).sections[0].items[0].notes, NOTE,
    "the Library note was altered");
});

test("a library run creates no review state of any kind", () => {
  const e = run("library");
  assert.deepEqual(e.reviewUnits, [], "review units were created for a Library run");
  assert.deepEqual(e.unresolved, [], "units were held for a Library run");
  assert.equal(e.telemetry.privacyRejected, 0);
  assert.equal(e.telemetry.stripped, 0);
  assert.equal(e.telemetry.itemsGoverned, 0, "a Library item was governed");
});

test("an unknown or missing destination does not enforce either", () => {
  for (const d of [null, undefined, "crm"]) {
    const e = run(d);
    assert.equal(e.telemetry.scope, "unsupported", `${String(d)} enforced`);
    assert.deepEqual(e.result, modelResult());
    assert.deepEqual(e.reviewUnits, []);
    assert.equal(e.telemetry.itemsGoverned, 0);
  }
});

test("declining is RECORDED, not silent", () => {
  // An absent telemetry block and a deliberate refusal look identical in the
  // evidence unless the refusal says so.
  assert.equal(run("library").telemetry.scope, "out-of-scope");
  assert.equal(run("crm").telemetry.scope, "unsupported");
});

test("the known destinations match what the database actually allows", () => {
  // 0020 constrains ingestion_runs.destination. If a third value is ever added
  // there, this fails — which is the point: a new destination must be an
  // explicit decision here, not an inheritance of packet behaviour.
  const m = read("supabase/migrations/0020_ingestion_run_destination.sql");
  const c = /check \(destination in \(([^)]*)\)\)/.exec(m);
  assert.ok(c, "could not find the destination check constraint");
  const allowed = [...c![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...KNOWN_DESTINATIONS].sort(), allowed,
    `the database allows ${allowed.join(", ")}`);
  assert.deepEqual([...ENFORCED_DESTINATIONS], ["packet"]);
});

test("the route passes the persisted destination and does not derive one", () => {
  const r = read("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");
  assert.match(r, /destination: run\.destination as string \| null/,
    "the route no longer passes the persisted destination");
  const code = r.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  // A second opinion about a fact the database already holds is how the two
  // come to disagree exactly when it matters.
  assert.doesNotMatch(code, /destination:\s*(packetId|run\.packet_id|.*\?\s*"packet")/,
    "the route derives a destination instead of reading it");
});

test("destination is a REQUIRED argument, so a new call site cannot omit it", () => {
  const src = read("src/lib/enforce-chunk.ts");
  const sig = src.slice(src.indexOf("export function enforceChunkResult"));
  const opts = sig.slice(0, sig.indexOf("}): ChunkEnforcement"));
  assert.match(opts, /destination: string \| null \| undefined;/);
  assert.doesNotMatch(opts, /destination\?:/, "destination became optional");
});

test("scope is decided before the fail-closed hook, so a library run cannot fail its chunk", () => {
  const src = read("src/lib/enforce-chunk.ts");
  const body = src.slice(src.indexOf("export function enforceChunkResult"));
  assert.ok(body.indexOf("const scope = enforcementScope(destination)") < body.indexOf("maybeThrowForTest()"),
    "the fail-closed hook runs before the scope check");
});
