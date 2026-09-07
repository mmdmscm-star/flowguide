// BOUNDING A DISPLAY PHOTOGRAPH — the rules, and the wiring around them.
//
// The decision logic is pure and is tested directly. The canvas half cannot be:
// node has no decoder and jsdom has no encoder, and a mock of createImageBitmap
// proves only that the mock was called. So the browser half is proven by an
// actual browser, against a real phone-sized JPEG — see the workstream notes —
// and what is pinned here is everything that can be decided without pixels:
// which files are touched, which are not, the sizes, the ordering of the three
// gates, and every path that must return the original file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isJpegBytes, planBound, keepSmaller, MAX_DISPLAY_EDGE, DISPLAY_QUALITY,
} from "./image-bounding.ts";
import { sniffImageType, MAX_UPLOAD_BYTES, MAX_PHOTO_BYTES } from "./photo-upload.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const MODULE = "src/lib/image-bounding.ts";
const CLIENT = "src/lib/image-upload-client.ts";

// ---------------------------------------------------------------------------
// 1. WHICH FILES ARE TOUCHED
// ---------------------------------------------------------------------------

const head = (...b: number[]) => new Uint8Array([...b, ...Array(12 - b.length).fill(0)]);
const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const PNG  = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF  = head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = new Uint8Array([0x52,0x49,0x46,0x46, 0,0,0,0, 0x57,0x45,0x42,0x50]);

test("ONLY A JPEG IS BOUNDED", () => {
  assert.equal(isJpegBytes(JPEG), true);
  // Each of these loses something on a canvas: a PNG its transparency, a GIF
  // its animation. They are passed through rather than handled half-well.
  assert.equal(isJpegBytes(PNG), false, "a PNG would be flattened onto a background nobody chose");
  assert.equal(isJpegBytes(GIF), false, "an animated GIF would lose its animation");
  assert.equal(isJpegBytes(WEBP), false, "a WebP may carry alpha or animation");
  assert.equal(isJpegBytes(new Uint8Array([0xff, 0xd8])), false, "too short to identify");
  assert.equal(isJpegBytes(null), false);
  assert.equal(isJpegBytes(undefined), false);
});

test("AND IT AGREES WITH THE SERVER'S COPY OF THE SAME RULE", () => {
  // sniffImageType is the route's sniffer. Two sniffers that disagree about
  // what a JPEG is would mean the browser bounding a file the server then
  // rejects, or worse, the reverse.
  for (const [label, bytes] of [["jpeg", JPEG], ["png", PNG], ["gif", GIF], ["webp", WEBP]] as const) {
    const server = sniffImageType(Buffer.from(bytes));
    assert.equal(isJpegBytes(bytes), server?.mime === "image/jpeg", `disagreement on ${label}`);
  }
});

test("IT SNIFFS THE BYTES, NEVER THE CLAIMED TYPE", () => {
  const src = codeOf(MODULE);
  assert.ok(!/file\.type/.test(src), "the module trusts the type the browser guessed");
  assert.match(src, /file\.slice\(0, 12\)/, "the module does not read the magic number");
});

// ---------------------------------------------------------------------------
// 2. THE SIZES
// ---------------------------------------------------------------------------

test("1600px IS THE LARGEST RENDITION ANY RENDERER ASKS FOR", () => {
  // Not the card width — print's hero. If print ever asks for more, this
  // number is wrong and a bounded photograph would print soft.
  assert.equal(MAX_DISPLAY_EDGE, 1600);
  assert.match(codeOf("src/components/print/print-packet.tsx"), /thumbnailUrl\(hero, 1600\)/,
    "print no longer asks for 1600px, so the bound no longer matches it");
  assert.ok(DISPLAY_QUALITY > 0.7 && DISPLAY_QUALITY < 0.9, "quality is outside a sane band");
});

test("AN OVERSIZED PHOTOGRAPH IS BOUNDED ON ITS LONG EDGE, ASPECT PRESERVED", () => {
  // The real worst case measured in storage.
  const t = planBound(4032, 3024)!;
  assert.equal(Math.max(t.width, t.height), 1600);
  assert.equal(t.width, 1600);
  assert.equal(t.height, 1200);
  assert.ok(Math.abs((t.width / t.height) - (4032 / 3024)) < 0.005, "aspect ratio drifted");

  // Portrait: the LONG edge is bound, whichever it is.
  const p = planBound(3024, 4032)!;
  assert.equal(Math.max(p.width, p.height), 1600);
  assert.equal(p.height, 1600);

  // A panorama is bound by its width and stays legible.
  const w = planBound(8000, 1000)!;
  assert.equal(w.width, 1600);
  assert.equal(w.height, 200);
});

test("AN IMAGE THAT IS ALREADY SMALL ENOUGH IS NOT RE-ENCODED", () => {
  // Generational loss is the one cost a lossy format cannot take back, so
  // "for consistency" is not a reason to spend it.
  assert.equal(planBound(1600, 1200), null, "a photo exactly at the bound was re-encoded");
  assert.equal(planBound(1200, 1600), null);
  assert.equal(planBound(800, 600), null);
  assert.equal(planBound(1601, 900)!.width, 1600, "one pixel over is still over");
});

test("NONSENSE DIMENSIONS CHANGE NOTHING", () => {
  for (const [w, h] of [[0, 0], [-1, 100], [100, NaN], [Infinity, 100]] as const) {
    assert.equal(planBound(w as number, h as number), null, `${w}x${h} produced a plan`);
  }
});

test("A RESIZE THAT MADE THE FILE BIGGER IS DISCARDED", () => {
  assert.equal(keepSmaller(1000, 400), true);
  assert.equal(keepSmaller(1000, 1200), false, "a heavier result was kept");
  assert.equal(keepSmaller(1000, 1000), false, "no gain is not a gain");
  assert.equal(keepSmaller(1000, 0), false, "an empty encode was accepted");
});

// ---------------------------------------------------------------------------
// 3. NEVER LOSE THE PHOTOGRAPH
// ---------------------------------------------------------------------------

test("EVERY FAILURE PATH RETURNS THE ORIGINAL FILE", () => {
  const src = codeOf(MODULE);
  const fn = src.slice(src.indexOf("export async function boundDisplayImage"));
  // Not a count of `return file` — the claim is that the function's failure
  // handling is total: a try/catch around everything, and no throw of its own.
  assert.match(fn, /catch \{\s*return file;\s*\}/, "an unexpected throw would escape");
  assert.ok(!/throw /.test(fn), "the bounding function can throw at its caller");
  for (const guard of [
    /if \(!isJpegBytes\(head\)\) return file;/,      // not a JPEG
    /if \(!decoded\) return file;/,                   // no decoder in this browser
    /if \(!target\) return file;/,                    // already small enough
    /if \(!blob \|\| !keepSmaller\(file\.size, blob\.size\)\) return file;/, // no encode, or no gain
  ]) assert.match(fn, guard, `a failure path does not fall back: ${guard}`);
});

test("BROWSER APIS ARE FEATURE-DETECTED, NOT ASSUMED", () => {
  const src = codeOf(MODULE);
  // Mobile Safari lacked OffscreenCanvas for years and older engines lack
  // createImageBitmap's orientation option; neither may be assumed.
  for (const api of ["createImageBitmap", "OffscreenCanvas", "document", "URL", "Image"]) {
    assert.match(src, new RegExp(`typeof ${api} (!==|===) ["'](function|undefined)["']`),
      `${api} is used without being detected`);
  }
  assert.match(src, /canvas\.toBlob !== "function"/, "toBlob is assumed to exist");
  // And there IS a second path for each half, not just a detection that gives up.
  assert.match(src, /new Image\(\)/, "there is no <img> decode fallback");
  assert.match(src, /document\.createElement\("canvas"\)/, "there is no element-canvas fallback");
});

test("ORIENTATION IS APPLIED, NOT IGNORED", () => {
  // A phone photograph carries its rotation in EXIF. Drawing it to a canvas
  // without applying that turns a portrait sideways — silently, and only for
  // the recipient.
  assert.match(codeOf(MODULE), /imageOrientation: "from-image"/,
    "the bitmap decode does not apply EXIF orientation");
});

test("TEMPORARY RESOURCES ARE RELEASED ON EVERY PATH", () => {
  const src = codeOf(MODULE);
  assert.match(src, /bitmap\.close\(\)/, "the decoded bitmap is never closed");
  assert.equal((src.match(/URL\.revokeObjectURL/g) ?? []).length, 2,
    "an object URL leaks on one of the two paths");
  // `finally`, so a throw between decode and encode still releases.
  assert.match(src, /\} finally \{\s*decoded\.release\(\);/, "release is not in a finally");
});

// ---------------------------------------------------------------------------
// 4. THE WIRING — WHO IS BOUNDED AND WHO IS NOT
// ---------------------------------------------------------------------------

test("THE RECIPIENT-FACING PATHS ARE BOUNDED — BOTH OF THEM", () => {
  const client = codeOf(CLIENT);
  assert.match(client, /boundDisplayImage/, "the shared upload path does not bound");
  // uploadCreatorImage is the shared entry for item photos AND Library images.
  const callers = [
    "src/components/editor/legacy-packet-editor.tsx",
    "src/components/editor/block-packet-editor.tsx",
    "src/components/library/library-workspace.tsx",
    "src/components/library/import-with-ai.tsx",
  ];
  for (const f of callers) assert.match(codeOf(f), /uploadCreatorImage\(/, `${f} stopped using the shared path`);
  assert.match(codeOf("src/components/editor/legacy-packet-editor.tsx"),
    /uploadCreatorImage\(`\/api\/packets\/\$\{packetId\}\/photos`/, "the item photo endpoint changed");
  assert.match(codeOf("src/components/library/library-workspace.tsx"),
    /uploadCreatorImage\("\/api\/library\/images"/, "the Library endpoint changed");
});

test("THE SOURCE-DOCUMENT PATH IS NEVER BOUNDED", () => {
  // THE ONE THAT MATTERS. Evidence must stay an untouched original: a document
  // photographed for OCR may need re-reading, and its resolution IS the
  // evidence. The separation is structural — source images post directly and
  // never enter the function that bounds.
  const workspace = codeOf("src/components/new/new-packet-workspace.tsx");
  assert.match(workspace, /fetch\("\/api\/ingest\/source-image"/, "the source path moved");
  assert.ok(!/uploadCreatorImage/.test(workspace), "the source path now goes through the bounding helper");
  assert.ok(!/boundDisplayImage/.test(workspace), "the source path bounds its own images");
  // Nothing on the server side bounds either.
  const route = codeOf("src/app/api/ingest/source-image/route.ts");
  assert.ok(!/bound|resize|MAX_DISPLAY_EDGE/i.test(route), "the evidence route resizes");

  // And profile branding is left alone too — a different direct path.
  const profile = codeOf("src/components/editor/image-upload-field.tsx");
  assert.match(profile, /fetch\("\/api\/profile\/images"/);
  assert.ok(!/uploadCreatorImage|boundDisplayImage/.test(profile), "profile images were pulled into this package");
});

test("THE THREE GATES RUN IN THE RIGHT ORDER", () => {
  const client = codeOf(CLIENT);
  const decodeCeiling = client.indexOf("MAX_PHOTO_BYTES");
  const bound = client.indexOf("await boundDisplayImage");
  const transport = client.indexOf("upload.size > MAX_UPLOAD_BYTES");
  assert.ok(decodeCeiling > 0 && bound > decodeCeiling, "bounding happens before the decode ceiling");
  assert.ok(transport > bound,
    "the transport gate still runs BEFORE bounding — a phone photograph would be refused unresized");
  // THE POINT: the transport budget is tested against what is actually sent.
  assert.ok(!/file\.size > MAX_UPLOAD_BYTES/.test(client),
    "the transport gate still tests the chosen file rather than the uploaded one");
  assert.match(client, /body\.append\("file", upload\)/, "the bounded file is not the one uploaded");
});

test("THE DECODE CEILING IS AN EXISTING NUMBER, NOT A NEW PRODUCT LIMIT", () => {
  // MAX_PHOTO_BYTES is the bucket's own file_size_limit from 0029 and has
  // always described what Sendset accepts. Inventing a third number here would
  // be a fourth place for the limits to disagree.
  const client = codeOf(CLIENT);
  assert.match(client, /file\.size > MAX_PHOTO_BYTES/, "the decode ceiling is not the bucket's limit");
  assert.equal(MAX_PHOTO_BYTES, 10 * 1024 * 1024);
  assert.ok(MAX_PHOTO_BYTES > MAX_UPLOAD_BYTES, "the decode ceiling is below the transport budget");
  // The message names the number it enforces, not the other one.
  assert.match(client, /Choose one under \$\{MAX_PHOTO_BYTES \/ 1048576\} MB/,
    "the refusal quotes the wrong limit");
});

test("NO NEW STORED FIELD, NO SECOND COPY, NO SCHEMA", () => {
  const src = codeOf(MODULE) + codeOf(CLIENT);
  assert.ok(!/storage_path|original_url|display_url|thumbnail_url/.test(src),
    "a second stored URL appeared");
  assert.equal((codeOf(CLIENT).match(/fetch\(endpoint/g) ?? []).length, 1,
    "the upload posts more than once — a second copy is being stored");
});
