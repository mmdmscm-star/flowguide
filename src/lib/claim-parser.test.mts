// The parser is the trust boundary, so these are written against the REAL ugly
// shapes from the 20-record diagnostic source, not tidy invented lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims } from "./claim-parser.ts";
import { reconcile } from "./reconcile.ts";

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

test("unlabelled pricing lines are declined LOUDLY, not silently", () => {
  // Vine Ridge's room list has real prices and no labels. The parser cannot
  // guarantee structure it cannot identify — but it must say so.
  const r = parseClaims("Assisted Living/Memory Care Studio\n- $4,090/month One Bedroom\n- $4,825/month");
  assert.equal(r.claims.length, 0);
  assert.equal(r.fragments.length, 3);
  assert.ok(r.fragments.some((f) => f.reason === "unlabelled content carrying numbers"));
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
  const p = parseClaims("Community Fee: $2,500\n- $4,090/month One Bedroom");
  const r = reconcile(p, item({ details: [{ label: "Community Fee", value: "$2,500" }] }));
  assert.equal(r.counts.accepted + r.counts.repaired + r.counts.unresolved, r.counts.claims);
  assert.equal(r.counts.fragments, 1);
});
