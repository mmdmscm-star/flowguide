// Unit tests for link identity and labelling on an item card (pure; no DB, no DOM).
// Run: node --test src/lib/item-links.test.mts
//
// These pin the two halves of one rule: identity is the DESTINATION, never the
// label. Same destination collapses to one button; different destinations both
// survive even when they read the same, and get a hostname to tell them apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDestination, hostLabel, smartLabel, resolveCardLinks } from "./item-links.ts";

const same = (a: string, b: string) =>
  assert.equal(normalizeDestination(a), normalizeDestination(b), `${a} should equal ${b}`);
const differ = (a: string, b: string) =>
  assert.notEqual(normalizeDestination(a), normalizeDestination(b), `${a} must NOT equal ${b}`);

// ------------------------------------------------------------------
// Normalization — what may be folded
// ------------------------------------------------------------------
test("folds only differences that cannot change the destination", () => {
  same("http://example.com", "https://example.com");          // scheme
  same("https://www.example.com", "https://example.com");      // leading www
  same("https://EXAMPLE.com", "https://example.com");          // host case
  same("example.com", "https://example.com");                  // missing scheme
  same("https://example.com/", "https://example.com");          // root trailing slash
  same("https://example.com/tour/", "https://example.com/tour"); // path trailing slash
  same("  https://example.com  ", "https://example.com");       // surrounding space
  // the real-world shape: an item link stored fully qualified, the same site
  // stored bare on a contact
  same("https://www.oakmont.com/", "oakmont.com");
});

// ------------------------------------------------------------------
// Normalization — what must be preserved (the conservatism guarantee)
// ------------------------------------------------------------------
test("preserves every difference that could change the destination", () => {
  differ("https://example.com/tour", "https://example.com/pricing");   // path
  differ("https://example.com/Tour", "https://example.com/tour");      // path CASE
  differ("https://example.com?unit=2", "https://example.com?unit=3");  // query value
  differ("https://example.com?a=1&b=2", "https://example.com?b=2&a=1");// query order
  differ("https://example.com/p", "https://example.com/p#pricing");    // fragment
  differ("https://example.com:8080", "https://example.com");           // port
  differ("https://north.example.com", "https://example.com");          // subdomain
  differ("https://north.example.com", "https://south.example.com");    // subdomain
});

test("non-http schemes and unparseable input compare literally, never by guess", () => {
  same("mailto:a@example.com", "mailto:a@example.com");
  differ("mailto:a@example.com", "mailto:b@example.com");
  same("tel:+15555550100", "tel:+15555550100");
  assert.equal(normalizeDestination(""), null);
  assert.equal(normalizeDestination("   "), null);
  assert.equal(normalizeDestination(undefined), null);
});

test("hostLabel strips www and lowercases, and yields null when there is no host", () => {
  assert.equal(hostLabel("https://www.Clearwater.com/a/b"), "clearwater.com");
  assert.equal(hostLabel("clearwater.com"), "clearwater.com");
  assert.equal(hostLabel(""), null);
});

// ------------------------------------------------------------------
// Deduplication across links and contact websites
// ------------------------------------------------------------------
test("an item link and a contact website with the same destination render once", () => {
  const r = resolveCardLinks(
    [{ url: "https://www.oakmont.com/", label: "Website" }],
    ["oakmont.com"],
  );
  assert.equal(r.links.length, 1, "the item link survives");
  assert.deepEqual(r.contactWebsiteVisible, [false], "the contact duplicate is suppressed");
});

test("the item link keeps the placement — the contact website is the one dropped", () => {
  const r = resolveCardLinks(
    [{ url: "https://oakmont.com", label: "Tour details" }],
    ["https://www.oakmont.com/"],
  );
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].label, "Tour details", "author's item-link label is what shows");
  assert.deepEqual(r.contactWebsiteVisible, [false]);
});

test("two contacts sharing one website render it once", () => {
  const r = resolveCardLinks([], ["https://villa.example.org", "villa.example.org/"]);
  assert.deepEqual(r.contactWebsiteVisible, [true, false]);
});

test("a contact website that goes somewhere new still renders", () => {
  const r = resolveCardLinks(
    [{ url: "https://example.com/brochure.pdf", label: "Brochure" }],
    ["https://example.com/contact"],
  );
  assert.equal(r.links.length, 1);
  assert.deepEqual(r.contactWebsiteVisible, [true]);
});

test("exact duplicate item links collapse, keeping the first", () => {
  const r = resolveCardLinks(
    [{ url: "https://example.com", label: "First" }, { url: "https://www.example.com/", label: "Second" }],
    [],
  );
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].label, "First");
});

// ------------------------------------------------------------------
// Distinct destinations must survive, and be told apart
// ------------------------------------------------------------------
test("two different sites both labelled Website both survive, with hostname labels", () => {
  const r = resolveCardLinks(
    [
      { url: "https://clearwaterliving.com/communities/sonoma-hills/pricing", label: "Website" },
      { url: "https://clearwateratsonomahills.com", label: "Website" },
    ],
    [],
  );
  assert.equal(r.links.length, 2, "neither is deduplicated — different destinations");
  assert.deepEqual(
    r.links.map((l) => l.label),
    ["clearwaterliving.com", "clearwateratsonomahills.com"],
    "the hostname replaces the label that stopped distinguishing them",
  );
});

test("a label that is already unique is never replaced", () => {
  const r = resolveCardLinks(
    [
      { url: "https://example.com/a", label: "Website" },
      { url: "https://example.com/b.pdf", label: "Brochure" },
    ],
    [],
  );
  assert.deepEqual(r.links.map((l) => l.label), ["Website", "Brochure"]);
});

test("the fallback is skipped when hostnames also collide, rather than misleading", () => {
  const r = resolveCardLinks(
    [
      { url: "https://example.com/tour", label: "Website" },
      { url: "https://example.com/pricing", label: "Website" },
    ],
    [],
  );
  assert.equal(r.links.length, 2, "distinct paths both survive");
  assert.deepEqual(r.links.map((l) => l.label), ["Website", "Website"],
    "a shared hostname would not disambiguate, so the author's label stands");
});

test("only the link a hostname actually distinguishes gets the fallback", () => {
  const r = resolveCardLinks(
    [
      { url: "https://example.com/tour", label: "Website" },
      { url: "https://example.com/pricing", label: "Website" },
      { url: "https://north.example.com", label: "Website" },
    ],
    [],
  );
  assert.equal(r.links.length, 3);
  assert.deepEqual(r.links.map((l) => l.label), ["Website", "Website", "north.example.com"]);
});

test("a suppressed duplicate never triggers a fallback on the survivor", () => {
  // Without dedupe-before-count, these two "Website"s would look like a
  // collision and both would be relabelled.
  const r = resolveCardLinks(
    [{ url: "https://example.com", label: "Website" }, { url: "https://www.example.com/", label: "Website" }],
    [],
  );
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].label, "Website", "the lone survivor keeps its plain label");
});

// ------------------------------------------------------------------
// Labelling of unlabelled links (the fallback text is not invented)
// ------------------------------------------------------------------
test("smartLabel falls back to the same hostname text used for disambiguation", () => {
  assert.equal(smartLabel({ url: "https://www.example.com/x" }), "example.com");
  assert.equal(smartLabel({ url: "https://youtu.be/abc123" }), "Virtual Tour");
  assert.equal(smartLabel({ url: "https://example.com/a.pdf" }), "Brochure");
  assert.equal(smartLabel({ url: "https://google.com/maps/place/x" }), "View on Map");
  assert.equal(smartLabel({ url: "https://example.com", label: "Pricing" }), "Pricing");
});

test("empty and missing inputs are handled without throwing", () => {
  const r = resolveCardLinks(undefined, undefined);
  assert.deepEqual(r.links, []);
  assert.deepEqual(r.contactWebsiteVisible, []);
  const blank = resolveCardLinks([{ url: "  " }], [undefined, ""]);
  assert.deepEqual(blank.links, [], "a blank url is not a button");
  assert.deepEqual(blank.contactWebsiteVisible, [false, false]);
});
