import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { normalizeLinkUrl } from "./canonical.ts";
import { normalizeStagedLinks } from "./normalize-staged-links.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// THE RULE
//
// `finalize_ingestion_run` stores a link only when its url is LIKE 'http%'.
// A professional writing "riverbend.example.com" on a contact line produced a
// url the model placed correctly and the writer discarded in silence. The fix
// supplies the scheme; it must not widen what counts as a link.
// ---------------------------------------------------------------------------

test("AN ALREADY-VALID URL IS RETURNED BYTE-IDENTICAL", () => {
  for (const u of [
    "https://example.com",
    "http://example.com/page?q=1#frag",
    "https://EXAMPLE.com/Path",              // case is not ours to change
    "https://example.com/trailing/",         // nor is a trailing slash
    "https://example.com/a%20b",             // nor is existing encoding
    "HTTPS://example.com",
  ]) {
    assert.equal(normalizeLinkUrl(u), u, `rewrote ${u}`);
  }
});

test("a bare hostname is qualified, and only with https", () => {
  assert.equal(normalizeLinkUrl("riverbend.example.com"), "https://riverbend.example.com");
  assert.equal(normalizeLinkUrl("example.com/tours"), "https://example.com/tours");
  assert.equal(normalizeLinkUrl("www.example.com"), "https://www.example.com");
  assert.equal(normalizeLinkUrl("  example.com  "), "https://example.com");
  // A trailing slash on a bare host is dropped before qualifying, so the same
  // site written two ways does not become two different stored URLs.
  assert.equal(normalizeLinkUrl("example.com/"), "https://example.com");
});

test("AN UNSAFE SCHEME IS STILL REFUSED — this must never become a way in", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:pat@example.com",
    "tel:+16465550188",
  ]) {
    assert.equal(normalizeLinkUrl(hostile), null, `accepted ${hostile}`);
  }
});

test("the writer is not relaxed into accepting arbitrary strings", () => {
  for (const notALink of [
    "", "   ", "Call for pricing", "Ask about the September rate",
    "3,000 sq ft", "$1,800/day", "see attached", "Nia Patel",
    "TBD", "n/a", "12.50", "1,800",
  ]) {
    assert.equal(normalizeLinkUrl(notALink), null, `accepted ${JSON.stringify(notALink)}`);
  }
});

test("EMAIL ADDRESSES AND FILENAMES ARE NOT DOUBLE-HANDLED AS URLS", () => {
  // Both end in something that superficially looks like a hostname.
  for (const notAWebsite of [
    "pat@example.com", "bookings@riverbend.example.com",
    "notes.md", "shortlist.csv", "Q3 pricing.xlsx", "scan.pdf", "photo.jpg",
  ]) {
    assert.equal(normalizeLinkUrl(notAWebsite), null, `treated ${notAWebsite} as a website`);
  }
  // But a real site whose name collides with an extension-like suffix must
  // still work — .md is Moldova, and the guard is on the token, not the TLD.
  assert.equal(normalizeLinkUrl("https://example.md/page"), "https://example.md/page");
});

test("a non-string, null or undefined url is refused rather than coerced", () => {
  for (const junk of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeLinkUrl(junk), null, `accepted ${JSON.stringify(junk)}`);
  }
});

// ---------------------------------------------------------------------------
// APPLYING IT TO A STAGED RESULT
// ---------------------------------------------------------------------------

test("BOTH RESULT SHAPES ARE COVERED — flat items and sections[].items", () => {
  const flat = normalizeStagedLinks({
    items: [{ title: "A", links: [{ url: "example.com", label: "Site" }] }],
  }) as { items: { links: { url: string }[] }[] };
  assert.equal(flat.items[0].links[0].url, "https://example.com");

  const nested = normalizeStagedLinks({
    sections: [{ title: "S", items: [{ title: "A", links: [{ url: "example.com" }] }] }],
  }) as { sections: { items: { links: { url: string }[] }[] }[] };
  assert.equal(nested.sections[0].items[0].links[0].url, "https://example.com");
});

test("IT NEVER REMOVES A LINK AND NEVER INVENTS ONE", () => {
  const out = normalizeStagedLinks({
    items: [{ links: [
      { url: "example.com", label: "Site" },
      { url: "javascript:alert(1)", label: "Hostile" },
      { url: "Call for pricing", label: "Not a link" },
    ] }],
  }) as { items: { links: { url: string; label: string }[] }[] };
  const links = out.items[0].links;
  // Same count: what cannot be stored is left EXACTLY as it was, for the
  // writer to reject as it does today. Dropping it here would move a decision
  // out of the writer and hide it.
  assert.equal(links.length, 3);
  assert.equal(links[1].url, "javascript:alert(1)");
  assert.equal(links[2].url, "Call for pricing");
  // And labels are carried through untouched.
  assert.deepEqual(links.map((l) => l.label), ["Site", "Hostile", "Not a link"]);
});

test("everything other than links[].url survives untouched", () => {
  const input = {
    sections: [{
      title: "Shortlist",
      items: [{
        title: "Riverbend Studio",
        description: "3,000 sq ft.",
        details: [{ label: "Day rate", value: "$1,800/day" }],
        photos: [{ url: "riverbend.example.com/hero.jpg" }],
        contacts: [{ name: "Nia Patel", phone: "646-555-0188" }],
        links: [{ url: "riverbend.example.com" }],
      }],
    }],
  };
  const out = JSON.parse(JSON.stringify(normalizeStagedLinks(input)));
  const expected = JSON.parse(JSON.stringify(input));
  expected.sections[0].items[0].links[0].url = "https://riverbend.example.com";
  assert.deepEqual(out, expected);
});

test("PHOTOS ARE DELIBERATELY NOT QUALIFIED", () => {
  // Not an oversight. `mediaOccurrences` recognises media in the SOURCE only
  // when it is scheme-qualified, so qualifying a photo here alone would create
  // a photo the ledger cannot account for — and `media_not_in_source` BLOCKS
  // publishing. That turns a silent drop into a blocked packet.
  const out = normalizeStagedLinks({
    items: [{ photos: [{ url: "example.com/hero.jpg" }] }],
  }) as { items: { photos: { url: string }[] }[] };
  assert.equal(out.items[0].photos[0].url, "example.com/hero.jpg");
  // And the reason is written down where the next person will change it.
  assert.match(codeOf("src/lib/normalize-staged-links.ts"), /media_not_in_source/);
});

test("a result with nothing to normalize is returned unharmed", () => {
  for (const inert of [null, undefined, "text", 42, {}, { items: [] }, { items: [{ title: "A" }] },
                       { sections: [{ title: "S" }] }, { items: [{ links: [] }] }]) {
    assert.doesNotThrow(() => normalizeStagedLinks(inert));
  }
  assert.deepEqual(normalizeStagedLinks({ items: [{ title: "A" }] }), { items: [{ title: "A" }] });
  assert.equal(normalizeStagedLinks(null), null);
  // Malformed entries do not throw and do not disappear.
  const junk = normalizeStagedLinks({ items: [null, 5, { links: [null, "x"] }] }) as { items: unknown[] };
  assert.equal(junk.items.length, 3);
});

// ---------------------------------------------------------------------------
// WIRED IN — the fix is worth nothing if the staging path does not call it
// ---------------------------------------------------------------------------

test("EVERY STAGED RESULT GOES THROUGH IT, on both the success and the error path", () => {
  const route = codeOf("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");
  const calls = route.match(/normalizeStagedLinks\(/g) ?? [];
  // One import, plus the two places a result is staged.
  assert.ok(calls.length >= 2, `staged in fewer places than expected: ${calls.length}`);
  assert.match(route, /staged[^\n]*=\s*normalizeStagedLinks\(outcome\.result\)/,
    "the accepted result is staged unnormalized");
  assert.match(route, /staged\s*=\s*normalizeStagedLinks\(e\.result\)/,
    "the repaired/unresolved result is staged unnormalized");
  // Nothing may stage a raw result alongside these.
  assert.doesNotMatch(route, /staged[^\n]*=\s*outcome\.result\s*;/, "a raw result is still staged");
});

test("THE WRITER'S STRICT GATE IS STILL STRICT — both finalize branches", () => {
  // Read whichever migration DEFINES finalize_ingestion_run last.
  //
  // This used to grep for the NAME, which quietly means "last file that mentions
  // it". 0045 mentions it in a comment — to record that it was deliberately NOT
  // re-issued — and that was enough to point this test at a migration containing
  // no writer at all, where it found zero gates and failed. A migration is
  // allowed to talk about a function without redefining it, so the search is for
  // the definition.
  const files = execSync("grep -rlE 'create or replace function public\\.finalize_ingestion_run|CREATE OR REPLACE FUNCTION public\\.finalize_ingestion_run' supabase/migrations | sort")
    .toString().trim().split("\n").filter(Boolean);
  const latest = codeOf(files[files.length - 1]);
  const gates = latest.match(/like 'http%'/gi) ?? [];
  assert.ok(gates.length >= 2, `expected the gate in both branches, found ${gates.length}`);
  assert.doesNotMatch(latest, /like '%'|coalesce\(l->>'url',''\)\s*<>\s*''/i,
    "the writer was relaxed instead of the input being normalized");
});
