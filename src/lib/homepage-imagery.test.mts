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
    "/marketing/hero.webp": 120,
    "/marketing/hero@1x.webp": 60,
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
  assert.equal(imgs.length, 2, "the homepage grew or lost an image");
  for (const img of imgs) {
    assert.match(img, /width=\{\d+\}/, "an image has no intrinsic width");
    assert.match(img, /height=\{\d+\}/, "an image has no intrinsic height");
    assert.match(img, /sizes="/, "an image has no sizes, so srcset picks blind");
    const alt = img.match(/alt="([^"]*)"/)?.[1] ?? "";
    assert.ok(alt.split(/\s+/).length >= 8,
      `alt text is too thin to replace the picture: "${alt}"`);
    assert.ok(!/image|screenshot|picture of/i.test(alt),
      `alt text describes the file rather than the thing: "${alt}"`);
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
  // The section still says the thing the picture cannot.
  assert.match(PAGE, /You build it once\./);
});

test("ON A PHONE, THE ACTIONS COME BEFORE THE PICTURE", () => {
  // A visitor deciding in seconds must reach the two CTAs without scrolling
  // past a product shot. The artifact follows them.
  const header = PAGE.slice(PAGE.indexOf("<header"), PAGE.indexOf("</header>"));
  assert.ok(header.indexOf("See a real Sendset") < header.indexOf("hero.webp"),
    "the hero image sits above the primary action");
  assert.ok(header.indexOf("Start your first Sendset") < header.indexOf("hero.webp"),
    "the hero image sits above the secondary action");
  // The two-column arrangement is a wide-screen refinement, never the phone's.
  assert.match(header, /sm:grid sm:grid-cols-\[1fr_17rem\]/,
    "the hero lost its single-column-on-a-phone layout");
});

test("NO STOCK PHOTOGRAPHY, NO ICON SET, NO ILLUSTRATION, NO MOTION", () => {
  // The page's argument is that a well-made thing respects its reader. Every
  // image on it is a photograph of this product; nothing is decorative.
  for (const src of ASSETS) assert.match(src, /^\/marketing\//);
  assert.ok(!/<svg|\.svg"/.test(PAGE), "an icon or illustration appeared");
  assert.ok(!/unsplash|pexels|shutterstock|getty/i.test(PAGE), "stock photography appeared");
  assert.ok(!/animate-|transition-transform|@keyframes|framer|motion/.test(PAGE),
    "the page gained motion");
});

test("THE CAPTURE IS REPRODUCIBLE, AND CANNOT REWRITE THE PACKET", () => {
  const script = raw("scripts/marketing/capture.mjs");
  assert.match(raw("package.json"), /"capture:marketing"/, "there is no way to run it");
  // It photographs the demo, and only the demo.
  assert.match(script, /\$\{ORIGIN\}\/p\/demo/);
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
