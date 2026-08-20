// Detection and reconciliation, tested offline. No model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFacts, reconcile, buildChunkLedger } from "./fact-ledger.ts";
import { findUnbacked } from "./source-backed.ts";
import { presentInItem } from "./fact-match.ts";

const ids = (s: string) => detectFacts(s, 0).map((f) => `${f.kind}:${f.text}`);

// ---------------------------------------------------------------------------
// Detection — the shapes Corpus v2 proved are lost
// ---------------------------------------------------------------------------
test("a range in prose is detected — the 87%-loss shape", () => {
  const d = ids("Level of care pricing ranges from $600 to $2,400 per month depending on the assessment.");
  assert.ok(d.some((x) => x.startsWith("range:")), JSON.stringify(d));
});

test("ranges are detected in every phrasing the corpus uses", () => {
  for (const s of ["$520 to $610 per day", "between $600 and $2,400", "$5,100 – $6,400", "ranges from $4 to $9"]) {
    assert.ok(detectFacts(s, 0).some((f) => f.kind === "range"), s);
  }
});

test("a key/value line is detected with the label the source gave", () => {
  const [f] = detectFacts("Community Fee: Equal to one month's rent", 0).filter((x) => x.kind === "keyvalue");
  assert.equal(f.label, "Community Fee");
  assert.equal(f.text, "Equal to one month's rent");
});

test("prose-qualified values are detected", () => {
  const d = detectFacts("Care Costs: Additional monthly fee based on level of care, assessed on move-in.", 0);
  assert.ok(d.some((f) => f.kind === "keyvalue"));
});

// ---------------------------------------------------------------------------
// TIER-1 ELIGIBILITY — details must not become a universal sink
// ---------------------------------------------------------------------------
test("a key/value whose value is a URL is NOT eligible to become a detail", () => {
  const [f] = detectFacts("Website: https://www.example.com", 0).filter((x) => x.kind === "keyvalue");
  assert.equal(f.detailEligible, false, "a website belongs in links, not details");
});

test("nor an email, nor a phone", () => {
  for (const line of ["Email: sam@example.com", "Phone: 707-555-0100"]) {
    const [f] = detectFacts(line, 0).filter((x) => x.kind === "keyvalue");
    assert.equal(f.detailEligible, false, line);
  }
});

test("an ordinary key/value IS eligible", () => {
  for (const line of ["Capacity: 140 residents", "Community Fee: Equal to one month's rent",
                      "Assisted Living Studio: $4,720/month"]) {
    const [f] = detectFacts(line, 0).filter((x) => x.kind === "keyvalue");
    assert.equal(f.detailEligible, true, line);
  }
});

// ---------------------------------------------------------------------------
// Precision guards — a list a professional learns to ignore is worse than none
// ---------------------------------------------------------------------------
test("ordinary prose produces no detections", () => {
  const d = detectFacts(
    "The community sits on a landscaped campus with a walled garden and a bistro that serves all day.", 0);
  assert.deepEqual(d, [], JSON.stringify(d));
});

test("a heading is not mistaken for a key/value pair", () => {
  assert.deepEqual(detectFacts("Pricing", 0), []);
  assert.deepEqual(detectFacts("Notes from the tour:", 0), []);
});

test("the same fact twice in one segment is one fact", () => {
  const d = detectFacts("Website: https://a.example.com\nSee also https://a.example.com", 0);
  assert.equal(d.filter((f) => f.kind === "url").length, 1);
});

test("a priced key/value is not counted twice, as keyvalue and as money", () => {
  const d = detectFacts("Assisted Living Studio: $4,720/month", 0);
  assert.equal(d.filter((f) => f.kind === "money").length, 0);
  assert.equal(d.filter((f) => f.kind === "keyvalue").length, 1);
});

// ---------------------------------------------------------------------------
// Reconciliation — presence, never placement
// ---------------------------------------------------------------------------
test("a fact the model kept is accounted for, wherever it put it", () => {
  const detected = detectFacts("Capacity: 140 residents", 0);
  const inDetails = reconcile(detected, [{ details: [{ label: "Capacity", value: "140 residents" }] }]);
  const inNotes = reconcile(detected, [{ notes: "Capacity is 140 residents." }]);
  assert.equal(inDetails.counts.unaccounted, 0);
  assert.equal(inNotes.counts.unaccounted, 0, "misplacement is a different failure class");
});

test("a fact the model dropped is unaccounted", () => {
  const detected = detectFacts("Level of care pricing ranges from $600 to $2,400 per month.", 0);
  const l = reconcile(detected, [{ title: "Somewhere", details: [{ label: "Type", value: "AL" }] }]);
  assert.equal(l.counts.unaccounted, detected.length);
});

test("reformatting is not loss", () => {
  const detected = detectFacts("Assisted Living Studio: $4,720/month", 0);
  const l = reconcile(detected, [{ details: [{ label: "AL Studio", value: "$4,720 per month" }] }]);
  assert.equal(l.counts.unaccounted, 0);
});

test("the two hardened false-positive classes stay fixed", () => {
  // a name inside its own domain is not the name being placed there
  assert.equal(presentInItem({ links: [{ url: "https://marinterrace.example.com" }] }, "Marin Terrace"), false);
  // a two-digit number inside a postcode is not that number
  assert.equal(presentInItem({ address: "222 Orchard Lane, Sebastopol CA 95472" }, "54"), false);
  assert.equal(presentInItem({ details: [{ label: "Capacity", value: "54" }] }, "54"), true);
});

// ---------------------------------------------------------------------------
// Source-backed
// ---------------------------------------------------------------------------
test("a website that never appeared in the source is unbacked — the v2 fabrication", () => {
  const src = "Valley Oaks Living\nSam Patel, Director\nsam@valleyoaks.example.com";
  const u = findUnbacked(src, [{ title: "Valley Oaks Living",
    contacts: [{ name: "Sam Patel", email: "sam@valleyoaks.example.com",
                 website: "https://www.valleyoaks.example.com" }] }]);
  assert.equal(u.length, 1);
  assert.equal(u[0].field, "contacts.website");
});

test("a URL that IS in the source is backed", () => {
  const src = "Website: https://www.example.com/floorplans.pdf";
  assert.deepEqual(findUnbacked(src, [{ links: [{ url: "https://www.example.com/floorplans.pdf" }] }]), []);
});

test("a reformatted phone is still backed", () => {
  const src = "Call (707) 555-0142 for a tour.";
  assert.deepEqual(findUnbacked(src, [{ contacts: [{ phone: "707-555-0142" }] }]), []);
});

test("address and title are deliberately out of scope", () => {
  const src = "Brookdale Ridgeway\n120 Ridgeline Road, Santa Rosa CA 95401";
  assert.deepEqual(findUnbacked(src, [{ title: "Brookdale", address: "120 Ridgeline Rd, Santa Rosa" }]), [],
    "both are legitimately reformatted; holding them to literal presence blocks work for non-failures");
});

test("buildChunkLedger reads both entry-point result shapes", () => {
  const seg = "Community Fee: $3,500\nMonthly Rate: $6,200";
  const flat = buildChunkLedger(seg, 0, { items: [{ title: "A", details: [{ label: "Community Fee", value: "$3,500" }, { label: "Monthly Rate", value: "$6,200" }] }] });
  const nested = buildChunkLedger(seg, 0, { sections: [{ items: [{ title: "A", details: [{ label: "Community Fee", value: "$3,500" }, { label: "Monthly Rate", value: "$6,200" }] }] }] });
  assert.equal(flat.counts.unaccounted, 0);
  assert.deepEqual(flat.counts, nested.counts);
});

test("buildChunkLedger survives a malformed result instead of throwing", () => {
  // Inert means inert: a shape the ledger did not expect must never be able to
  // take down a chunk that the model actually completed.
  for (const bad of [null, undefined, {}, { items: null }, { sections: [null] }, { items: ["x", 3] }, "nope"]) {
    const l = buildChunkLedger("Community Fee: $3,500", 0, bad);
    assert.equal(l.counts.detected, 1);
    assert.equal(l.counts.unaccounted, 1);   // nothing present, so nothing accounted
  }
});

test("digit-bearing labels are labels, not prose", () => {
  // Guards against the first version of this rule, which reached 100% precision
  // on both corpora by banning digits from labels — a score bought by silently
  // dropping facts no corpus happened to contain.
  for (const [line, label] of [
    ["2nd Person Fee: $950/month", "2nd Person Fee"],
    ["Level 2 Care: $1,400 added to base rate", "Level 2 Care"],
    ["24-Hour Support: included at all levels", "24-Hour Support"],
    ["Studio 1: $4,150/month", "Studio 1"],
    ["Tier 3 Memory Care: $7,900/month", "Tier 3 Memory Care"],
    ["Room 214 Monthly: $3,300", "Room 214 Monthly"],
    ["Building B: memory care only", "Building B"],      // capital A/B is not an article
    ["Care Level A: $600 added", "Care Level A"],
    ["Community fee: $3,500 one time", "Community fee"],  // sentence case, not title case
    ["Days of Operation: Monday to Friday", "Days of Operation"],
    ["Fee for Second Person: $950", "Fee for Second Person"],
    ["Board and Care Rate: $4,800/month", "Board and Care Rate"],
  ] as const) {
    const kv = detectFacts(line, 0).find((d) => d.kind === "keyvalue");
    assert.ok(kv, `dropped a real label: ${line}`);
    assert.equal(kv!.label, label);
  }
});

test("prose lead-ins are rejected on grammar, not on digits", () => {
  for (const line of [
    "Notes from the tour on 4 March: the dining room was busy",
    "What the family said afterwards: they want a second visit",
    "The director was candid about pricing: expect an increase",
    "A quick reminder before you call: ask for the coordinator",
    "Things I noticed while I was there: staffing looked thin",
    "This is what the intake nurse told me: bring the POA",
  ]) {
    assert.equal(detectFacts(line, 0).find((d) => d.kind === "keyvalue"), undefined, `read prose as a fact: ${line}`);
  }
});

test("the known label false positive is still exactly one, and still bounded", () => {
  // "One thing to remember:" is four words with no determiner and no verb — it
  // is grammatically a label. It is left detected on purpose: the fix would be
  // to add "to" to the marker set, which breaks "Fee for Second Person" style
  // labels for a rarer case. Its cost is a spurious unresolved entry, never a
  // lost fact. If this ever starts failing, the rule moved — decide deliberately.
  const kv = detectFacts("One thing to remember: the waitlist moves fast", 0).find((d) => d.kind === "keyvalue");
  assert.ok(kv, "the known limitation changed — re-derive the label rule deliberately");
  assert.equal(kv!.detailEligible, true);   // bounded: worst case it is preserved verbatim
});
