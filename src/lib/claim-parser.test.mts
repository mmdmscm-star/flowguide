// The parser is the trust boundary, so these are written against the REAL ugly
// shapes from the 20-record diagnostic source, not tidy invented lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims, looksLikeHostname } from "./claim-parser.ts";
import { reconcile } from "./reconcile.ts";
import { canonicalValue } from "./canonical.ts";

const labels = (s: string) => parseClaims(s).claims.filter((c) => c.kind === "labelled").map((c) => `${c.label}=${c.value}`);

test("explicit labelled facts are claimed regardless of value shape", () => {
  // Creekwood's adjacent pair. Scalar and sentence, both claims.
  assert.deepEqual(labels("Community Fee: $2,500\nCare Costs: Prices are all-inclusive (care costs included in price)"), [
    "Community Fee=$2,500",
    "Care Costs=Prices are all-inclusive (care costs included in price)",
  ]);
});

test("digit-bearing labels are labels", () => {
  assert.deepEqual(labels("2nd Person Fee: $950/month\nLevel 2 Care: $1,400\n24-Hour Support: included"), [
    "2nd Person Fee=$950/month", "Level 2 Care=$1,400", "24-Hour Support=included",
  ]);
});

test("Atria — prose glued onto a labelled line splits into a claim and a fragment", () => {
  const r = parseClaims("- Second Person Fee: $2,095 (2BR) Pricing for apartments at Atria Tamalpais Creek are listed on their website when units are available.");
  assert.deepEqual(r.claims.map((c) => `${c.label}=${c.value}`), ["Second Person Fee=$2,095 (2BR)"]);
  assert.equal(r.fragments.length, 1);
  assert.match(r.fragments[0].text, /^Pricing for apartments/);
  assert.equal(r.fragments[0].reason, "prose appended to a labelled line");
});

test("...but a value that simply BEGINS with a clause is not split", () => {
  // "Care Costs: Prices are all-inclusive…" — the clause starts at position 0,
  // so there is no value to split off. Splitting here would empty the claim.
  const r = parseClaims("Care Costs: Prices are all-inclusive (care costs included in price)");
  assert.equal(r.claims.length, 1);
  assert.equal(r.claims[0].value, "Prices are all-inclusive (care costs included in price)");
  assert.equal(r.fragments.length, 0);
});

test("Vine Ridge — a value wrapped onto the next line is rejoined, not truncated", () => {
  const r = parseClaims("Care Costs: Additional monthly fee based on level of care. Maximum care level fee for\nAssisted Living $3,700.");
  assert.equal(r.claims.length, 1);
  assert.match(r.claims[0].value, /\$3,700/);
});

test("repeated labels each produce their own claim", () => {
  // Magnolia Court carries Care Costs twice, for AL and for MC.
  const r = parseClaims("Care Costs: level of care applies\nCommunity Fee: $2,500\nCare Costs: all-inclusive");
  assert.equal(r.claims.filter((c) => c.label === "Care Costs").length, 2);
  assert.equal(new Set(r.claims.map((c) => c.id)).size, r.claims.length, "claim ids must be unique");
});

test("a label with no value is a fragment, never an empty claim", () => {
  const r = parseClaims("Second Person Fee:\nCommunity Fee: $2,400");
  assert.deepEqual(r.claims.map((c) => c.label), ["Community Fee"]);
  assert.equal(r.fragments[0].reason, "label with no value");
});



test("no vocabulary decides a claim — unlabelled money is always unresolved", () => {
  // The lexical descriptor class is gone. Money is RECOGNIZED so it can be
  // surfaced and accounted for; its ownership is never inferred. Identical
  // treatment across verticals is the point — these three lines differ only in
  // subject matter and must behave the same.
  for (const line of [
    "- $4,090/month One Bedroom",          // senior living
    "- $68/person Family Style",           // catering — used to be claimed WRONGLY
    "Standing Seam Metal $14/sq ft",       // contracting — used to be dropped
  ]) {
    const r = parseClaims(line);
    assert.equal(r.claims.length, 0, `claimed a pairing it cannot prove: ${line}`);
    assert.equal(r.ambiguous.length, 1, line);
    assert.match(r.ambiguous[0].reason, /ownership not structurally provable/);
  }
});

test("money recognition is currency-agnostic and association-free", () => {
  const r = parseClaims("Deluxe Package £1,200\nStandard €950\nBasic USD 400");
  assert.equal(r.ambiguous.length, 3);
  assert.deepEqual(r.ambiguous.map((u) => u.amounts), [["1200"], ["950"], ["400"]]);
});

test("legitimate labels containing lowercase `to` survive", () => {
  // The banned-"to" rule was derived from one corpus and rejected every one of
  // these. The opener test replaced it: a lead-in STARTS like a clause.
  for (const [line, label] of [
    ["Time to Completion: 3 weeks", "Time to Completion"],
    ["Cost to Replace: $450", "Cost to Replace"],
    ["Distance to Airport: 12 miles", "Distance to Airport"],
    ["Steps to Apply: 4", "Steps to Apply"],
    ["One Bedroom: $4,090/month", "One Bedroom"],
  ] as const) {
    const c = parseClaims(line).claims.find((x) => x.kind === "labelled");
    assert.ok(c, `lost a legitimate label: ${line}`);
    assert.equal(c!.label, label);
  }
  for (const line of [
    "One thing to remember: the waitlist moves fast",
    "A quick reminder before you call: ask for the coordinator",
    "What the family said afterwards: they want a second visit",
  ]) assert.equal(parseClaims(line).claims.find((x) => x.kind === "labelled"), undefined, line);
});

test("Vine Ridge — the wrapped room block is AMBIGUOUS, never guessed", () => {
  // The trap: line 2 reads as "amount then descriptor" and would pair $4,090
  // with "One Bedroom". It is wrong — $4,090 belongs to the Studio above — and
  // the misalignment continues down the block while each line looks confident.
  const r = parseClaims("Assisted Living/Memory Care Studio\n- $4,090/month One Bedroom\n- $4,825/month Large One Bedroom\n- $5,035/month");
  assert.equal(r.claims.length, 0, "guessed a descriptor it could not know");
  // Recognized, not discarded: they enter accounting as their own source units.
  assert.equal(r.ambiguous.length, 3);
  assert.deepEqual(r.ambiguous.map((u) => u.amounts), [["4090"], ["4825"], ["5035"]]);
});

test("two independent amounts on one line are ambiguous, not two guesses", () => {
  const r = parseClaims("Memory Care Private Studio $7,895 Shared Companion $6,995");
  assert.equal(r.claims.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].amounts, ["7895", "6995"]);
});

test("ambiguous source units are inside the accounting identity", () => {
  // The invariant: nothing the parser RECOGNIZES as meaningful may live outside
  // accounting. An ambiguous priced line is recognized — it plainly carries a
  // fact — so it resolves as SOURCE_UNRESOLVED rather than being a loose
  // fragment nobody counts.
  const p = parseClaims("Community Fee: $2,500\nAssisted Living Studio\n- $4,090/month One Bedroom");
  const r = reconcile(p, { details: [{ label: "Community Fee", value: "$2,500" }] });
  const recognized = r.counts.claims + r.counts.ambiguous;
  assert.equal(r.counts.accepted + r.counts.repaired + r.counts.unresolved + r.counts.sourceUnresolved, recognized);
  assert.equal(r.counts.sourceUnresolved, 1);
  assert.ok(r.resolutions.some((x) => x.outcome === "SOURCE_UNRESOLVED"));
  // ...and it is never repaired, because the parser refused to guess the pairing.
  assert.ok(!r.resolutions.some((x) => x.outcome === "REPAIRED" && x.why.includes("descriptor cannot")));
});

test("bare URLs, emails and phones are claimed from unlabelled lines", () => {
  const r = parseClaims("https://example.com/a.jpg\npat@x.example.com\n(707) 555-0101");
  assert.deepEqual(r.claims.map((c) => c.kind), ["url", "email", "phone"]);
});

// ---------------------------------------------------------------------------

const item = (o: Record<string, unknown>) => o;

test("precedence: specialized destinations win before generic details", () => {
  const r = reconcile(parseClaims("Email Address: pat@x.example.com\nCommunity Fee: $2,500"),
    item({ contacts: [{ email: "pat@x.example.com" }], details: [{ label: "Community Fee", value: "$2,500" }] }));
  assert.deepEqual(r.resolutions.map((x) => [x.rung, x.outcome]), [[1, "ACCEPTED"], [2, "ACCEPTED"]]);
});

test("an email placed in details is REPAIRED, not accepted", () => {
  const r = reconcile(parseClaims("Email Address: pat@x.example.com"),
    item({ details: [{ label: "Email", value: "pat@x.example.com" }] }));
  assert.equal(r.resolutions[0].rung, 1);
  assert.equal(r.resolutions[0].outcome, "REPAIRED");
});

test("a labelled fact in notes is REPAIRED whatever its value looks like", () => {
  for (const v of ["$2,500", "Prices are all-inclusive (care costs included in price)"]) {
    const r = reconcile(parseClaims(`Care Costs: ${v}`), item({ notes: `Care Costs: ${v}` }));
    assert.equal(r.resolutions[0].outcome, "REPAIRED", v);
    assert.equal(r.resolutions[0].want, "details");
  }
});

test("address is matched by provenance, not by exact string", () => {
  // Reformatting an address is not losing it. Equality matching would report
  // this correctly-placed address as missing.
  const r = reconcile(parseClaims("Address: 1200 Example Rd, Santa Rosa CA 95401"),
    item({ address: "1200 Example Road, Santa Rosa, California" }));
  assert.equal(r.resolutions[0].want, "address");
  assert.equal(r.resolutions[0].outcome, "ACCEPTED");
});

test("the accounting identity holds, and a proposal with unresolved content is blocked", () => {
  const p = parseClaims("Community Fee: $2,500\nGarden Studio $4,090/month\nsome unlabelled prose here");
  const r = reconcile(p, item({ details: [{ label: "Community Fee", value: "$2,500" }] }));
  const recognized = r.counts.claims + r.counts.ambiguous;
  assert.equal(r.counts.accepted + r.counts.repaired + r.counts.unresolved + r.counts.sourceUnresolved, recognized);
  assert.equal(r.counts.claims, 1, "one labelled claim");
  assert.equal(r.counts.ambiguous, 1, "the money line is recognized but unresolved");
  assert.equal(r.counts.fragments, 1, "the prose line");
});





// ---- TWO-LINE LABEL / VALUE, and bare hostnames ---------------------------

test("two-line Label / value is recognized when the value is an identity", () => {
  for (const [src, label, value] of [
    ["Capacity\n120", "Capacity", "120"],
    ["Cancellation Policy\n48 hours", "Cancellation Policy", "48 hours"],
    ["Price\n$85", "Price", "$85"],
    ["Website\nexample.com", "Website", "example.com"],
  ] as const) {
    const c = parseClaims(src).claims[0];
    assert.ok(c, `no claim: ${src}`);
    assert.equal(c.label, label);
    assert.equal(c.value, value);
  }
});

test("two-line form is recognized when the label RECURS, as a directory does", () => {
  const src = "Address\n688 San Jose Ave, SF\n\nAddress\n3692 18th St, SF\n\nAddress\n6902 Sebastopol Ave";
  const claims = parseClaims(src).claims.filter((c) => c.label === "Address");
  assert.equal(claims.length, 3);
});

test("a heading followed by content is NOT a claim", () => {
  for (const src of [
    "Shop Directory\n1. Mitchell's Ice Cream — San Francisco",
    "About Us\nWe have served the community since 1953 and take pride in it.",
    "Overview\nA family-run institution.",
  ]) assert.equal(parseClaims(src).claims.length, 0, `invented a claim: ${src}`);
});

test("the hostname validator is conservative", () => {
  // Genuine non-domains: abbreviations, decimals, sentence punctuation.
  for (const t of ["e.g", "i.e", "3.5", "U.S.A", "Inc.", "a.b", "12.04", "Ave. Suite"])
    assert.equal(looksLikeHostname(t), false, `fired on: ${t}`);
  // And the suffixes a hand-written list would have missed. "hello.world" is
  // here as an ACCEPT: .world is a real suffix, and the old fixture asserting
  // otherwise was pinning a false negative.
  for (const t of ["hello.world", "shop.pizza", "something.nyc", "acme.co.jp"])
    assert.equal(looksLikeHostname(t), true, `missed a valid suffix: ${t}`);
  for (const t of ["example.com", "www.example.com", "mitchellsicecream.com", "thetam.org"])
    assert.equal(looksLikeHostname(t), true, `missed: ${t}`);
});

test("a bare hostname is a URL claim wherever it appears, and gets its scheme deterministically", () => {
  assert.equal(parseClaims("Website: mitchellsicecream.com").claims[0].kind, "url");
  assert.equal(parseClaims("Website\nmitchellsicecream.com").claims[0].kind, "url");
  assert.equal(parseClaims("mitchellsicecream.com").claims[0].kind, "url");
  assert.equal(canonicalValue("mitchellsicecream.com", "url"), "https://mitchellsicecream.com/");
});

test("a bare hostname routes to links, not details", () => {
  const p = parseClaims("Website\nexample.com");
  const r = reconcile(p, { links: [], details: [] });
  assert.equal(r.resolutions[0].rung, 1);
  assert.equal(r.resolutions[0].want, "links");
});
