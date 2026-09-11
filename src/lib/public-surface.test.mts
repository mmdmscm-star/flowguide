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
import { PUBLIC_DEMOS } from "./public-demos.ts";
import type { Packet } from "./types.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** The same source with runs of whitespace flattened to one space.
 *
 *  PROSE IN JSX WRAPS. A sentence on the page is several lines in the file,
 *  broken wherever the line length ran out, so a regex written against the
 *  sentence fails against the file — and shortening it until it fits one line
 *  only pins the assertion to today's wrapping. Every check below that is about
 *  what a VISITOR READS goes through here; checks about the code's shape do
 *  not. */
const proseOf = (p: string) => codeOf(p).replace(/\s+/g, " ");

const LANDING = "src/app/page.tsx";
/** The fixture FILES, for the checks that read source rather than values. */
const DEMO_SOURCES = [
  "src/lib/sample-data.ts",
  "src/lib/demo-harbor-house.ts",
  "src/lib/demo-month-one.ts",
  "src/lib/demo-red-awning.ts",
];

/** Every string ONE demo would put on screen. */
function stringsOf(packet: Packet): string[] {
  const out: string[] = [
    packet.title, packet.clientTitle ?? "", packet.clientName ?? "", packet.personalNote ?? "",
  ];
  const pro = packet.professional as Record<string, unknown>;
  for (const v of Object.values(pro)) if (typeof v === "string") out.push(v);
  for (const s of packet.sections) {
    out.push(s.title ?? "", s.description ?? "");
    for (const i of s.items) {
      out.push(i.title, i.description ?? "", i.address ?? "", i.highlight ?? "");
      for (const d of i.details ?? []) out.push(d.label, d.value);
      for (const l of i.links ?? []) out.push(l.url, l.label ?? "");
      for (const c of i.contacts ?? []) out.push(c.name ?? "", c.role ?? "", c.phone ?? "", c.email ?? "");
      for (const p of i.photos ?? []) out.push(p);
    }
  }
  return out.filter(Boolean);
}

/** …and every string EVERY demo would, which is what the safety rules read.
 *
 *  These used to read one object. The rules below are about things a diff
 *  cannot show — whether a business is real, whether a phone number belongs to
 *  somebody — so a demo they do not visit is a demo nobody checked. */
const ALL_DEMO_STRINGS = PUBLIC_DEMOS.flatMap(stringsOf);

/** Iterate demos with their slug, so a failure names the fixture at fault. */
const eachDemo = (fn: (packet: Packet, where: string) => void) => {
  for (const d of PUBLIC_DEMOS) fn(d, `/p/${d.slug}`);
};

// ---------------------------------------------------------------------------
// THE DEMO CARRIES NOTHING PRIVATE
// ---------------------------------------------------------------------------

test("THE DEMO HAS NO PRIVATE NOTE ANYWHERE", () => {
  // /p/demo resolves this object DIRECTLY, not through getPublishedPacket, so
  // the usual stripping never runs — and ItemCard is a client component, so
  // anything handed to it is serialised into the RSC payload and readable in
  // view-source even when it is never drawn. The previous demo leaked its note
  // exactly that way. A fixture must carry nothing private at all.
  eachDemo((packet, where) => {
    for (const s of packet.sections)
      for (const i of s.items)
        assert.equal(i.notes, undefined, `${where}: item "${i.title}" carries a private note`);
  });
  for (const src of DEMO_SOURCES)
    assert.doesNotMatch(codeOf(src), /\bnotes:/, `${src} declares a notes field`);
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
  const haystack = ALL_DEMO_STRINGS.join(" \n ").toLowerCase();
  for (const word of forbidden) {
    assert.ok(!haystack.includes(word.toLowerCase()), `the public demo says "${word}"`);
  }
});

test("contact details use the ranges reserved for fiction", () => {
  const strings = ALL_DEMO_STRINGS;
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

test("EVERY DEMO IS SERVED, AND ONLY ONCE", () => {
  // A fixture that is not in the registry is not under the rules above, and a
  // duplicate slug means one of two demos silently never renders.
  assert.ok(PUBLIC_DEMOS.length >= 1, "there are no public demos");
  const slugs = PUBLIC_DEMOS.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length, `two demos share a slug: ${slugs}`);
  for (const slug of slugs)
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${slug}" is not a URL-safe slug`);
  assert.ok(slugs.includes("demo"),
    "the slug the landing page's primary call to action points at is gone");
});

test("EVERY DEMO CLEARS THE FLOOR, whatever it is a demo of", () => {
  // THE FLOOR, NOT THE FLAGSHIP'S BAR. The venue demo is a comparison with
  // opinions in it, and it carries contacts and links because a venue has a
  // manager and a website. A menu does not, and neither does a plank. Applying
  // that bar to every fixture would force an invented phone number onto a taco
  // — which is worse than a thin demo, because it is a fact nobody needed and
  // one more thing that has to be fictional.
  //
  // What every demo must be is SUBSTANTIAL and LEGIBLE: enough content to read
  // as work somebody did, at least one gallery so it is not a wall of text,
  // details on most of its items, a heading, and someone behind it.
  eachDemo((packet, where) => {
    const items = packet.sections.flatMap((s) => s.items);
    assert.ok(packet.sections.length >= 2, `${where}: fewer than two sections`);
    assert.ok(items.length >= 4, `${where}: fewer than four items`);
    assert.ok(packet.sections.some((s) => s.items.length >= 2),
      `${where}: no section has enough items to show an index`);
    assert.ok(items.filter((i) => (i.photos ?? []).length >= 2).length >= 1,
      `${where}: not one gallery — it will read as a wall of text`);
    const withDetails = items.filter((i) => (i.details ?? []).length >= 3);
    assert.ok(withDetails.length * 2 >= items.length,
      `${where}: only ${withDetails.length} of ${items.length} items carry details`);
    assert.ok((packet.personalNote ?? "").length > 150,
      `${where}: the note is not doing real work`);
    assert.ok((packet.clientTitle ?? "").trim(),
      `${where}: no recipient-facing heading, so the page opens with no title`);
    const pro = packet.professional;
    assert.ok(pro.name && pro.businessName && pro.phone && pro.email,
      `${where}: nobody is behind this Sendset`);
  });
});

test("the FLAGSHIP demo exercises the product rather than gesturing at it", () => {
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
    "Start with what you have",                   // what it is
    "isn’t missing. It’s scattered",              // why it exists
    "What goes in, and what comes out",           // in / out
    "Three steps",                                // what it does
    "Four ways to hand it over",                  // what comes out
    "Build it once",                              // versus rebuilding
    "Start with one you really have to send",     // what to do next
  ];
  let at = -1;
  for (const beat of beats) {
    const i = src.indexOf(beat);
    assert.ok(i > -1, `the landing page is missing: ${beat}`);
    assert.ok(i > at, `out of order: ${beat}`);
    at = i;
  }
});

test("public copy says SENDSET — not packet, and no longer guide", () => {
  // "Guide" was the PUBLIC SUBSTITUTE for "packet", chosen when the object had
  // no name of its own. It does have one now, and the app says it on every
  // screen: My Sendsets, New Sendset, this Sendset. A visitor met "guide"
  // outside and "Sendset" inside, which is one object with two names.
  const src = codeOf(LANDING);
  assert.doesNotMatch(src, /\bpackets?\b/i, "the landing page uses internal vocabulary");
  assert.doesNotMatch(src, /\bguides?\b/i, "the landing page still calls a Sendset a guide");
  // Named where a name can be introduced: as a countable object, not inside the
  // subhead, where "Sendset helps you shape it into a Sendset" is the tautology
  // the /new copy already had to be corrected for.
  assert.match(proseOf(LANDING), /A Sendset: one clear, organized version of what you/,
    "section 3 no longer says what a Sendset is");
  assert.match(src, /See a real Sendset/, "the object is never named as a countable thing");
});

test("PDF IS AN OUTPUT, NEVER AN INPUT", () => {
  // /new refuses both by name — "can\u2019t read PDFs yet", "Word documents" — and the
  // page used to list "a PDF someone sent you" among the material you arrive
  // with. Whatever the page says goes in has to be something that does.
  const src = codeOf(LANDING);
  for (const line of src.split("\n")) {
    if (!/\bPDFs?\b|\bWord\b|\.docx|\.xlsx/i.test(line)) continue;
    // The one legitimate mention: the list of ways a finished Sendset goes out.
    assert.match(line, /link, email, message, print, or PDF/,
      `the landing page mentions a format it cannot read: ${line.trim()}`);
  }
  // And the input list names only what /new accepts.
  const prose = proseOf(LANDING);
  assert.match(prose, /a spreadsheet saved as CSV/, "the In panel overstates what it reads");
  assert.match(prose, /photograph the pages you were handed/,
    "photographed pages — the input the page never mentioned — are gone again");
});

test("THE AUDIENCE IS NOT ONLY ADVISORS", () => {
  // Every one of these narrowed the product to someone who researches on
  // another person's behalf. A small business sending its own prices is doing
  // the same job with material that was always theirs.
  const prose = proseOf(LANDING);
  assert.doesNotMatch(prose, /who researches options on someone/,
    "the audience is defined as researchers again");
  assert.match(prose, /Small businesses sending their own options, prices or schedules/,
    "the audience no longer includes people communicating their own information");
  assert.match(prose, /whether you gathered it on their behalf or it was yours to begin with/,
    "the page no longer says both kinds of material count");
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
  // BROADER THAN "your client", same guarantee: the thing being described is one
  // person putting information in front of another, which is not always advice
  // and not always a client.
  assert.match(proseOf(LANDING), /nothing reaches anyone until you/, "the review guarantee is gone");
  // WHAT THE PRODUCT NOTICES, NOT WHAT IT CATCHES. "Sendset says so when the
  // source contradicts itself" reads as a promise to detect every case. It asks
  // about what it spots, and claims nothing about what it does not.
  assert.match(proseOf(LANDING),
    /When Sendset spots something that needs your attention, it asks you to review it before you send/,
    "the review prompt is gone");
  assert.doesNotMatch(src, /\balways\b[^.]*\b(spot|catch|detect|flag)|\b(catches|detects|spots) (any|every|all)/i,
    "the page promises to catch everything");
  // The old comprehension claim, in the words it used.
  assert.doesNotMatch(src, /reads it and pulls out/,
    "step one claims to understand whatever it is given");
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
  // A JPEG since the card became a photograph of the product rather than a
  // page of type — a PNG of that material is ~450KB for no visible gain.
  assert.match(layout, /\/og\.jpg/, "the static card is not referenced");
  // One static asset, not a generator.
  assert.doesNotMatch(layout, /ImageResponse|opengraph-image/,
    "an OG generation system was introduced");
});
