import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attributePhotos, unplacedPhotos, photosIn } from "./photo-attribution.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
// Alpha's photo block is SPLIT: the model saw the tail beside Beta and put it
// there. This is the real failure, in miniature.
const SOURCE = `Alpha Manor — Novato
 Community Phone: (415) 111-2222
Image 1: https://cdn.example.com/alpha1.jpg
Image 2: https://cdn.example.com/alpha2.jpg
Image 3: https://cdn.example.com/alpha3.jpg

Beta Gardens — Napa
 Community Phone: (707) 333-4444
Image 1: https://cdn.example.com/beta1.jpg`;
const TITLES = ["Alpha Manor — Novato", "Beta Gardens — Napa"];

test("A MISATTRIBUTED PHOTO IS RETURNED TO ITS OWN COMMUNITY", () => {
  const beta = attributePhotos(
    { title: "Beta Gardens — Napa", photos: ["https://cdn.example.com/beta1.jpg", "https://cdn.example.com/alpha3.jpg"] },
    SOURCE, TITLES);
  assert.equal(beta.resolved, true);
  assert.deepEqual(beta.photos, ["https://cdn.example.com/beta1.jpg"], "Alpha's photo stayed on Beta");
  assert.deepEqual(beta.removed, ["https://cdn.example.com/alpha3.jpg"]);
});

test("A DROPPED PHOTO IS RESTORED", () => {
  const alpha = attributePhotos(
    { title: "Alpha Manor — Novato", photos: ["https://cdn.example.com/alpha1.jpg"] }, SOURCE, TITLES);
  assert.equal(alpha.photos.length, 3, `expected all three, got ${JSON.stringify(alpha.photos)}`);
  assert.deepEqual(alpha.added, ["https://cdn.example.com/alpha2.jpg", "https://cdn.example.com/alpha3.jpg"]);
});

test("photos keep SOURCE order", () => {
  const a = attributePhotos({ title: "Alpha Manor — Novato", photos: [] }, SOURCE, TITLES);
  assert.deepEqual(a.photos, ["https://cdn.example.com/alpha1.jpg","https://cdn.example.com/alpha2.jpg","https://cdn.example.com/alpha3.jpg"]);
});

test("A DIFFERENT CLOUDINARY URL IS NOT EQUIVALENT", () => {
  // Same host, same folder, different asset. Treating these as interchangeable
  // would hide a real substitution.
  const src = `Only Place\nImage 1: https://res.cloudinary.com/x/image/upload/v1/AAA_aaa.jpg`;
  const a = attributePhotos({ title: "Only Place",
    photos: ["https://res.cloudinary.com/x/image/upload/v1/BBB_bbb.jpg"] }, src, ["Only Place"]);
  assert.deepEqual(a.photos, ["https://res.cloudinary.com/x/image/upload/v1/AAA_aaa.jpg"]);
  assert.deepEqual(a.removed, ["https://res.cloudinary.com/x/image/upload/v1/BBB_bbb.jpg"], "a different asset was accepted");
});

test("UNRESOLVABLE PROVENANCE FAILS OPEN — the model's photos are kept", () => {
  // Emptying a real photo set because a title moved would be worse than the
  // bug this fixes.
  const a = attributePhotos({ title: "Not In This Source", photos: ["https://cdn.example.com/keep.jpg"] }, SOURCE, TITLES);
  assert.equal(a.resolved, false);
  assert.deepEqual(a.photos, ["https://cdn.example.com/keep.jpg"]);
});

test("A SOURCE PHOTO REACHING NO RECORD IS REPORTED", () => {
  const records = [{ photos: ["https://cdn.example.com/alpha1.jpg"] }, { photos: ["https://cdn.example.com/beta1.jpg"] }];
  assert.deepEqual(unplacedPhotos(records, SOURCE),
    ["https://cdn.example.com/alpha2.jpg", "https://cdn.example.com/alpha3.jpg"]);
  const complete = [{ photos: photosIn(SOURCE) }];
  assert.deepEqual(unplacedPhotos(complete, SOURCE), [], "a complete set was reported as lossy");
});

test("'every record has a photo' IS NOT THE CHECK", () => {
  // The audit that let 29 photos vanish: each record had at least one.
  const records = [{ photos: ["https://cdn.example.com/alpha1.jpg"] }, { photos: ["https://cdn.example.com/beta1.jpg"] }];
  assert.ok(records.every(r => r.photos.length > 0), "fixture invalid");
  assert.ok(unplacedPhotos(records, SOURCE).length > 0, "identity-level loss went unnoticed");
});

test("materialisation attributes from the FULL source, not the chunk", () => {
  const r = codeOf("src/app/api/library/import/[runId]/proposals/route.ts");
  assert.match(r, /attributePhotos\(payload as \{ title\?: unknown; photos\?: unknown \}, fullSource, allTitles, ambiguous\)/,
    "photos are not attributed, or not from the full source");
  assert.match(r, /select\("source_text"\)/, "the run's full source is never loaded");
  assert.match(r, /unplacedPhotos\(/, "an unplaced source photo would go unreported");
  assert.ok(!/attributePhotos\([^)]*chunkTexts/.test(r),
    "attribution is chunk-scoped — that reproduces the bug it fixes");
});
