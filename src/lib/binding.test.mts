// ADVERSARIAL BINDING TESTS.
//
// Positional binding — i-th record to i-th item — misbound in four of five of
// these. Under enforcement that writes one community's phone number onto its
// neighbour, with full confidence. These cases exist so that never returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEnvelopes, bindByProvenance, bindItemsToRecords } from "./attribution.ts";

const SRC = [
  `Alpha House\tAstoria\t"Type: A\n Email Address: a@alpha.example.com\n Community Phone: (503) 555-0101"`,
  `Bravo Works\tBend\t"Type: B\n Email Address: b@bravo.example.com\n Community Phone: (541) 555-0202"`,
  `Cedar Group\tEugene\t"Type: C\n Email Address: c@cedar.example.com\n Community Phone: (458) 555-0303"`,
].join("\n") + "\n";
const ENV = recordEnvelopes(SRC)!;
const item = (title: string, ...emails: string[]) => ({ title, contacts: emails.map((e) => ({ email: e })) });
const A = item("Alpha House", "a@alpha.example.com");
const B = item("Bravo Works", "b@bravo.example.com");
const C = item("Cedar Group", "c@cedar.example.com");

/** No record may ever be bound to an item carrying a different record's anchor. */
function assertNoMisbinding(bound: Map<number, { title: string }>) {
  for (const [rec, it] of bound) {
    const expect = ENV[rec].name.split(" ")[0].toLowerCase();
    assert.ok(it.title.toLowerCase().includes(expect), `MISBOUND: ${ENV[rec].name} -> ${it.title}`);
  }
}

test("baseline: every record binds to its own proposal", () => {
  const b = bindByProvenance(ENV, SRC, [A, B, C]);
  assert.equal(b.bound.size, 3);
  assertNoMisbinding(b.bound);
});

test("REORDERED A/C/B — content decides, not position", () => {
  const b = bindByProvenance(ENV, SRC, [A, C, B]);
  assert.equal(b.bound.size, 3);
  assertNoMisbinding(b.bound);
});

test("OMITTED middle record — the survivor is not shifted onto it", () => {
  const b = bindByProvenance(ENV, SRC, [A, C]);
  assertNoMisbinding(b.bound);
  assert.equal(b.bound.size, 2);
  assert.equal(b.unboundRecords.length, 1, "the omitted record must be UNBOUND, not filled by a neighbour");
});

test("DUPLICATED proposal — ambiguity is not resolved by picking one", () => {
  const b = bindByProvenance(ENV, SRC, [A, B, B, C]);
  assertNoMisbinding(b.bound);
  assert.ok(!b.bound.has(1), "Bravo had two candidate proposals and must stay unbound");
  assert.ok(b.reasons.some((r) => /split or duplicate/.test(r)));
});

test("MERGED B+C into one proposal — neither is claimed", () => {
  const merged = item("Bravo & Cedar", "b@bravo.example.com", "c@cedar.example.com");
  const b = bindByProvenance(ENV, SRC, [A, merged]);
  assertNoMisbinding(b.bound);
  assert.ok(!b.bound.has(1) && !b.bound.has(2), "a merged proposal must not be attributed to either record");
  assert.ok(b.reasons.some((r) => /merge/.test(r)));
});

test("SPLIT B into two proposals — neither half wins the record", () => {
  const b = bindByProvenance(ENV, SRC, [A, item("Bravo Works (1)", "b@bravo.example.com"), item("Bravo Works (2)", "b@bravo.example.com"), C]);
  assertNoMisbinding(b.bound);
  assert.ok(!b.bound.has(1));
});

test("a record with no unique anchor cannot be bound by guesswork", () => {
  // Both records list the same head-office number and nothing else. A shared
  // anchor identifies neither.
  const shared = [
    `One\tX\t"Community Phone: (503) 555-9999"`,
    `Two\tY\t"Community Phone: (503) 555-9999"`,
  ].join("\n") + "\n";
  const env = recordEnvelopes(shared)!;
  const b = bindByProvenance(env, shared, [{ title: "One", contacts: [{ phone: "(503) 555-9999" }] }]);
  assert.equal(b.bound.size, 0, "a shared anchor must not identify a record");
});

test("the positional binder is retained ONLY as a demonstration of the failure", () => {
  // Kept so the regression is visible rather than folklore.
  const bad = bindItemsToRecords(ENV, 0, SRC.length, [A, C, B]);
  const misbound = [...bad.bound.entries()].filter(([rec, it]) =>
    !(it as { title: string }).title.toLowerCase().includes(ENV[rec].name.split(" ")[0].toLowerCase()));
  assert.ok(misbound.length > 0, "positional binding no longer misbinds — update the story, not the test");
});
