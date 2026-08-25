// Unit tests for source-specific image optimisation (pure; no network, no DOM).
// Run: node --test src/lib/image-source.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { thumbnailUrl, squareThumbnailUrl } from "./image-source.ts";

const CLD = "https://res.cloudinary.com/dkmsj5vdx/image/upload";

test("asks Cloudinary for a small rendition", () => {
  const out = thumbnailUrl(`${CLD}/v1782351988/96679DrakeT_whf7n4.jpg`, 240);
  assert.equal(out, `${CLD}/c_limit,w_240,q_auto,f_auto/v1782351988/96679DrakeT_whf7n4.jpg`);
});

test("c_limit is used so a small stored photo is never upscaled", () => {
  // The corpus contains 200x200 originals; requesting 240 must not inflate them.
  assert.match(thumbnailUrl(`${CLD}/v1/AILA1_yiketq.jpg`, 240), /c_limit,/);
});

test("an unrecognised source is returned unchanged", () => {
  // The renderer must still work for any host — just without a small rendition.
  for (const u of [
    "https://www.leisurecare.com/wp-content/uploads/2020/01/springfield-place-dining-room-1000x700.jpg",
    "https://clearwateratsonomahills.com/wp-content/uploads/x.jpg",
    "https://example.com/photo.png?w=100",
    "/local/relative.jpg",
  ]) {
    assert.equal(thumbnailUrl(u, 240), u, u);
  }
});

test("an already-transformed Cloudinary URL is left alone", () => {
  const explicit = `${CLD}/c_fill,w_600,h_900/v1782351997/96686DrakeT_smalfc.jpg`;
  assert.equal(thumbnailUrl(explicit, 240), explicit);
});

test("a bare version segment is not mistaken for a transformation", () => {
  const out = thumbnailUrl(`${CLD}/v1782351988/x.jpg`, 120);
  assert.ok(out.includes("c_limit,w_120"), out);
});

test("degenerate input is handled without throwing", () => {
  assert.equal(thumbnailUrl("", 240), "");
  assert.equal(thumbnailUrl(`${CLD}/v1/x.jpg`, 0), `${CLD}/v1/x.jpg`);
  assert.equal(thumbnailUrl(`${CLD}/v1/x.jpg`, Number.NaN), `${CLD}/v1/x.jpg`);
});

test("http and https, and any cloud name, are both recognised", () => {
  assert.match(thumbnailUrl("http://res.cloudinary.com/other/image/upload/v1/a.jpg", 240), /c_limit,w_240/);
});

// A square rendition, for surfaces that cannot crop for themselves. The email
// renderer is the caller: Outlook has no object-fit, so a tile has to arrive
// already square or arrive stretched.

test("asks Cloudinary to CROP to a square, rather than fitting inside one", () => {
  const out = squareThumbnailUrl(`${CLD}/v1782351988/96679DrakeT_whf7n4.jpg`, 264);
  assert.equal(out, `${CLD}/c_fill,g_auto,ar_1:1,w_264,q_auto,f_auto/v1782351988/96679DrakeT_whf7n4.jpg`);
  // c_limit would preserve the original ratio, which is the bug this avoids.
  assert.doesNotMatch(out, /c_limit/);
});

test("the square variant honours the same source rules as the fitted one", () => {
  const foreign = "https://www.leisurecare.com/wp-content/uploads/2020/01/x.jpg";
  assert.equal(squareThumbnailUrl(foreign, 264), foreign, "unrecognised source must pass through");
  const explicit = `${CLD}/c_fill,w_600,h_900/v1782351997/y.jpg`;
  assert.equal(squareThumbnailUrl(explicit, 264), explicit, "a chosen rendition must be left alone");
  assert.equal(squareThumbnailUrl("", 264), "");
  assert.equal(squareThumbnailUrl(`${CLD}/v1/x.jpg`, 0), `${CLD}/v1/x.jpg`);
  assert.equal(squareThumbnailUrl(`${CLD}/v1/x.jpg`, Number.NaN), `${CLD}/v1/x.jpg`);
});

test("the two variants stay independent — neither leaks the other's crop", () => {
  const u = `${CLD}/v1/x.jpg`;
  assert.match(thumbnailUrl(u, 240), /c_limit/);
  assert.doesNotMatch(thumbnailUrl(u, 240), /ar_1:1/);
  assert.match(squareThumbnailUrl(u, 240), /ar_1:1/);
});
