// A BARE HOSTNAME SHARING A LINE MUST STILL BE A CLAIM.
//
// Measured before this existed: a bare hostname sharing a line with other
// content survived 0 of 6 real imports and was lost in silence — not in links,
// not in contacts.website, not in details, not in the description. A
// scheme-qualified URL on the same kind of line survived 4 of 4. The asymmetry
// was RECOGNITION: the parser only claimed a bare hostname when it was the
// entire line, so nothing downstream knew the URL existed and nothing could
// report it missing.
//
// Everything after recognition already worked — reconcile routes a url claim to
// `links`, enforceItem materializes ACCEPTED and REPAIRED alike, and
// canonicalUrl supplies the missing scheme.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseClaims, bareHostnames } from "./claim-parser.ts";

const urls = (line: string) =>
  ((parseClaims(line, 0) as { claims: { kind: string; value: string }[] }).claims ?? [])
    .filter((c) => c.kind === "url").map((c) => c.value);

test("THE REGRESSION CASE — a bare hostname beside a contact", () => {
  // The exact shape found in the reliability run.
  const line = "riverbend.example.com | Booking: Nia Patel 646-555-0188";
  assert.deepEqual(urls(line), ["riverbend.example.com"]);
  // And the contact beside it is still claimed — the fix must not cost the
  // thing that already worked.
  const kinds = (parseClaims(line, 0) as { claims: { kind: string }[] }).claims.map((c) => c.kind);
  assert.ok(kinds.includes("phone"), "the phone claim was lost");
});

test("a bare hostname ending a sentence of prose", () => {
  assert.deepEqual(
    urls("- Brightwater Apartments — 2br from $2,450/mo, has parking. Leasing office 415-555-0132. brightwater.example.com"),
    ["brightwater.example.com"]);
});

test("a bare hostname that IS the whole line still works", () => {
  assert.deepEqual(urls("brightwater.example.com"), ["brightwater.example.com"]);
  assert.deepEqual(urls("   nineyards.example.com  "), ["nineyards.example.com"]);
});

test("NO DOUBLE CLAIM inside a scheme-qualified URL", () => {
  // "https://northgate.example.com" contains "northgate.example.com". Claiming
  // both would be two url claims for one fact — the double-claiming the old
  // strict rule existed to prevent, and the reason the fix masks first.
  assert.deepEqual(urls("https://northgate.example.com — Northgate Family Dentistry"),
    ["https://northgate.example.com"]);
  assert.deepEqual(bareHostnames("see https://a.example.com/path?q=1 now"), []);
});

test("NO DOUBLE CLAIM on an email's domain — but a sibling hostname still counts", () => {
  const line = "Email pat@x.example.com or see nineyards.example.com for the scope";
  assert.deepEqual(urls(line), ["nineyards.example.com"]);
  const emails = ((parseClaims(line, 0) as { claims: { kind: string; value: string }[] }).claims)
    .filter((c) => c.kind === "email").map((c) => c.value);
  assert.deepEqual(emails, ["pat@x.example.com"]);
});

test("A DOCUMENT IS NOT A WEBSITE", () => {
  // .md is Moldova, .sh is St Helena, .pl is Poland — structurally valid
  // hostnames. A filename claimed as a link is a claim the contract can never
  // satisfy, which trades a silent loss for a spurious one.
  assert.deepEqual(bareHostnames("I attached notes.md and the report.pdf and data.csv"), []);
  for (const f of ["deck.pptx", "photo.jpeg", "script.sh", "config.yml", "archive.tar"]) {
    assert.deepEqual(bareHostnames(`see ${f} please`), [], `${f} was claimed as a link`);
  }
  // ...but the guard must not swallow a real host that happens to sit beside one.
  assert.deepEqual(bareHostnames("notes.md and cedarandvine.example.com"), ["cedarandvine.example.com"]);
});

test("ordinary prose does not become links", () => {
  for (const line of [
    "Call Monday. Tuesday works too.",
    "Costs $1,200. About right.",
    "i.e. the second option, e.g. the loft",
    "Version 3.5 shipped, 12.04 is older",
    "Ask for J. Smith at the desk",
  ]) {
    assert.deepEqual(bareHostnames(line), [], `false positive in: ${line}`);
  }
});

test("real-world hostname shapes are recognised, horizontally", () => {
  // Not a vocabulary: the Public Suffix List decides, so a new gTLD and a
  // multi-part suffix both work without anyone maintaining a list.
  assert.deepEqual(bareHostnames("Visit example.co.uk and foo.pizza today"),
    ["example.co.uk", "foo.pizza"]);
  assert.deepEqual(bareHostnames("sub.domain.example.com"), ["sub.domain.example.com"]);
  // Punctuation around it is not part of it.
  assert.deepEqual(bareHostnames("(see example.com), then go"), ["example.com"]);
  assert.deepEqual(bareHostnames("example.com; next"), ["example.com"]);
});

test("several hostnames on one line are all claimed, in order", () => {
  assert.deepEqual(bareHostnames("compare alpha.example.com with beta.example.com"),
    ["alpha.example.com", "beta.example.com"]);
});

test("the fix is general, not fixture-shaped", () => {
  // No test-corpus host appears in the parser. If the fix ever needs to know a
  // specific domain, it has stopped being a rule.
  const src = readFileSync("src/lib/claim-parser.ts", "utf8")
    .split("\n").filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const host of ["riverbend", "brightwater", "nineyards", "example.com"]) {
    assert.ok(!src.includes(host), `the parser hard-codes ${host}`);
  }
});
