import { test } from "node:test";
import assert from "node:assert/strict";
import { auditNote, recordSpan, privateRegions, factTokens, noteBlockMessage } from "./notes-provenance.ts";

// Two communities in ONE chunk. Only Alpha carries a genuine directive; Beta's
// only "private" is a floor plan.
const CHUNK = `Alpha Manor — Novato
 Community Phone: (415) 111-2222
 Private note: Director plans to retire next year.
 Assisted Living
 - Studio - $4,000/month

Beta Gardens — Napa
 Community Phone: (707) 333-4444
 Memory Care - Private Studio - $8,750/month
 Current assisted-living waitlist.
 Community Fee: $5,000`;

const ALPHA = () => recordSpan(CHUNK, "Alpha Manor — Novato", ["Beta Gardens — Napa"]);
const BETA  = () => recordSpan(CHUNK, "Beta Gardens — Napa", ["Alpha Manor — Novato"]);

test("1. ONE COMMUNITY'S DIRECTIVE DOES NOT AUTHORISE ITS NEIGHBOUR", () => {
  const a = ALPHA(), b = BETA();
  assert.ok(a && b, "a record span could not be derived");
  assert.ok(a!.includes("Private note"), "Alpha's span lost its directive");
  assert.ok(!b!.includes("Private note"), "BETA'S SPAN SWALLOWED ALPHA'S DIRECTIVE — scoping is broken");
  // Beta tries to hide the waitlist. It has no directive of its own.
  const v = auditNote("Current assisted-living waitlist.", b);
  assert.equal(v.ok, false, "Beta was authorised by Alpha's directive");
  assert.equal(v.reason, "no_private_source");
  // Alpha's own note is fine.
  assert.equal(auditNote("Director plans to retire next year.", a).ok, true);
});

test("2. 'Private Studio' / 'Private Room' ARE NEVER PRIVACY EVIDENCE", () => {
  for (const floorplan of [
    "Memory Care - Private Studio - $8,750/month",
    "Assisted Living - Private Room - $10,000-$15,000/month",
    "Private (Main Building) - $8,500/month",
    "Residents enjoy private or semi-private accommodations, chef-prepared meals",
    "Private studio apartment - Starting at $8,000/month",
  ]) {
    assert.deepEqual(privateRegions(floorplan), [],
      `a floor plan was treated as a privacy directive: ${floorplan}`);
  }
  // And so the note is refused.
  assert.equal(auditNote("anything", BETA()).reason, "no_private_source");
});

test("3. A NOTE MIXING PRIVATE AND ORDINARY CONTENT BLOCKS", () => {
  // The founder's example: one real directive, then two client-facing facts
  // piled into the same notes field.
  const mixed = "Director plans to retire next year. Current assisted-living waitlist. Community fee: $5,000.";
  const v = auditNote(mixed, ALPHA());
  assert.equal(v.ok, false, "ordinary facts rode in on a genuine directive");
  assert.equal(v.reason, "unsupported_content");
  for (const token of ["waitlist", "community", "5000"]) {
    assert.ok(v.unsupported.includes(token), `"${token}" was treated as private; got ${JSON.stringify(v.unsupported)}`);
  }
  assert.ok(!v.unsupported.includes("director"), "the genuinely private part was reported as unsupported");
});

test("4. A NOTE FULLY SUPPORTED BY THE PRIVATE REGION PASSES", () => {
  assert.equal(auditNote("Director plans to retire next year.", ALPHA()).ok, true);
  // Light rephrasing must not false-block — the check is on fact-bearing
  // tokens, not on an exact string.
  assert.equal(auditNote("Director plans to retire, next year.", ALPHA()).ok, true);
  assert.equal(auditNote("", ALPHA()).ok, true, "an empty note was blocked");
  assert.equal(auditNote("   ", ALPHA()).reason, "empty");
});

test("5. PROVENANCE FAILURE FAILS CLOSED", () => {
  assert.equal(recordSpan(CHUNK, "A Community Not In This Chunk", []), null);
  const v = auditNote("something private", null);
  assert.equal(v.ok, false, "an underivable span silently authorised a note");
  assert.equal(v.reason, "no_provenance");
});

test("the private region is BOUNDED — it stops at a blank line or a new field", () => {
  const span = `Somewhere
 Private note: the director is leaving.
 Community Fee: $5,000
 Waitlist: yes`;
  const regions = privateRegions(span);
  assert.equal(regions.length, 1);
  assert.ok(regions[0].includes("director is leaving"));
  assert.ok(!regions[0].includes("5,000"), "the region swallowed the next labelled field");
  assert.ok(!regions[0].includes("Waitlist"), "the region swallowed an unrelated field");
});

test("THE REAL COGIR CASE BLOCKS", () => {
  // Its source marks nothing private; the model made the waitlist and the
  // assessment requirement invisible to the client.
  const span = `Cogir of Vallejo Hills
Assisted Living
One Bedroom - from $4,900/month
Assisted Living rooms currently have a waitlist. Recent pricing shown.
Community Fee: Equal to one month's rent
Assisted Living based on level of care (assessment required)`;
  const v = auditNote("Assisted Living rooms currently have a waitlist. Recent pricing shown. Assisted Living based on level of care (assessment required)", span);
  assert.equal(v.ok, false, "the real contamination case passed");
  assert.equal(v.reason, "no_private_source");
});

test("fact tokens ignore filler and keep figures", () => {
  const t = factTokens("The waitlist is currently $5,000 and the fee has been set");
  assert.ok(t.includes("waitlist"));
  assert.ok(t.includes("5000"), `figures lost: ${JSON.stringify(t)}`);
  for (const stop of ["the", "is", "and", "has", "been", "currently"]) assert.ok(!t.includes(stop));
});

test("the message says which parts are the problem", () => {
  const v = auditNote("Director retires. Waitlist open.", ALPHA());
  assert.match(noteBlockMessage("Alpha Manor", v), /Alpha Manor/);
  assert.match(noteBlockMessage("Alpha Manor", v), /waitlist/i);
  assert.match(noteBlockMessage("X", { ok: false, reason: "no_private_source", unsupported: [] }), /never marks as private/i);
  assert.match(noteBlockMessage("X", { ok: false, reason: "no_provenance", unsupported: [] }), /couldn't match this record/i);
});

// ---------------------------------------------------------------------------
// WIRING — all three surfaces, and which one is the boundary
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const bodyOf = (p: string) => readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("SAVE RE-DERIVES THE SPAN AND RE-CHECKS — it does not trust noteWarnings", () => {
  const save = bodyOf("src/app/api/library/import/[runId]/save/route.ts");
  assert.match(save, /auditProposalNote\(withProvenance, allProposals as never, provenanceChunks\)/,
    "save does not re-audit notes from source");
  // ...and the chunks it audits against exclude any produced by a record the
  // source cannot confirm, re-derived here rather than read off the payload.
  assert.match(save, /withoutAmbiguousChunks\(chunkTexts, unresolvedOrdinals\(allProposals as never, fullSource\)\)/,
    "save audits notes against a chunk an unconfirmable record may own");
  assert.match(save, /outcome: "private_note_unverified"/, "a blocked note is not distinguishable");
  assert.ok(!/noteWarnings/.test(save),
    "save reads the stored note warnings — clearing them would bypass the gate");
});

test("save loads EVERY proposal, because a span ends where the neighbour begins", () => {
  const save = bodyOf("src/app/api/library/import/[runId]/save/route.ts");
  assert.match(save, /select\("ordinal, payload"\)\.eq\("run_id", runId\)/,
    "save only sees the selected proposals, so a record's boundary is unknown");
});

test("materialise and patch both surface note warnings", () => {
  assert.match(bodyOf("src/app/api/library/import/[runId]/proposals/route.ts"), /noteWarningsFor\(/);
  assert.match(bodyOf("src/app/api/library/import/[runId]/proposals/[id]/route.ts"), /noteWarningsFor\(/);
});
