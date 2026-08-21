import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims } from "./claim-parser.ts";
import { reconcile } from "./reconcile.ts";
import { enforceItem, sourceGrantsPrivacy, contractEnforcementEnabled } from "./enforce.ts";

const run = (src: string, item: Record<string, unknown>, privacyGranted = false) => {
  const p = parseClaims(src);
  const r = reconcile(p, item);
  return { ...enforceItem(item, r.resolutions, p.claims, { privacyGranted }), rec: r };
};

test("enforcement is OFF unless explicitly enabled", () => {
  const was = process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  delete process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  assert.equal(contractEnforcementEnabled(), false);
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  assert.equal(contractEnforcementEnabled(), true);
  if (was === undefined) delete process.env.FLOWGUIDE_ENFORCE_CONTRACT; else process.env.FLOWGUIDE_ENFORCE_CONTRACT = was;
});

test("a labelled claim the model dropped is restored to details", () => {
  const { item } = run("Community Fee: $2,500", { details: [] });
  assert.deepEqual(item.details, [{ label: "Community Fee", value: "$2,500" }]);
});

test("a labelled claim already correctly placed is not duplicated", () => {
  const { item } = run("Community Fee: $2,500", { details: [{ label: "Community Fee", value: "$2,500" }] });
  assert.equal((item.details as unknown[]).length, 1);
});

test("enforcement is additive — it never deletes the model's own placement", () => {
  // The fact is in the wrong field. It is ADDED to the right one; the original
  // is left alone, because a wrong deletion is unrecoverable and a duplicate is
  // visible and fixable. Notes are the one exception, tested below.
  const { item } = run("Capacity: 84", { description: "Capacity: 84 residents", details: [] });
  assert.equal(item.description, "Capacity: 84 residents");
  assert.deepEqual(item.details, [{ label: "Capacity", value: "84" }]);
});

test("unlabelled money is never repaired — it stays unresolved", () => {
  const { item, rec, applied } = run("Garden Studio $4,090/month", { details: [] });
  assert.equal(rec.counts.sourceUnresolved, 1);
  assert.deepEqual(item.details, []);
  assert.equal(applied.filter((a) => a.action.startsWith("details")).length, 0);
});

test("the privacy rule clears a note the source never authorised", () => {
  const { item, applied } = run("Care Costs: all-inclusive", { notes: "Care Costs: all-inclusive", details: [] });
  assert.equal(item.notes, "");
  // ...and the fact it held was placed by its own rung, so nothing was lost.
  assert.deepEqual(item.details, [{ label: "Care Costs", value: "all-inclusive" }]);
  assert.ok(applied.some((a) => a.action.includes("no source authority")));
});

test("a note IS kept when the source grants privacy", () => {
  assert.equal(sourceGrantsPrivacy("Private note: do not share with the family"), true);
  assert.equal(sourceGrantsPrivacy("Type: AL, MC\nCapacity: 58"), false);
  const { item } = run("Type: AL", { notes: "the director is slow to reply", details: [] }, true);
  assert.equal(item.notes, "the director is slow to reply");
});

test("specialized destinations win — an email becomes a contact, not a detail", () => {
  const { item } = run("Email Address: pat@x.example.com", { details: [], contacts: [] });
  assert.equal((item.contacts as any[])[0].email, "pat@x.example.com");
  assert.deepEqual(item.details, []);
});

test("enforcement behaves identically across verticals", () => {
  // Same structure, different industry. The output shape must not differ.
  const a = run("Community Fee: $2,500", { details: [] }).item;
  const b = run("Corkage: $25/bottle", { details: [] }).item;
  const c = run("Permit Fee: Varies by jurisdiction", { details: [] }).item;
  for (const x of [a, b, c]) assert.equal((x.details as unknown[]).length, 1);
});
