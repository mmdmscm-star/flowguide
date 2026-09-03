// Gates on everything a stranger can see: the landing page, the public demo,
// the metadata, and the /new gate.
//
// These pin decisions that are invisible in review and expensive to get wrong.
// The demo this replaced attributed invented prices and invented staff to four
// real companies, and leaked its own private note into the page source — both
// live, on the URL the landing page now points at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { samplePacket } from "./sample-data.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const LANDING = "src/app/page.tsx";
const DEMO_SRC = "src/lib/sample-data.ts";

/** Every string the demo would put on screen. */
function demoStrings(): string[] {
  const out: string[] = [samplePacket.title, samplePacket.clientName ?? "", samplePacket.personalNote ?? ""];
  const pro = samplePacket.professional as Record<string, unknown>;
  for (const v of Object.values(pro)) if (typeof v === "string") out.push(v);
  for (const s of samplePacket.sections) {
    out.push(s.title ?? "", s.description ?? "");
    for (const i of s.items) {
      out.push(i.title, i.description ?? "", i.address ?? "");
      for (const d of i.details ?? []) out.push(d.label, d.value);
      for (const l of i.links ?? []) out.push(l.url, l.label ?? "");
      for (const c of i.contacts ?? []) out.push(c.name ?? "", c.role ?? "", c.phone ?? "", c.email ?? "");
      for (const p of i.photos ?? []) out.push(p);
    }
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// THE DEMO CARRIES NOTHING PRIVATE
// ---------------------------------------------------------------------------

test("THE DEMO HAS NO PRIVATE NOTE ANYWHERE", () => {
  // /p/demo resolves this object DIRECTLY, not through getPublishedPacket, so
  // the usual stripping never runs — and ItemCard is a client component, so
  // anything handed to it is serialised into the RSC payload and readable in
  // view-source even when it is never drawn. The previous demo leaked its note
  // exactly that way. A fixture must carry nothing private at all.
  for (const s of samplePacket.sections) {
    for (const i of s.items) {
      assert.equal(i.notes, undefined, `demo item "${i.title}" carries a private note`);
    }
  }
  assert.doesNotMatch(codeOf(DEMO_SRC), /\bnotes:/, "the demo fixture declares a notes field");
});

// ---------------------------------------------------------------------------
// EVERYTHING IN THE DEMO IS INVENTED
// ---------------------------------------------------------------------------

test("no real business is given invented prices, staff or addresses", () => {
  // The four operators the old demo used, plus the vocabulary that identified
  // its vertical. None may reappear in anything a stranger can read.
  const forbidden = [
    "Sunrise", "Brookdale", "Oakmont", "Pacifica",
    "senior", "assisted living", "memory care", "placement",
  ];
  const haystack = demoStrings().join(" \n ").toLowerCase();
  for (const word of forbidden) {
    assert.ok(!haystack.includes(word.toLowerCase()), `the public demo says "${word}"`);
  }
});

test("contact details use the ranges reserved for fiction", () => {
  const strings = demoStrings();
  const phones = strings.filter((s) => /^\(\d{3}\) \d{3}-\d{4}$/.test(s.trim()));
  assert.ok(phones.length >= 4, `expected several phone numbers, found ${phones.length}`);
  for (const p of phones) {
    // 555-0100..555-0199 is the block reserved for fictional use.
    assert.match(p, /\) 555-01\d\d$/, `${p} is not a reserved fictional number`);
  }

  const emails = strings.filter((s) => s.includes("@"));
  assert.ok(emails.length >= 4, `expected several emails, found ${emails.length}`);
  for (const e of emails) {
    // .example.com is reserved by RFC 2606 and cannot be registered.
    assert.match(e, /@[\w.-]*example\.com$/, `${e} is not a reserved example domain`);
  }

  for (const l of strings.filter((s) => /^https?:\/\//.test(s))) {
    const host = new URL(l).hostname;
    const ok = host.endsWith("example.com") || host === "images.unsplash.com";
    assert.ok(ok, `${host} is neither a reserved example domain nor the stock photo host`);
  }
});

test("the demo exercises the product rather than gesturing at it", () => {
  const items = samplePacket.sections.flatMap((s) => s.items);
  assert.ok(samplePacket.sections.length >= 3, "fewer than three sections");
  assert.ok(items.length >= 5, "fewer than five items");
  // Two items in a section is what makes the contents index appear.
  assert.ok(samplePacket.sections.some((s) => s.items.length >= 2), "no section has an index");
  assert.ok(items.filter((i) => (i.photos ?? []).length >= 2).length >= 3, "too few galleries");
  assert.ok(items.filter((i) => (i.details ?? []).length >= 4).length >= 3, "too few detail tables");
  assert.ok(items.some((i) => (i.contacts ?? []).length > 0), "no contacts");
  assert.ok(items.some((i) => (i.links ?? []).length > 0), "no links");
  assert.ok((samplePacket.personalNote ?? "").length > 200, "the personal note is not doing real work");
  const pro = samplePacket.professional;
  assert.ok(pro.name && pro.businessName && pro.phone && pro.email, "the demo has no professional identity");
});

// ---------------------------------------------------------------------------
// THE LANDING PAGE
// ---------------------------------------------------------------------------

test("the landing page answers all seven questions, in order", () => {
  const src = codeOf(LANDING);
  const beats = [
    "Everything you found",                       // what it is
    "isn’t missing. It’s scattered",              // why it exists
    "What goes in, and what comes out",           // in / out
    "Three steps",                                // what it does
    "Four ways to hand it over",                  // what comes out
    "Build it once",                              // versus rebuilding
    "Start with one real client",                 // what to do next
  ];
  let at = -1;
  for (const beat of beats) {
    const i = src.indexOf(beat);
    assert.ok(i > -1, `the landing page is missing: ${beat}`);
    assert.ok(i > at, `out of order: ${beat}`);
    at = i;
  }
});

test("public copy says GUIDE, never packet", () => {
  const src = codeOf(LANDING);
  assert.doesNotMatch(src, /\bpackets?\b/i, "the landing page uses internal vocabulary");
  assert.match(src, /client-ready guide/, "the hero subhead changed");
});

test("the landing page is horizontal — no vertical lock-in", () => {
  const src = codeOf(LANDING).toLowerCase();
  for (const w of ["senior", "assisted living", "memory care", "placement", "real estate"]) {
    assert.ok(!src.includes(w), `the landing page names a vertical: ${w}`);
  }
});

test("the trust-model claim is about REVIEW, not about the model", () => {
  const src = codeOf(LANDING);
  // An absolute claim we cannot stand behind.
  assert.doesNotMatch(src, /doesn.t invent|never invents|no hallucination/i,
    "the page makes an absolute claim about model output");
  assert.match(src, /You stay in the middle/, "the trust-model paragraph is gone");
  assert.match(src, /nothing reaches your client until/, "the review guarantee is gone");
});

test("both CTAs, pointing where they should", () => {
  const src = codeOf(LANDING);
  assert.match(src, /See a real Sendset/);
  assert.match(src, /Start your first Sendset/);
  assert.ok(src.includes('href="/p/demo"'), "the primary CTA does not reach the demo");
  assert.ok(src.includes('href="/login"'), "the secondary CTA does not reach sign-in");
  // No social proof we do not have.
  assert.doesNotMatch(src, /trusted by|customers|testimonial|thousands of/i,
    "the page claims social proof that does not exist");
});

// ---------------------------------------------------------------------------
// THE /new GATE AND THE METADATA
// ---------------------------------------------------------------------------

test("/new GATES BEFORE THE PASTE BOX RENDERS", () => {
  const page = codeOf("src/app/new/page.tsx");
  assert.match(page, /getSession\(\)/, "/new does not check for a session");
  assert.match(page, /redirect\("\/login\?next=new"\)/, "/new does not send them to sign in");
  // The gate must be server-side. A client-side check would still render the
  // box first, which is the bug.
  assert.doesNotMatch(page, /"use client"/, "/new is gated on the client, so the box still renders");
  // And the login page has to say why they arrived.
  assert.match(codeOf("src/app/login/page.tsx"), /next === "new"/,
    "login does not explain the redirect");
});

test("metadata is written for a stranger, and carries one static card", () => {
  const layout = codeOf("src/app/layout.tsx");
  assert.doesNotMatch(layout, /Living client packets/, "the old internal description survives");
  assert.match(layout, /openGraph/, "no link preview is defined");
  assert.match(layout, /\/og\.png/, "the static card is not referenced");
  // One static asset, not a generator.
  assert.doesNotMatch(layout, /ImageResponse|opengraph-image/,
    "an OG generation system was introduced");
});
