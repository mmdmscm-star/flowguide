import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recipientMetadata, recipientTitle, RECIPIENT_DESCRIPTION,
         DEMO_EXPERIMENT as DEMO_EXPERIMENT_SLUGS } from "./recipient-metadata.ts";
import { PUBLIC_DEMOS } from "./public-demos.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicationSnapshot, publishedSenderIdentity } from "./queries.ts";
import { resolvePublishIdentity } from "./publish-identity.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A PNG's real dimensions, straight out of its IHDR. Asserted against what the
 *  metadata DECLARES: a card whose declared size disagrees with the file is
 *  laid out wrongly by unfurlers, which is the exact variable under test. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  assert.equal(b.readUInt32BE(12), 0x49484452, `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
const RECIPIENT_ROUTES = ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx"];

/** The exact strings that reached a client's text message. Kept verbatim even
 *  though the landing page no longer says any of them: this is the incident,
 *  and a guard that forgets what happened is a guard that lets it happen the
 *  same way twice. */
const LEAKED = [
  "Everything you found",
  "Turn the notes you already have",
  "your client can actually use",
  "/og.png",
  "/og.jpg",
];

/** …and whatever the marketing description SAYS TODAY, read from the root
 *  layout rather than copied here.
 *
 *  A frozen list stops protecting the moment the copy changes — it went stale
 *  on the first landing-page rewrite and would have watched the new sentence
 *  leak without failing. What must never ride along with a client's link is the
 *  CURRENT marketing copy, so the current marketing copy is what this reads. */
function liveMarketingDescription(): string {
  const m = /description:\s*\n?\s*"([^"]{40,})"/.exec(codeOf("src/app/layout.tsx"));
  assert.ok(m, "the root layout declares no marketing description to protect against");
  return m![1];
}

const MARKETING = [...LEAKED, liveMarketingDescription()];

/** A Sendset's private material, in the shape a careless caller would have it.
 *  Every value is distinctive enough that finding it in a meta tag is proof,
 *  not coincidence — an empty-set check would pass while leaking. */
const PRIVATE = {
  clientTitle: "Options for the Alvarez family",
  clientName: "Marisol Alvarez",
  personalNote: "Dad's memory got worse after the fall, so I looked at these.",
  sections: [{ title: "Recommended Communities", items: [{ title: "Sunrise of Maplewood" }] }],
  blocks: [{ kind: "heading", text: "Visit these first" }],
  slug: "r6cdwbk3",
  email: "ramona@example.com",
  phone: "(555) 010-4194",
};

// ---------------------------------------------------------------------------
// WHAT THE PREVIEW SAYS
// ---------------------------------------------------------------------------

test("the sender's name leads, their business is the fallback, and neither is required", () => {
  assert.equal(recipientTitle({ name: "Ramona Maurer" }), "Ramona Maurer shared this with you");
  assert.equal(recipientTitle({ businessName: "Harbor House Advisors" }),
    "Harbor House Advisors shared this with you");
  // A name WINS over a business name; both present must not concatenate.
  assert.equal(recipientTitle({ name: "Ramona Maurer", businessName: "Harbor House Advisors" }),
    "Ramona Maurer shared this with you");
  assert.equal(recipientTitle(null), "A Sendset has been shared with you");
  assert.equal(recipientTitle({}), "A Sendset has been shared with you");
  assert.equal(RECIPIENT_DESCRIPTION, "View on Sendset.");
});

test("an unsigned Sendset is ANONYMOUS, not blank", () => {
  // 8 of the 33 publications live when this was written carry neither field,
  // so whitespace and empty strings are a real path, not a hypothetical. The
  // failure being guarded is " shared this with you".
  for (const sender of [{ name: "" }, { name: "   " }, { businessName: " " },
                        { name: "  ", businessName: "" }, undefined]) {
    assert.equal(recipientTitle(sender), "A Sendset has been shared with you",
      `an empty sender produced a title: ${JSON.stringify(sender)}`);
  }
  assert.doesNotMatch(recipientTitle({ name: " " }), /^\s|\s{2}/, "the title starts with whitespace");
});

test("the title is carried into BOTH cards, not just the document", () => {
  const m = recipientMetadata({ name: "Ramona Maurer" });
  const og = m.openGraph as Record<string, unknown>;
  const tw = m.twitter as Record<string, unknown>;
  assert.equal(m.title, "Ramona Maurer shared this with you");
  assert.equal(og.title, "Ramona Maurer shared this with you");
  assert.equal(tw.title, "Ramona Maurer shared this with you");
  assert.equal(og.description, RECIPIENT_DESCRIPTION);
  assert.equal(tw.description, RECIPIENT_DESCRIPTION);
});

// ---------------------------------------------------------------------------
// THE PRIVACY BOUNDARY
//
// An unfurl leaves our control completely: iMessage, Slack and WhatsApp fetch
// the URL, cache what they find, and keep it in the thread after the Sendset is
// unpublished. `robots: noindex` does not govern unfurl bots. So the rule is
// not "be careful" — it is that nothing but the sender can get in.
// ---------------------------------------------------------------------------

test("NOTHING PRIVATE REACHES A PREVIEW, even when a caller hands it over", () => {
  // The builder takes SenderIdentity, but a caller can spread a whole packet
  // into that argument and TypeScript will not always stop them. It must read
  // the two fields it wants and ignore the rest.
  const m = recipientMetadata({ name: "Ramona Maurer", ...PRIVATE } as never);
  const serialized = JSON.stringify(m);
  for (const [field, value] of Object.entries(PRIVATE)) {
    const needle = typeof value === "string" ? value : JSON.stringify(value).slice(1, 40);
    assert.ok(!serialized.includes(needle), `${field} reached the preview: ${needle}`);
  }
  // And the one thing that SHOULD be there still is — otherwise this test
  // passes on a builder that emits nothing at all.
  assert.ok(serialized.includes("Ramona Maurer shared this with you"),
    "the sender's name is missing; this test would pass on an empty object");
});

test("NO MARKETING COPY REACHES A RECIPIENT PREVIEW", () => {
  for (const sender of [null, { name: "Ramona Maurer" }, { businessName: "Harbor House Advisors" }]) {
    const serialized = JSON.stringify(recipientMetadata(sender));
    for (const m of MARKETING) {
      assert.ok(!serialized.includes(m), `marketing string in recipient metadata: ${m}`);
    }
  }
});

test("the ROUTES may hand the builder nothing but a sender", () => {
  // The load-bearing guarantee, now that the metadata is per-Sendset. It used
  // to be "this is a constant"; a constant cannot leak, but it also cannot say
  // who sent it. What replaces it is narrower: the only value that reaches
  // generateMetadata is publishedSenderIdentity(slug), which by construction
  // returns a name and a business name and nothing else.
  const FORBIDDEN = [
    "getPublishedPacket", "resolvePacket", "clientTitle", "clientName",
    "personalNote", "sections", "blocks", "items", "packet",
  ];
  for (const route of RECIPIENT_ROUTES) {
    const src = codeOf(route);
    const at = src.indexOf("export async function generateMetadata");
    assert.ok(at >= 0, `${route} no longer builds metadata from the shared builder`);
    // The function BODY. Not "the first { after the signature" — that is the
    // destructured `{ params }` argument, and matching it made this assertion
    // read a two-word string and pass on nothing. Skip the parameter list by
    // paren matching first, then take the brace after it.
    let pd = 0, afterParams = at;
    for (let i = src.indexOf("(", at); i < src.length; i++) {
      if (src[i] === "(") pd++;
      else if (src[i] === ")" && --pd === 0) { afterParams = i; break; }
    }
    const open = src.indexOf("{", afterParams);
    let depth = 0, end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = src.slice(open, end + 1);
    assert.match(body, /publishedSenderIdentity\(/,
      `${route} builds its preview from something other than the sender identity`);
    assert.match(body, /recipientMetadata\(/, `${route} does not use the shared builder`);
    for (const f of FORBIDDEN) {
      assert.ok(!body.includes(f), `${route}'s generateMetadata touches ${f} — private material can reach a preview`);
    }
  }
});

test("publishedSenderIdentity RETURNS TWO FIELDS, whatever the snapshot holds", () => {
  // PostgREST returns the aliased jsonb path as `professional`; the fake
  // mirrors that shape. The contact details in the row are the point: the
  // function must drop them rather than hand a caller something to leak.
  const db = fakeDb({
    packets: [{ id: "p1", slug: "abc", status: "published" }],
    packet_publications: [{
      packet_id: "p1",
      professional: {
        name: "Ramona Maurer", businessName: "Harbor House Advisors",
        email: "ramona@example.com", phone: "(555) 010-4194",
        headshotUrl: "https://example.com/r.jpg", logoUrl: "https://example.com/l.png",
        footerLabel: "Your Advisor", websiteUrl: "https://example.com", links: [],
      },
    }],
  });
  return publishedSenderIdentity("abc", db as never).then((sender) => {
    assert.deepEqual(Object.keys(sender ?? {}).sort(), ["businessName", "name"]);
    assert.equal(sender?.name, "Ramona Maurer");
    assert.equal(sender?.businessName, "Harbor House Advisors");
    const serialized = JSON.stringify(recipientMetadata(sender));
    for (const leak of ["ramona@example.com", "555) 010-4194", "r.jpg", "l.png"]) {
      assert.ok(!serialized.includes(leak), `a contact detail reached the preview: ${leak}`);
    }
  });
});

test("an unpublished or missing slug yields NO sender, not a guess", () => {
  const rows = {
    packets: [{ id: "p1", slug: "abc", status: "draft" }],
    packet_publications: [{ packet_id: "p1", professional: { name: "Ramona Maurer" } }],
  };
  return Promise.all([
    publishedSenderIdentity("abc", fakeDb(rows) as never),
    publishedSenderIdentity("nope", fakeDb(rows) as never),
    publishedSenderIdentity("abc", fakeDb({ ...rows, packets: [{ id: "p1", slug: "abc", status: "published" }] }, ["packet_publications"]) as never),
  ]).then(([draft, missing, broken]) => {
    assert.equal(draft, null, "a draft's sender was published to a preview");
    assert.equal(missing, null);
    assert.equal(broken, null, "a failed read invented a sender");
    assert.equal(recipientTitle(draft), "A Sendset has been shared with you");
  });
});

test("the sender is read from ONE jsonb path, not the whole snapshot", () => {
  // A `select("*")` here would pull every item, note and client name of the
  // largest publication into the metadata layer — 37KB of private material
  // that only needs to be near a meta tag once to end up in one.
  const src = codeOf("src/lib/queries.ts");
  const at = src.indexOf("export async function publishedSenderIdentity");
  assert.ok(at >= 0, "publishedSenderIdentity is gone");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /select\("professional:content->professional"\)/,
    "the sender read is no longer a narrow jsonb path");
  assert.ok(!/select\("\*"\)|select\("content"\)/.test(body),
    "the whole publication is being read to build a preview");
  assert.match(body, /\.eq\("status", "published"\)/,
    "an unpublished Sendset's sender can reach a preview");
});

// ---------------------------------------------------------------------------
// THE PREVIEW OBEYS THE SENDER CHOICE ALREADY MADE FOR THE SENDSET
//
// The editor asks "Who is this Sendset from?" and offers three answers. The
// preview does not get its own opinion: it reads whatever that choice froze
// into the publication, so the name in an unfurl is the name in the footer.
//
// Exercised through the REAL chain — resolvePublishIdentity, then
// buildPublicationSnapshot — rather than against a hand-written snapshot,
// because the failure this guards against lives in the conversions between
// them: custom_identity is camelCase, the assembly wants a snake_case profile
// row, and the stored professional is camelCase again. A businessName dropped
// in the middle would show a client one sender on the page and another in the
// message that carried it.
//
// It matters most for CUSTOM, which no production Sendset uses yet: nothing
// else in the suite would notice that branch breaking.
// ---------------------------------------------------------------------------

test("every Sender choice resolves into the title the professional asked for", async () => {
  const PROFILE = {
    name: "Ramona Maurer", business_name: "Harbor House Advisors",
    email: "ramona@example.com", phone: "(555) 010-4194",
  };
  const CUSTOM = {
    name: "Mona Okafor", businessName: "Okafor Placement Partners",
    email: "mona@example.com",
  };

  const cases: { choice: string; packet: Row; profile: unknown; skip?: boolean; title: string }[] = [
    { choice: "My default profile", packet: { id: "p1", identity_mode: "default" },
      profile: PROFILE, title: "Ramona Maurer shared this with you" },
    { choice: "No sender", packet: { id: "p1", identity_mode: "none" },
      profile: PROFILE, title: "A Sendset has been shared with you" },
    { choice: "Custom organization", packet: { id: "p1", identity_mode: "custom", custom_identity: CUSTOM },
      profile: PROFILE, title: "Mona Okafor shared this with you" },
    // A custom sender is free to be an organisation and no person at all.
    { choice: "Custom, business only",
      packet: { id: "p1", identity_mode: "custom", custom_identity: { businessName: "Okafor Placement Partners" } },
      profile: PROFILE, title: "Okafor Placement Partners shared this with you" },
    // "Publish anyway" stores {} — the same empty identity as No sender.
    { choice: "default, published anyway", packet: { id: "p1", identity_mode: "default" },
      profile: null, skip: true, title: "A Sendset has been shared with you" },
    // An absent column is the default mode, not an unhandled case.
    { choice: "identity_mode never set", packet: { id: "p1" },
      profile: PROFILE, title: "Ramona Maurer shared this with you" },
  ];

  for (const { choice, packet, profile, skip, title } of cases) {
    const { professionalSnapshot } = resolvePublishIdentity(packet as never, profile, !!skip);
    const snapshot = await buildPublicationSnapshot(snapshotDb(packet) as never, "p1", professionalSnapshot);
    const p = snapshot.professional as Record<string, unknown> | undefined;
    // The same two fields publishedSenderIdentity would lift out of the stored row.
    const sender = {
      name: typeof p?.name === "string" && p.name.trim() ? p.name : undefined,
      businessName: typeof p?.businessName === "string" && p.businessName.trim() ? p.businessName : undefined,
    };
    assert.equal(recipientTitle(sender), title, `"${choice}" produced the wrong preview title`);
  }
});

test("NO SENDER MEANS NO SENDER, in the preview as much as in the footer", async () => {
  // The strongest case, and the one with 8 live Sendsets behind it. Choosing
  // "No sender — no name, logo, or contact footer" and then having the unfurl
  // announce the sender by name would be the product contradicting a decision
  // the professional made deliberately.
  const packet = { id: "p1", identity_mode: "none" };
  const { professionalSnapshot } = resolvePublishIdentity(packet as never, {
    name: "Ramona Maurer", business_name: "Harbor House Advisors", email: "ramona@example.com",
  }, false);
  const snapshot = await buildPublicationSnapshot(snapshotDb(packet) as never, "p1", professionalSnapshot);
  const serialized = JSON.stringify(recipientMetadata({
    name: (snapshot.professional as Record<string, string>)?.name || undefined,
    businessName: (snapshot.professional as Record<string, string>)?.businessName || undefined,
  }));
  for (const hidden of ["Ramona", "Maurer", "Harbor House"]) {
    assert.ok(!serialized.includes(hidden),
      `a Sendset published with NO sender named ${hidden} in its preview`);
  }
  assert.match(serialized, /A Sendset has been shared with you/);
});

// ---------------------------------------------------------------------------
// THE SHAPE OF THE CARD, unchanged
// ---------------------------------------------------------------------------

test("OPENGRAPH AND TWITTER ARE DECLARED IN FULL — the actual bug was their absence", () => {
  // Next.js merges metadata SHALLOWLY. A route that sets title/description but
  // omits openGraph inherits the PARENT'S ENTIRE OpenGraph block, which is how
  // the marketing card ended up on a private link. Declaring them partially
  // would re-inherit the rest, so their presence is the fix.
  const m = recipientMetadata({ name: "Ramona Maurer" });
  assert.ok(m.openGraph, "openGraph absent — the marketing card will be inherited");
  assert.ok(m.twitter, "twitter absent — the marketing card will be inherited");
  const og = m.openGraph as Record<string, unknown>;
  assert.equal(og.siteName, "Sendset");
  assert.equal(og.type, "website");
});

test("the preview image is the NEUTRAL STATIC one, never the marketing card", () => {
  // Deliberately not removed and deliberately not generated. Several unfurlers
  // fall back to scraping the page for a picture when og:image is absent, and
  // the candidates on a recipient page are the professional's headshot, their
  // logo and the client's own item photographs.
  for (const sender of [null, { name: "Ramona Maurer" }]) {
    const s = JSON.stringify(recipientMetadata(sender));
    assert.match(s, /og-recipient\.png/, "the recipient image is not used");
    assert.ok(!/"[^"]*\/og\.(png|jpg)"/.test(s), "the marketing card is still referenced");
    const tw = recipientMetadata(sender).twitter as Record<string, unknown>;
    assert.equal(tw.card, "summary_large_image",
      "the card type no longer matches the image that is actually declared");
  }
});

// ---------------------------------------------------------------------------
// THE DEMO-ONLY CARD EXPERIMENT — DELETE THIS SECTION with the experiment.
// ---------------------------------------------------------------------------

test("the experiment reaches DEMOS AND NOTHING ELSE", () => {
  // The whole safety property. A real Sendset drawn into the experiment would
  // put an untested card into a messaging app's cache, on a link somebody
  // already sent to a client, with no way to withdraw it.
  const demoSlugs = PUBLIC_DEMOS.map((d) => d.slug);
  for (const slug of Object.keys(DEMO_EXPERIMENT_SLUGS)) {
    assert.ok(demoSlugs.includes(slug), `${slug} is in the experiment but is not a public demo`);
  }
  // Real slugs, including ones that resemble a demo's name.
  for (const slug of ["r6cdwbk3", "32f35aj3l7dt0e7d8jl1zz", "demo-2", "harbor-house-2",
                      "", "constructor", "__proto__", "toString"]) {
    const og = recipientMetadata({ name: "Ramona Maurer" }, slug).openGraph as Record<string, unknown>;
    const image = (og.images as Record<string, unknown>[])[0];
    assert.equal(image.url, "/og-recipient.png", `${slug} was given an experimental card`);
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
  }
  // And with no slug at all.
  const none = recipientMetadata(null).openGraph as Record<string, unknown>;
  assert.equal((none.images as Record<string, unknown>[])[0].url, "/og-recipient.png");
});

test("each demo carries its own candidate, at the size it declares", () => {
  // A declared width that disagrees with the file makes an unfurler lay the
  // card out wrongly — which is the very thing being measured, so a mismatch
  // would corrupt the experiment rather than break it visibly.
  for (const [slug, expected] of Object.entries(DEMO_EXPERIMENT_SLUGS)) {
    const og = recipientMetadata(null, slug).openGraph as Record<string, unknown>;
    const image = (og.images as Record<string, unknown>[])[0];
    assert.equal(image.url, expected.url, `${slug} carries the wrong candidate`);
    const file = join(ROOT, "public", expected.url.replace(/^\//, ""));
    const real = pngSize(file);
    assert.deepEqual(real, { width: expected.width, height: expected.height },
      `${expected.url} is ${real.width}x${real.height} but declares ${expected.width}x${expected.height}`);
    assert.equal(image.width, expected.width);
    assert.equal(image.height, expected.height);
    // The text still does the talking, on a demo as much as anywhere.
    const m = recipientMetadata(null, slug);
    assert.equal(m.title, "A Sendset has been shared with you");
    assert.equal(m.description, RECIPIENT_DESCRIPTION);
    assert.equal((m.twitter as Record<string, unknown>).card, "summary_large_image",
      "the card type was varied — the experiment is meant to isolate the image");
  }
});

test("og:url is NOT inherited from the marketing homepage", () => {
  const og = recipientMetadata({ name: "Ramona Maurer" }).openGraph as Record<string, unknown>;
  assert.equal(og.url, undefined,
    "og:url is set — inheriting it pointed the preview at the marketing site");
});

test("NOINDEX, NOFOLLOW IS PRESERVED", () => {
  for (const sender of [null, { name: "Ramona Maurer" }]) {
    const r = recipientMetadata(sender).robots as { index?: boolean; follow?: boolean };
    assert.equal(r?.index, false);
    assert.equal(r?.follow, false);
  }
});

test("NEITHER RECIPIENT ROUTE DECLARES ITS OWN PARTIAL METADATA", () => {
  // A route-local object with title/description and no openGraph is precisely
  // the shape that inherits the marketing card.
  for (const route of RECIPIENT_ROUTES) {
    assert.doesNotMatch(codeOf(route), /export const metadata: Metadata = \{/,
      `${route} declares metadata inline again — it will inherit the parent openGraph`);
  }
});

test("no per-packet OpenGraph image route was added", () => {
  // One neutral image for every recipient link, deliberately.
  for (const f of ["src/app/p/[slug]/opengraph-image.tsx", "src/app/p/[slug]/opengraph-image.ts",
                   "src/app/p/[slug]/twitter-image.tsx"]) {
    let exists = true;
    try { readFileSync(f); } catch { exists = false; }
    assert.ok(!exists, `${f} generates a per-packet card`);
  }
});

// ---------------------------------------------------------------------------
// AND THE MARKETING PAGE IS UNCHANGED
// ---------------------------------------------------------------------------

test("metadataBase IS THE CANONICAL DOMAIN, not a deploy alias", () => {
  // This is the only hard-coded production host in the application, and it is
  // what every RELATIVE metadata URL resolves against — including the recipient
  // card's /og-recipient.png. Left pointing at a .vercel.app alias, a private
  // link's preview image is fetched from a host the client was never given and
  // that no longer matches the product they are looking at.
  //
  // Asserted here rather than trusted, because nothing else in the build fails
  // when it is stale: the alias keeps resolving, so a wrong value stays wrong
  // silently.
  const layout = codeOf("src/app/layout.tsx");
  assert.match(layout, /metadataBase: new URL\("https:\/\/sendset\.io"\)/,
    "metadataBase is not the canonical apex domain");
  assert.doesNotMatch(layout, /vercel\.app/,
    "a deploy alias is hard-coded as the metadata base");
  // No trailing slash: `new URL` would keep it, and Next joins onto it.
  assert.doesNotMatch(layout, /metadataBase: new URL\("[^"]*\/"\)/,
    "metadataBase has a trailing slash");
});

test("the public homepage KEEPS its marketing metadata", () => {
  // THE PROPERTY, NOT THE SENTENCE. This pinned the description's first six
  // words, which is a proxy for "the homepage still has marketing metadata" and
  // fails the first time that copy is rewritten — as it did. What has to stay
  // true is that the root still declares a marketing description in all three
  // places, and that it is not the recipient one leaking upward.
  const layout = codeOf("src/app/layout.tsx");
  const described = layout.match(/description:\s*\n?\s*"[^"]{40,}"/g) ?? [];
  assert.equal(described.length, 3,
    `expected a description on the root, its openGraph and its twitter card; found ${described.length}`);
  assert.ok(!layout.includes(RECIPIENT_DESCRIPTION),
    "the homepage now wears the recipient's description");
  assert.match(layout, /\/og\.jpg/, "the marketing card was removed");
});

/** The supabase chain this module uses, and no more of it. `select` ignores its
 *  argument the way PostgREST would not — the narrow path is asserted against
 *  the source instead, above. */
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, failing: string[] = []) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const fail = failing.includes(table);
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return q; },
        maybeSingle: async () => fail
          ? { data: null, error: { message: `${table} unavailable` } }
          : { data: rows[0] ?? null, error: null },
      };
      return q;
    },
  };
}

/** Enough of the chain for buildPublicationSnapshot: the Sendset row itself,
 *  and empty content tables. The identity is what is under test; sections,
 *  items and their photos are read by the same assembly and are not. */
function snapshotDb(packet: Row) {
  return {
    from(table: string) {
      const rows: Row[] = table === "packets" ? [packet] : [];
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, in: () => q, order: () => q,
        single: async () => ({ data: rows[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return q;
    },
  };
}
