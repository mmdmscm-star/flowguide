// Unit tests for exact media accounting (pure; no DB, no model).
// Run: node --test src/lib/media-ledger.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMediaUrl, extractSourceMedia, buildMediaLedger } from "./media-ledger.ts";

const P = "https://cdn.example.com/a1.jpg";
const Q = "https://cdn.example.com/a2.png";
const R = "https://cdn.example.com/a3.webp";

test("media is identified by extension, never by host", () => {
  for (const u of [P, Q, R, "http://x.test/IMG_0001.JPEG", "https://x.test/p/photo.heic?w=800"]) {
    assert.equal(isMediaUrl(u), true, u);
  }
  for (const u of ["https://example.com", "https://example.com/about", "https://x.test/tour.mp4",
                   "https://x.test/brochure.pdf", "mailto:a@b.com", ""]) {
    assert.equal(isMediaUrl(u), false, u);
  }
});

test("source media keeps its offset, in source order", () => {
  const src = `Item one\n\nImage 1: ${P}\n\nImage 2: ${Q}\n`;
  const found = extractSourceMedia(src);
  assert.deepEqual(found.map((f) => f.url), [P, Q]);
  assert.equal(found[0].offset, src.indexOf(P));
  assert.equal(found[1].offset, src.indexOf(Q));
});

test("website links are not media and never create a failure", () => {
  const src = `Drake Terrace\nhttps://draketerrace.com\nImage 1: ${P}`;
  const ledger = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }] });
  assert.equal(ledger.ok, true, "the website URL is out of scope by design");
  assert.equal(ledger.sourceCount, 1);
});

test("a missing photo is an objective failure", () => {
  const src = `A\nImage 1: ${P}\nImage 2: ${Q}`;
  const ledger = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }] });
  assert.equal(ledger.ok, false);
  assert.deepEqual(ledger.failures.map((f) => f.code), ["media_missing"]);
  assert.equal(ledger.failures[0].url, Q);
  assert.equal(ledger.failures[0].offset, src.indexOf(Q), "offset retained for the review UI");
});

test("the exact 2026-08-05 regression: three photos silently dropped", () => {
  const urls = Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/d${i + 1}.jpg`);
  const src = urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n\n");
  const stored = urls.slice(0, 6).map((u) => ({ url: u, itemId: "drake" }));
  const ledger = buildMediaLedger({ source: src, stored });
  assert.equal(ledger.ok, false, "the run must not finalize clean");
  assert.equal(ledger.failures.length, 3);
  assert.ok(ledger.failures.every((f) => f.code === "media_missing"));
});

test("the same photo on two items is a failure", () => {
  const src = `Image 1: ${P}`;
  const ledger = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }, { url: P, itemId: "i2" }] });
  assert.equal(ledger.ok, false);
  assert.equal(ledger.failures[0].code, "media_duplicated");
  assert.deepEqual(ledger.failures[0].itemIds, ["i1", "i2"]);
});

test("stored media absent from the source is a failure", () => {
  const ledger = buildMediaLedger({ source: `Image 1: ${P}`, stored: [
    { url: P, itemId: "i1" }, { url: Q, itemId: "i1" },
  ] });
  assert.equal(ledger.ok, false);
  assert.equal(ledger.failures[0].code, "media_not_in_source");
  assert.equal(ledger.failures[0].url, Q);
});

test("a deliberately rejected photo is accounted for, not a failure", () => {
  const src = `Image 1: ${P}\nImage 2: ${Q}`;
  const ledger = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }], rejected: [Q] });
  assert.equal(ledger.ok, true, "rejected-with-a-reason is a valid disposition");
});

test("the corrected packet accounts exactly", () => {
  // 8 / 2 / 9 across three items, every URL stored once.
  const mk = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `https://cdn.example.com/${tag}${i + 1}.jpg`);
  const atria = mk("atria", 8), alma = mk("alma", 2), drake = mk("drake", 9);
  const src = [...atria, ...alma, ...drake].map((u, i) => `Image ${i}: ${u}`).join("\n\n");
  const stored = [
    ...atria.map((u) => ({ url: u, itemId: "atria" })),
    ...alma.map((u) => ({ url: u, itemId: "alma" })),
    ...drake.map((u) => ({ url: u, itemId: "drake" })),
  ];
  const ledger = buildMediaLedger({ source: src, stored });
  assert.equal(ledger.ok, true);
  assert.equal(ledger.sourceCount, 19);
  assert.equal(ledger.storedCount, 19);
  assert.deepEqual(ledger.failures, []);
});

// OCCURRENCE-AWARE: an author who lists a photo twice is not the same thing as
// a duplicate FlowGuide introduced. The real client source lists one photo
// twice on purpose, so conflating the two hid a genuine defect behind a
// legitimate one.
test("a URL the source lists twice must be stored twice", () => {
  const src = `Image 1: ${P}\n\nImage 2: ${P}`;
  const twice = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }, { url: P, itemId: "i1" }] });
  assert.equal(twice.ok, true, "listed twice, stored twice = correct");
  assert.equal(twice.sourceCount, 1, "one distinct URL");
  assert.equal(twice.sourceOccurrences, 2, "two occurrences");

  const once = buildMediaLedger({ source: src, stored: [{ url: P, itemId: "i1" }] });
  assert.equal(once.ok, false, "listed twice, stored once = an occurrence is missing");
  assert.equal(once.failures[0].code, "media_missing");
  assert.equal(once.failures[0].sourceOccurrences, 2);
  assert.equal(once.failures[0].storedRows, 1);

  const thrice = buildMediaLedger({ source: src, stored: [
    { url: P, itemId: "i1" }, { url: P, itemId: "i1" }, { url: P, itemId: "i2" },
  ] });
  assert.equal(thrice.ok, false, "stored more often than listed = OUR duplicate");
  assert.equal(thrice.failures[0].code, "media_duplicated");
  assert.equal(thrice.failures[0].storedRows, 3);
});

test("trailing prose punctuation is not part of the URL", () => {
  const found = extractSourceMedia(`See ${P}, and also ${Q}.`);
  assert.deepEqual(found.map((f) => f.url), [P, Q]);
});
