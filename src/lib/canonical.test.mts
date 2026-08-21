import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalValue, canonicalLabel, hasSemanticQualifier, meaningPreserved } from "./canonical.ts";

test("qualifiers and conditions are never normalized away", () => {
  // Each of these changes what was promised. They must survive verbatim.
  for (const v of [
    "starting at $6,000", "up to $1,900/month", "approximately 45 residents",
    "$10,000-$15,000/month", "$450/day", "$68/person", "included in price",
    "not included", "waived for referred clients", "Equal to one month's rent",
    "Additional monthly fee based on level of care (assessment required)",
    "$1,500 to $1,900 depending on load-in window", "Varies by jurisdiction",
  ]) {
    assert.equal(canonicalValue(v), v, `altered: ${v}`);
    assert.ok(hasSemanticQualifier(v), `qualifier not detected: ${v}`);
  }
});

test("whitespace is tidied and nothing else", () => {
  assert.equal(canonicalValue("  $2,500   one   time "), "$2,500 one time");
  assert.equal(canonicalValue("AL,   MC"), "AL, MC");
});

test("labels get harmless cleanup only", () => {
  assert.equal(canonicalLabel("- Community  Fee :"), "Community Fee");
  assert.equal(canonicalLabel("2nd Person Fee"), "2nd Person Fee");
  assert.equal(canonicalLabel("Memory Care Private Studio (shared bath)"), "Memory Care Private Studio (shared bath)");
});

test("URLs canonicalize scheme and host, never the path", () => {
  assert.equal(canonicalValue("HTTPS://WWW.Example.COM/Path/To/A", "url"), "https://www.example.com/Path/To/A");
  assert.equal(canonicalValue("https://example.com:443/x", "url"), "https://example.com/x");
  assert.equal(canonicalValue("not a url at all", "url"), "not a url at all");
});

test("phones format only when the shape is unambiguous", () => {
  assert.equal(canonicalValue("707-555-0101", "phone"), "(707) 555-0101");
  assert.equal(canonicalValue("+1 707 555 0101", "phone"), "(707) 555-0101");
  assert.equal(canonicalValue("(707) 555-0101 ext 12", "phone"), "(707) 555-0101 ext 12");
});

test("email lowercases the domain and leaves the local part alone", () => {
  assert.equal(canonicalValue("Pat.Rivera@Example.COM", "email"), "Pat.Rivera@example.com");
});

test("canonicalization is idempotent", () => {
  for (const [v, k] of [["  $4,090 /month ", "text"], ["HTTPS://X.COM/A", "url"], ["707.555.0101", "phone"]] as const) {
    const once = canonicalValue(v, k);
    assert.equal(canonicalValue(once, k), once, v);
  }
});

test("meaningPreserved catches a transform that would change a fact", () => {
  assert.ok(meaningPreserved("$2,500 one time", "$2,500 one time"));
  assert.ok(!meaningPreserved("starting at $6,000", "$6,000"), "dropping a qualifier must not pass");
  assert.ok(!meaningPreserved("$10,000-$15,000", "$10,000"), "dropping a range endpoint must not pass");
});
