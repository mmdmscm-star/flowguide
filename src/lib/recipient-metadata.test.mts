import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recipientMetadata, RECIPIENT_DESCRIPTION } from "./recipient-metadata.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const RECIPIENT_ROUTES = ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx"];

// The exact strings that reached a client's text message.
const MARKETING = [
  "Everything you found",
  "Turn the notes you already have",
  "your client can actually use",
  "/og.png",
];

// ---------------------------------------------------------------------------
// THE BOUNDARY
//
// A recipient link is professional correspondence sent to someone who may be
// dealing with something difficult. Nothing promotional may ride along with it.
// ---------------------------------------------------------------------------

test("NO MARKETING COPY REACHES A RECIPIENT PREVIEW", () => {
  const serialized = JSON.stringify(recipientMetadata);
  for (const m of MARKETING) {
    assert.ok(!serialized.includes(m), `marketing string in recipient metadata: ${m}`);
  }
});

test("the recipient wording is exactly what was asked for", () => {
  assert.equal(RECIPIENT_DESCRIPTION, "Information has been shared with you in FlowGuide.");
  assert.equal(recipientMetadata.title, "FlowGuide");
  assert.equal(recipientMetadata.description, RECIPIENT_DESCRIPTION);
});

test("OPENGRAPH AND TWITTER ARE DECLARED IN FULL — the actual bug was their absence", () => {
  // Next.js merges metadata SHALLOWLY. A route that sets title/description but
  // omits openGraph inherits the PARENT'S ENTIRE OpenGraph block, which is how
  // the marketing card ended up on a private link. Declaring them partially
  // would re-inherit the rest, so their presence is the fix.
  assert.ok(recipientMetadata.openGraph, "openGraph absent — the marketing card will be inherited");
  assert.ok(recipientMetadata.twitter, "twitter absent — the marketing card will be inherited");
  const og = recipientMetadata.openGraph as Record<string, unknown>;
  assert.equal(og.title, "FlowGuide");
  assert.equal(og.description, RECIPIENT_DESCRIPTION);
});

test("the preview image is the NEUTRAL one, never the marketing card", () => {
  const s = JSON.stringify(recipientMetadata);
  assert.match(s, /og-recipient\.png/, "the recipient image is not used");
  // "/og.png" must not appear — note og-recipient.png does not contain it.
  assert.ok(!/"[^"]*\/og\.png"/.test(s), "the marketing card is still referenced");
});

test("og:url is NOT inherited from the marketing homepage", () => {
  const og = recipientMetadata.openGraph as Record<string, unknown>;
  assert.equal(og.url, undefined,
    "og:url is set — inheriting it pointed the preview at the marketing site");
});

test("NOINDEX, NOFOLLOW IS PRESERVED", () => {
  const r = recipientMetadata.robots as { index?: boolean; follow?: boolean };
  assert.equal(r?.index, false);
  assert.equal(r?.follow, false);
});

// ---------------------------------------------------------------------------
// NO PACKET CONTENT CAN REACH A PREVIEW, BY CONSTRUCTION
// ---------------------------------------------------------------------------

test("the metadata is a CONSTANT — it cannot be handed a packet", () => {
  // This is the load-bearing guarantee. A generateMetadata(packet) could put a
  // client's name or a subject matter into an unfurl cache FlowGuide does not
  // control and cannot retract. A constant has no such code path.
  assert.equal(typeof recipientMetadata, "object");
  for (const route of RECIPIENT_ROUTES) {
    const src = codeOf(route);
    assert.match(src, /export const metadata: Metadata = recipientMetadata;/,
      `${route} does not use the shared constant`);
    assert.doesNotMatch(src, /export async function generateMetadata|export function generateMetadata/,
      `${route} generates per-packet metadata — packet content can reach a preview card`);
  }
});

test("NEITHER RECIPIENT ROUTE DECLARES ITS OWN PARTIAL METADATA", () => {
  // A route-local object with title/description and no openGraph is precisely
  // the shape that inherits the marketing card.
  for (const route of RECIPIENT_ROUTES) {
    const src = codeOf(route);
    assert.doesNotMatch(src, /export const metadata: Metadata = \{/,
      `${route} declares metadata inline again — it will inherit the parent openGraph`);
  }
});

test("no per-packet OpenGraph image route was added", () => {
  // One neutral image for every recipient link, deliberately.
  for (const f of ["src/app/p/[slug]/opengraph-image.tsx", "src/app/p/[slug]/opengraph-image.ts"]) {
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
  assert.match(layout, /metadataBase: new URL\("https:\/\/guidelinks\.io"\)/,
    "metadataBase is not the canonical apex domain");
  assert.doesNotMatch(layout, /vercel\.app/,
    "a deploy alias is hard-coded as the metadata base");
  // No trailing slash: `new URL` would keep it, and Next joins onto it.
  assert.doesNotMatch(layout, /metadataBase: new URL\("[^"]*\/"\)/,
    "metadataBase has a trailing slash");
});

test("the public homepage KEEPS its marketing metadata", () => {
  const layout = codeOf("src/app/layout.tsx");
  assert.match(layout, /Turn the notes you already have/, "the marketing description was removed");
  assert.match(layout, /\/og\.png/, "the marketing card was removed");
});
