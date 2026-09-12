// THE HOMEPAGE'S PICTURES ARE PHOTOGRAPHS OF THE PRODUCT.
//
// Not a visual-regression gate — a pixel diff on a page with remote
// photographs in it fails for reasons that have nothing to do with the product,
// and a marketing asset going stale is a thing a person should look at and
// decide about. What is pinned here is everything a diff cannot see: that the
// files the page asks for exist, that they are within the weight the page can
// afford, that nothing shifts while they load, that every one of them is
// described for a reader who cannot see it, and that no stock photograph,
// icon set or drawn illustration has crept in beside them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
const kb = (p: string) => statSync(join(ROOT, p)).size / 1024;

const PAGE = raw("src/app/page.tsx");
/** The same source with runs of whitespace flattened. PROSE IN JSX WRAPS: a
 *  sentence on the page is several lines in the file, broken wherever the line
 *  length ran out, so a regex written against the sentence fails against the
 *  file — and shortening it until it fits only pins the assertion to today's
 *  wrapping. Anything asserting what a VISITOR READS goes through here. */
const PROSE = PAGE.replace(/\s+/g, " ");
const referenced = [...PAGE.matchAll(/"(\/marketing\/[a-z0-9@.-]+)"/g)].map((m) => m[1]);
const srcset = [...PAGE.matchAll(/(\/marketing\/[a-z0-9@.-]+)\s+\d+w/g)].map((m) => m[1]);
const ASSETS = [...new Set([...referenced, ...srcset])];

test("EVERY FILE THE PAGE ASKS FOR EXISTS", () => {
  assert.equal(ASSETS.length, 6, `expected six marketing assets, found ${ASSETS.join(", ")}`);
  for (const a of ASSETS)
    assert.ok(existsSync(join(ROOT, "public", a)), `${a} is referenced but not in public/`);
  assert.ok(existsSync(join(ROOT, "public/og.jpg")), "the link-preview card is missing");
  // THE OLD CARD IS KEPT, AND IS NOT THE CARD. A platform that unfurled
  // sendset.io before this change is holding the /og.png URL and will not
  // re-crawl on our schedule; deleting the file turns those previews into a
  // broken image. So it stays as a compatibility asset — served, never
  // referenced. The metadata points at one card, and it is the new one.
  assert.ok(existsSync(join(ROOT, "public/og.png")),
    "the superseded card was deleted; previously cached unfurls would break");
  const layout = raw("src/app/layout.tsx");
  assert.ok(!/["']\/og\.png["']/.test(layout),
    "metadata still points at the compatibility asset rather than /og.jpg");
  assert.match(layout, /["']\/og\.jpg["']/, "metadata does not point at the new card");
  // The RECIPIENT card — a different asset with a different job — is untouched.
  assert.ok(existsSync(join(ROOT, "public/og-recipient.png")),
    "the neutral recipient card was deleted; a private link would inherit the marketing one");
});

test("THE PAGE CAN AFFORD THEM", () => {
  // A page that shipped zero image bytes now ships two pictures. The budget is
  // what a professional on a phone should wait for, not what a design tool
  // happened to export.
  const budget: Record<string, number> = {
    "/marketing/workout-after.webp": 120,
    "/marketing/workout-after@1x.webp": 60,
    "/marketing/formats-wide.webp": 200,
    "/marketing/formats-wide@1x.webp": 90,
    "/marketing/formats-narrow.webp": 120,
    "/marketing/formats-narrow@1x.webp": 60,
  };
  for (const [a, max] of Object.entries(budget)) {
    const size = kb(join("public", a));
    assert.ok(size <= max, `${a} is ${size.toFixed(1)}KB, over its ${max}KB budget`);
  }
  // The card that gets pasted into a message. The typography-only one it
  // replaced was 479KB and showed nothing of the product.
  const og = kb("public/og.jpg");
  assert.ok(og < 200, `og.jpg is ${og.toFixed(1)}KB`);
  assert.ok(og < 479, "the new card is not smaller than the one it replaced");
});

test("NOTHING MOVES WHILE THEY LOAD", () => {
  // Every <img> states its intrinsic size, so the space is reserved before the
  // bytes arrive. The composite additionally pins an aspect ratio at each
  // width, because <picture> swaps between two shapes at the breakpoint.
  const imgs = [...PAGE.matchAll(/<img\b[\s\S]*?\/>/g)].map((m) => m[0]);
  for (const img of imgs) {
    assert.match(img, /width=\{\d+\}/, "an image has no intrinsic width");
    assert.match(img, /height=\{\d+\}/, "an image has no intrinsic height");
    assert.match(img, /sizes="/, "an image has no sizes, so srcset picks blind");
  }

  // TWO KINDS OF PICTURE, AND ONLY ONE OF THEM IS DESCRIBED.
  //
  // A photograph of the product carries meaning a reader who cannot see it
  // would otherwise lose, so it gets real alt text. The thumbnail on an example
  // card does not: it sits inside a link that already says the business, the
  // title, a sentence and the contents, and describing the picture as well
  // would make a screen reader read the same card twice. An empty alt is the
  // correct answer there, not a missing one — so the two are counted apart
  // rather than held to one rule.
  const described = imgs.filter((i) => !/alt=""/.test(i));
  const decorative = imgs.filter((i) => /alt=""/.test(i));
  assert.equal(described.length, 2,
    "the homepage grew or lost a photograph of the product");
  assert.equal(decorative.length, 1,
    "the example cards' thumbnail changed shape; there should be exactly one <img> for all four");
  for (const img of described) {
    const alt = img.match(/alt="([^"]*)"/)?.[1] ?? "";
    assert.ok(alt.split(/\s+/).length >= 8,
      `alt text is too thin to replace the picture: "${alt}"`);
    assert.ok(!/image|screenshot|picture of/i.test(alt),
      `alt text describes the file rather than the thing: "${alt}"`);
  }
  for (const img of decorative) {
    assert.match(img, /aspect-\[\d+\/\d+\]/,
      "the card thumbnail reserves no space, so the grid jumps as photographs arrive");
    assert.match(img, /loading="lazy"/,
      "four card photographs load eagerly, ahead of the words that explain them");
  }
  assert.match(PAGE, /aspect-\[342\/470\] sm:aspect-\[768\/660\]/,
    "the composite does not pin an aspect ratio at each width");
  assert.match(PAGE, /<source[\s\S]*?media="\(min-width: 640px\)"/,
    "the composite does not switch layout by width");
});

test("THE PICTURES REPLACED PROSE RATHER THAN JOINING IT", () => {
  // The four-format section used to describe in four paragraphs what one
  // picture now shows. Those paragraphs must be gone, not moved.
  for (const gone of ["The interactive version, and the best one",
                      "A few sentences wrapping that link",
                      "The full content inside the body of the email",
                      "The same guide on paper, for a client"])
    assert.ok(!PAGE.includes(gone), `the composite did not replace: "${gone}"`);
  assert.ok(!PAGE.includes("function Format("), "the Format helper outlived its callers");
  // The section still says the thing the picture cannot: that these are one
  // object rather than four documents, and that it stays current after sending.
  // It used to be "You build it once." in a section of its own, arguing against
  // rebuilding; the argument survived and its second section did not.
  assert.match(PROSE, /no second version in the world/,
    "the delivery section no longer says the picture's unsayable half");
  assert.match(PROSE, /update it, and the link you already sent shows the current one/,
    "the one-live-link promise is gone");
});

test("NOTHING COMES BETWEEN THE VISITOR AND THE ACTIONS", () => {
  // A visitor deciding in seconds must reach the CTAs without scrolling past a
  // product shot. This used to be enforced as an ORDER, because the hero held a
  // screenshot beside the words. It holds no picture now — four real Sendsets
  // sit immediately below it and do that job better than a photograph of one —
  // so the rule is simply that the header has no image in it at all.
  const header = PAGE.slice(PAGE.indexOf("<header"), PAGE.indexOf("</header>"));
  assert.ok(!/<img|<picture|\/marketing\//.test(header),
    "the hero has a picture again, which a visitor must scroll past to act");
  assert.match(header, /Start your first Sendset/, "the hero lost its primary action");
  assert.match(header, /See a real Sendset/, "the hero lost its way into a real one");
  // And the examples follow immediately, before any explanation of them.
  const afterHeader = PAGE.slice(PAGE.indexOf("</header>"));
  assert.ok(afterHeader.indexOf("FEATURED.map") < afterHeader.indexOf("Three steps"),
    "the page explains itself before showing anything");
});

test("NO STOCK PHOTOGRAPHY, NO ICON SET, NO ILLUSTRATION, NO MOTION", () => {
  // The page's argument is that a well-made thing respects its reader. Every
  // image on it is a photograph of this product; nothing is decorative.
  for (const src of ASSETS) assert.match(src, /^\/marketing\//);
  assert.ok(!/<svg|\.svg"/.test(PAGE), "an icon or illustration appeared");
  // NO IMAGE URL IS WRITTEN ON THIS PAGE except the captures. The example cards
  // do show a photograph that is not of the product — but it is one from inside
  // the Sendset that card opens, read out of that fixture at render time. That
  // is the line: content from the thing being linked to, never a picture
  // somebody chose to decorate this page with. A hard-coded src is how the
  // second becomes possible, so there is no way to write one.
  const hardcoded = [...PAGE.matchAll(/src="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [],
    `an image URL was written into the page: ${hardcoded.join(", ")}`);
  assert.match(PAGE, /src=\{photo\}/,
    "the card thumbnail is no longer read out of the demo it links to");
  assert.ok(!/animate-|transition-transform|@keyframes|framer|motion/.test(PAGE),
    "the page gained motion");
});

test("THE CAPTURE IS REPRODUCIBLE, AND CANNOT REWRITE THE PACKET", () => {
  const script = raw("scripts/marketing/capture.mjs");
  assert.match(raw("package.json"), /"capture:marketing"/, "there is no way to run it");
  // It photographs demos, and only demos — never a real packet from the database.
  assert.match(script, /\$\{ORIGIN\}\/p\/demo/);
  assert.match(script, /\$\{ORIGIN\}\/p\/month-one/);
  assert.ok(!/getPublishedPacket|createServerClient|from\("packets"\)/.test(script),
    "the capture reaches into the database");
  // The only things it touches before a shot: dev-server chrome and animation.
  assert.match(script, /nextjs-portal/);
  assert.match(script, /transition:none/);
  // IT MUST NEVER EDIT WHAT THE PACKET SAYS. The distinction that matters is
  // between writing into an element the PAGE owns and writing into one the
  // script created for itself — the transition-killing <style> is the second
  // kind, and is the only text this script writes anywhere.
  assert.ok(!/querySelector[^;\n]*\.(textContent|innerText|innerHTML)\s*=/.test(script),
    "the capture rewrites the content of an element it found on the page");
  assert.ok(!/document\.(body|title)\.(innerHTML|textContent)\s*=/.test(script),
    "the capture rewrites the document");
  const writes = [...script.matchAll(/\.(textContent|innerHTML)\s*=/g)];
  assert.equal(writes.length, 1, "the capture writes text in more than one place");
  assert.match(script.slice(0, script.search(/\.textContent\s*=/)).split("\n").slice(-3).join("\n"),
    /createElement\('style'\)/, "the one text write is not the style element it created");
  // Intermediates are not committed; the six assets and the card are.
  assert.match(raw(".gitignore"), /scripts\/marketing\/\.work\//);
});
