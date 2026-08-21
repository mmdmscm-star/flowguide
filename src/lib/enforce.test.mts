import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("ACCEPTED and REPAIRED render the SAME fact", () => {
  // The whole point. One source claim, two model behaviours, one output.
  const src = "Care Costs: starting at $6,000 per month";
  const modelPlacedIt = run(src, { details: [{ label: "Care costs", value: "from $6,000/mo" }] });
  const modelDroppedIt = run(src, { details: [] });
  assert.deepEqual(modelPlacedIt.item.details, modelDroppedIt.item.details);
  // ...and the qualifier survived, rather than the model's paraphrase winning.
  assert.deepEqual(modelPlacedIt.item.details, [{ label: "Care Costs", value: "starting at $6,000 per month" }]);
});

test("the model's paraphrase never becomes canonical", () => {
  const { item, applied } = run("Community Fee: $2,400", { details: [{ label: "Community Fee", value: "approximately $2,400" }] });
  assert.deepEqual(item.details, [{ label: "Community Fee", value: "$2,400" }]);
  assert.ok(applied.some((a) => a.action.includes("canonicalized")));
});

test("ungoverned details the model derived are left alone", () => {
  // Enso-style elaboration: the source says "Entrance Fee"; the model broke it
  // into per-floorplan rows. Those are not governed claims and must survive.
  const { item } = run("Entrance Fee: varies by floor plan", {
    details: [
      { label: "1 Bedroom Entrance Fee", value: "$658,255 – $1,015,475" },
      { label: "2 Bedroom Entrance Fee", value: "$1,076,995 – $1,408,422" },
    ],
  });
  const labels = (item.details as { label: string }[]).map((d) => d.label);
  assert.ok(labels.includes("1 Bedroom Entrance Fee"), "deleted an ungoverned detail");
  assert.ok(labels.includes("Entrance Fee"), "governed claim not materialized");
});

test("canonicalization never drops a unit, range or condition", () => {
  for (const [src, want] of [
    ["Live-in Rate: ranges from $520 to $610 per day", "ranges from $520 to $610 per day"],
    ["Second Person Fee: $950/month", "$950/month"],
    ["Corkage: $25/bottle", "$25/bottle"],
    ["Assessment Fee: waived for clients referred by a placement advisor", "waived for clients referred by a placement advisor"],
    ["Permit Fee: Varies by jurisdiction; owner is billed at cost", "Varies by jurisdiction; owner is billed at cost"],
  ] as const) {
    const { item } = run(src, { details: [] });
    assert.equal((item.details as { value: string }[])[0].value, want, src);
  }
});

test("a duplicate rendering of a specialized claim is stripped from details", () => {
  const { item, stripped } = run("Community Phone: (707) 723-9250", {
    details: [{ label: "Community Phone", value: "(707) 723-9250" }], contacts: [],
  });
  assert.deepEqual(item.details, [], "the duplicate detail survived");
  assert.equal(stripped.length, 1);
  assert.match(stripped[0].reason, /duplicate rendering/);
  assert.equal((item.contacts as any[])[0].phone, "(707) 723-9250");
});

test("a CONFLICTING value for the same governed claim is stripped, not shown", () => {
  // The Ridge at Healdsburg carried two different Community Phone details across
  // two runs of one source. An unsupported competing fact is worse than a
  // missing one, so it does not reach the recipient.
  const { item, stripped } = run("Community Phone: (707) 723-9250", {
    details: [{ label: "Community Phone", value: "(707) 687-9633" }], contacts: [],
  });
  assert.deepEqual(item.details, []);
  assert.match(stripped[0].reason, /conflicting value/);
});

test("independent source-backed content in the same detail is preserved", () => {
  const { item, stripped } = run("Community Phone: (707) 723-9250", {
    details: [{ label: "Reception", value: "(707) 723-9250 — open 9am to 5pm daily" }], contacts: [],
  });
  const d = item.details as { value: string }[];
  assert.equal(d.length, 1, "the whole detail was deleted");
  assert.match(d[0].value, /open 9am to 5pm daily/);
  assert.doesNotMatch(d[0].value, /723-9250/);
  assert.match(stripped[0].reason, /independent content preserved/);
});

test("stripping does not touch unrelated model-authored details", () => {
  const { item, stripped } = run("Community Phone: (707) 723-9250", {
    details: [
      { label: "Studio", value: "$4,090/month" },
      { label: "Pet Policy", value: "cats and dogs under 25lb" },
    ], contacts: [],
  });
  assert.equal((item.details as unknown[]).length, 2, "deleted content it had no claim over");
  assert.equal(stripped.length, 0);
});

test("identity that cannot be proven is left alone", () => {
  // A short numeric coincidence must not license a deletion.
  const { item, stripped } = run("Capacity: 84", { details: [{ label: "Year Built", value: "1984" }] });
  assert.ok((item.details as unknown[]).length >= 1);
  assert.equal(stripped.length, 0);
});

// ---- ADVERSARIAL STRIPPING. False-strip target is 0. ----------------------

test("two legitimate phones with different roles both survive", () => {
  const src = "Community Phone: (707) 555-0101\nCell Phone: (707) 555-0202";
  const { item, stripped } = run(src, {
    details: [{ label: "After-hours line", value: "(707) 555-0303" }],
    contacts: [{ name: "Pat", phone: "(707) 555-0101" }],
  });
  const phones = (item.contacts as any[]).map((c) => c.phone).filter(Boolean);
  assert.ok(phones.some((p: string) => p.includes("555-0101")), "lost the community phone");
  assert.ok(phones.some((p: string) => p.includes("555-0202")), "lost the cell phone");
  // A third, unclaimed number is not a competing rendering of either.
  assert.equal((item.details as any[]).length, 1, "stripped a phone the source never claimed");
  assert.equal(stripped.length, 0);
});

test("repeated labels in different contexts are not collapsed", () => {
  const { item } = run("Care Costs: assisted living tier\nCare Costs: memory care tier", { details: [] });
  const values = (item.details as { value: string }[]).map((d) => d.value).sort();
  assert.deepEqual(values, ["assisted living tier", "memory care tier"]);
});

test("a detail holding BOTH a duplicate governed fact and independent info keeps the info", () => {
  const { item, stripped } = run("Email Address: pat@x.example.com", {
    details: [{ label: "Admissions", value: "pat@x.example.com — replies within one business day" }],
    contacts: [],
  });
  const d = item.details as { value: string }[];
  assert.equal(d.length, 1);
  assert.match(d[0].value, /replies within one business day/);
  assert.doesNotMatch(d[0].value, /pat@x\.example\.com/);
  assert.equal(stripped.length, 1);
});

test("same label, unprovable identity — nothing is stripped", () => {
  // The label matches a governed claim but the value is a different KIND of
  // fact. Identity is not proven, so the detail stands and the conflict is
  // surfaced by the accounting rather than resolved by deletion.
  const { item, stripped } = run("Website: https://a.example.com", {
    details: [{ label: "Website availability", value: "under construction until spring" }],
    links: [],
  });
  assert.equal((item.details as any[]).length, 1, "deleted a detail whose identity was not proven");
  assert.equal(stripped.length, 0);
});

test("packet prompts no longer route ambiguity into the private note", () => {
  const prompts = readFileSync("src/lib/ai-prompts.ts", "utf8");
  // CODE ONLY. The comment explaining the removal naturally quotes the phrase,
  // and an earlier version of this test scanned it and failed — measuring the
  // comment rather than what reaches the model. Same self-reference trap as
  // before; the fix is to scope the scan, never to loosen the pattern.
  const code = prompts.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /ambiguous\s*->\s*notes/, "`ambiguous -> notes` still reaches the model");
  // ...and replaced by an explicit authority requirement.
  assert.match(prompts, /notes is PRIVATE/);
  assert.match(prompts, /ONLY when the source itself says it is private/);
});

test("enforcement is inert when the flag is off", async () => {
  const { enforceChunkResult } = await import("./enforce-chunk.ts");
  const was = process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  delete process.env.FLOWGUIDE_ENFORCE_CONTRACT;
  const result = { items: [{ title: "A", notes: "should survive when off" }] };
  const out = enforceChunkResult({ segmentText: "Community Fee: $1", chunkOrdinal: 0, sourceStart: 0,
    sourceText: "Community Fee: $1", result });
  assert.equal(out.result, result, "the model's own result must be returned untouched");
  assert.equal(out.telemetry.itemsGoverned, 0);
  if (was === undefined) delete process.env.FLOWGUIDE_ENFORCE_CONTRACT; else process.env.FLOWGUIDE_ENFORCE_CONTRACT = was;
});
