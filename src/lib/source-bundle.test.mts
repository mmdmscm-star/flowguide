// SEVERAL PAGES, ONE SOURCE.
//
// Spring Lake was three photographed brochure pages. All three were read, one
// combined transcription came out, and exactly ONE image was kept — the state
// was a single slot each new picture overwrote. So when the transcription put a
// confident licence number on the page nobody could look at any more, there was
// nothing to check it against.
//
// These are the rules around fixing that: one way in for browsing and dropping,
// the professional's order preserved through every stage, and every page kept.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planBundle, looksLikeImage } from "./source-bundle.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const NEW = codeOf("src/components/new/new-packet-workspace.tsx");
const ORGANIZE = codeOf("src/app/api/ingest/organize/route.ts");

const file = (name: string, type = "", size = 100) =>
  ({ name, type, size }) as unknown as File;
const img = (n: string) => file(n, "image/jpeg", 2000);

// ---------------------------------------------------------------------------
// 1. ONE WAY IN
// ---------------------------------------------------------------------------

test("MANY IMAGES, IN THE ORDER SUPPLIED", () => {
  const p = planBundle([img("page1.jpg"), img("page2.jpg"), img("page3.jpg")]);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.items.map((i) => i.kind), ["image", "image", "image"]);
  assert.deepEqual(p.items.map((i) => i.file.name), ["page1.jpg", "page2.jpg", "page3.jpg"],
    "the supplied order was not preserved");
});

test("A MIXED BUNDLE KEEPS ITS ORDER — the text file does not jump the queue", () => {
  const p = planBundle([img("page1.jpg"), file("rates.csv"), img("page2.jpg")]);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.items.map((i) => i.kind), ["image", "text", "image"],
    "a mixed bundle was reordered");
  // AND THE RUNTIME AWAITS EACH IN TURN. A text file is read locally in
  // microseconds; without this it finishes first whatever order it was given in.
  const ingest = NEW.slice(NEW.indexOf("async function ingestFiles"), NEW.indexOf("function removeImage"));
  assert.match(ingest, /for \(const item of plan\.items\)/, "the bundle is not walked in order");
  assert.match(ingest, /await readOneTextFile\(item\.file\)/, "a text file is not awaited in sequence");
  assert.match(ingest, /await transcribeOne\(entry\)/, "images are not awaited in sequence");
  assert.ok(!/Promise\.all|Promise\.allSettled/.test(ingest),
    "the bundle is processed concurrently, so order and failure attribution are lost");
});

test("MORE THAN ONE TEXT FILE IS REFUSED, not silently concatenated", () => {
  const p = planBundle([file("a.csv"), file("b.csv")]);
  assert.equal(p.ok, false);
  if (p.ok) return;
  assert.match(p.message, /one file at a time/i);
  // Two spreadsheets joined become one source_text whose record structure is a
  // fiction — delimiterForFile already refuses to guess across two files.
  const mixed = planBundle([img("p.jpg"), file("a.csv"), file("b.txt")]);
  assert.equal(mixed.ok, false, "two text files slipped through inside a mixed bundle");
  // Images are different: pages of one document by construction.
  assert.equal(planBundle([img("a.jpg"), img("b.jpg"), img("c.png")]).ok, true);
});

test("THE WHOLE BATCH IS REFUSED, never part of it", () => {
  const p = planBundle([img("page1.jpg"), file("notes.pdf")]);
  assert.equal(p.ok, false, "a batch with an unreadable file was partly accepted");
  if (!p.ok) assert.match(p.message, /PDF/i, "the PDF does not get its own sentence");
  for (const [name, re] of [["deck.docx", /Word/i], ["rates.xlsx", /CSV/i], ["x.zip", /isn’t supported/i]] as const) {
    const r = planBundle([file(name)]);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.message, re);
  }
  assert.equal(planBundle([]).ok, false);
});

test("routing is generous, because the SERVER is the one that decides", () => {
  // A dropped file often carries no type at all; a picked one can carry a type
  // another platform never sets. Both signals are accepted here because this is
  // routing — the server sniffs the magic number and refuses anything that
  // merely claims to be an image.
  assert.equal(looksLikeImage(file("a.jpg")), true, "extension alone was not enough");
  assert.equal(looksLikeImage(file("photo", "image/png")), true, "mime alone was not enough");
  assert.equal(looksLikeImage(file("a.svg", "image/svg+xml")), false, "SVG is on the allowlist");
  assert.equal(looksLikeImage(file("a.csv", "text/csv")), false);
  assert.match(codeOf("src/lib/source-bundle.ts"), /ACCEPTED_PHOTO_TYPES/,
    "the classifier keeps its own mime list, which will drift from the upload allowlist");
});

// ---------------------------------------------------------------------------
// 2. BROWSE AND DROP ARE THE SAME PATH
// ---------------------------------------------------------------------------

test("BOTH GESTURES CALL ingestFiles, AND THE DROP HANDLER FETCHES NOTHING", () => {
  assert.equal((NEW.match(/ingestFiles\(/g) ?? []).length >= 3, true,
    "the pickers and the drop target do not share one entry point");
  assert.match(NEW, /onDrop=\{\(e\) => \{[\s\S]*?ingestFiles\(dropped\)/,
    "the drop target does not feed the shared path");
  const drop = NEW.slice(NEW.indexOf("onDrop={(e) => {"), NEW.indexOf("className={`mt-7"));
  assert.ok(!/fetch\(/.test(drop), "the drop handler has its own backend call");
  assert.ok(!/FormData|api\//.test(drop), "the drop handler talks to the server itself");
  assert.match(drop, /e\.preventDefault\(\)/, "the browser will navigate away to the dropped file");
  // And the picker takes several.
  assert.match(NEW, /accept=\{PHOTO_ACCEPT_ATTR\}\s*\n\s*multiple/,
    "the picture picker still takes one file");
  assert.match(NEW, /Array\.from\(e\.target\.files \?\? \[\]\)/, "the picker reads only the first file");
});

test("the drop surface is not image-specific", () => {
  assert.match(NEW, /Drag files or pictures here, or click to choose/,
    "the drop copy does not use the general pattern");
  // The target wraps the creation card rather than the picture control, so a
  // future file type needs no new surface.
  assert.ok(NEW.indexOf("onDrop={(e) => {") < NEW.indexOf("<textarea"),
    "the drop target does not cover the whole creation surface");
});

// ---------------------------------------------------------------------------
// 3. TRANSCRIPTION
// ---------------------------------------------------------------------------

test("ONE IMAGE, ONE CALL — never a multimodal bundle", () => {
  const one = NEW.slice(NEW.indexOf("async function transcribeOne"), NEW.indexOf("async function readOneTextFile"));
  assert.equal((one.match(/body\.append\("file"/g) ?? []).length, 1,
    "more than one image is put in a single request");
  assert.equal((one.match(/fetch\(/g) ?? []).length, 1);
  assert.match(one, /\/api\/ingest\/transcribe/);
  // The route itself still takes exactly one file, and the prompt is untouched.
  const route = codeOf("src/app/api/ingest/transcribe/route.ts");
  assert.match(route, /form\.get\("file"\)/, "the transcription route learned to take several images");
  assert.ok(!/getAll\(/.test(route), "the transcription route accepts a list of images");
  const lib = readFileSync(join(ROOT, "src/lib/transcribe.ts"), "utf8");
  assert.match(lib, /- If something is unreadable, illegible or cut off, write \[unclear\] in its/,
    "TRANSCRIPTION_PROMPT changed");
  assert.equal((lib.match(/type: "image_url"/g) ?? []).length, 1,
    "the model call carries more than one image");
});

test("BLANK LINES BETWEEN CONTRIBUTIONS — no page markers in source_text", () => {
  assert.match(NEW, /const append = \(text: string\)[\s\S]*?\$\{prev\.replace\(\/\\s\+\$\/, ""\)\}\\n\\n\$\{t\}/,
    "contributions are not blank-line separated");
  // A "--- Image 2 ---" line would reach the claim parser, the record detector
  // and the omission check as though the professional had written it.
  for (const marker of ["--- Image", "--- Page", "=== Image", "[Image "])
    assert.ok(!NEW.includes(marker), `a page marker (${marker}) reaches source_text`);
});

test("A FAILED IMAGE NAMES ITSELF and leaves the others alone", () => {
  const one = NEW.slice(NEW.indexOf("async function transcribeOne"), NEW.indexOf("async function readOneTextFile"));
  assert.match(one, /setError\(`\$\{entry\.label\}: \$\{message\}/,
    "a failure does not say which picture failed");
  assert.match(one, /x\.id === entry\.id \? \{ \.\.\.x, status: "failed"/,
    "a failure is not recorded against that one picture");
  // It marks and returns rather than throwing, so the loop continues.
  assert.match(one, /return false;/, "a failed picture aborts the rest of the bundle");
  assert.match(NEW, /label: `Picture \$\{\+\+pictureSeq\.current\}`/,
    "pictures are not numbered from a monotonic counter, so removal renumbers them");
});

// ---------------------------------------------------------------------------
// 4. THE REVIEW SURFACE
// ---------------------------------------------------------------------------

test("EVERY PAGE STAYS, AND EVERY ONE OPENS FULL SIZE", () => {
  // The defect, directly: the old state was one slot that each picture
  // overwrote, so three pages left one thumbnail.
  assert.match(NEW, /sourceImages\.map\(\(img\) =>/, "only one picture is rendered");
  assert.ok(!/setSourceImage\((prev|\{)/.test(NEW), "the single-slot state survives");
  assert.match(NEW, /onClick=\{\(\) => setInspecting\(img\)\}/, "a thumbnail does not open anything");
  // The inspector is full-viewport, scrollable, and shows the image at natural
  // size — a page scaled to fit is a bigger thumbnail, not a document.
  const modal = NEW.slice(NEW.indexOf("{inspecting && ("), NEW.indexOf("{error && ("));
  assert.match(modal, /fixed inset-0/, "the inspector is not full viewport");
  assert.match(modal, /overflow-auto/, "the inspector cannot be panned");
  assert.match(modal, /max-w-none/, "the inspector shrinks the page to fit, which is the defect again");
  assert.ok(!/object-contain/.test(modal), "the inspector contains the image instead of showing it full size");
  assert.match(modal, /role="dialog"[\s\S]*?aria-modal="true"/, "the inspector is not a labelled dialog");
});

test("EVERY OBJECT URL IS REVOKED — on removal AND on unmount", () => {
  assert.match(NEW, /function removeImage[\s\S]*?URL\.revokeObjectURL\(target\.preview\)/,
    "removing a picture leaks its blob");
  assert.match(NEW, /useEffect\(\(\) => \(\) => \{[\s\S]*?for \(const img of imagesRef\.current\) URL\.revokeObjectURL/,
    "leaving the page leaks every blob");
  assert.equal((NEW.match(/URL\.createObjectURL/g) ?? []).length, 1,
    "an object URL is created somewhere that may not revoke it");
});

// ---------------------------------------------------------------------------
// 5. PROVENANCE
// ---------------------------------------------------------------------------

test("PERSISTENCE STILL WAITS FOR CONTINUE", () => {
  const one = NEW.slice(NEW.indexOf("async function transcribeOne"), NEW.indexOf("async function readOneTextFile"));
  assert.ok(!/source-image/.test(one), "reading a picture also stores it");
  const organize = NEW.slice(NEW.indexOf("async function handleOrganize"));
  assert.match(organize, /\/api\/ingest\/source-image/, "Continue does not keep the pictures");
  // SEQUENTIALLY, so the stored order is the supplied order.
  // Only the transcribed ones, one at a time, in list order.
  assert.match(organize, /for \(const img of sourceImages\.filter\(\(x\) => x\.status === "done"\)\)[\s\S]*?sourceImageUrls\.push/,
    "the pictures are not stored one at a time in order");
  assert.ok(!/Promise\.all/.test(organize), "the pictures are stored concurrently, so their order is a race");
  // One failure stops everything: a run that cannot carry its provenance must
  // not exist.
  assert.match(organize, /setProcessing\(false\);\s*\n\s*return;/, "a failed store still organizes");
});

test("DUAL WRITE: singular is the FIRST, the array is all of them, in order", () => {
  const organize = NEW.slice(NEW.indexOf("async function handleOrganize"));
  assert.match(organize, /sourceImageUrl: sourceImageUrls\[0\], sourceImageUrls/,
    "the singular column is not the first stored image");
  // The server derives both from one list, so a client that disagrees with
  // itself cannot half-record a run.
  assert.match(ORGANIZE, /stamp\.source_image_urls = sourceImageUrls\.length && sourceImageUrls\[0\] === sourceImageUrl/,
    "the array is trusted without checking it leads with the singular URL");
  assert.match(ORGANIZE, /: \[sourceImageUrl\];/,
    "a request with no array does not fall back to a one-element one");
  // ONE UPDATE for all three, because 0045's and 0048's rules both refuse a row
  // whose columns disagree.
  const stamp = ORGANIZE.slice(ORGANIZE.indexOf("const stamp"), ORGANIZE.indexOf(".update(stamp)"));
  for (const field of ["source_origin", "source_image_url", "source_image_urls"])
    assert.ok(stamp.includes(`stamp.${field}`), `${field} is not stamped with the others`);
  assert.match(ORGANIZE, /\.update\(stamp\)/);
  // AND IT FAILS CLOSED.
  assert.match(ORGANIZE, /provenance_not_recorded/, "a failed stamp no longer stops the run");
});

test("ONE PICTURE IS A ONE-ELEMENT ARRAY — no special case", () => {
  // No branch on count in the DATA path: the singular case is the plural case
  // with one element, which is what stops a second source of truth appearing.
  // (The card's heading does say "picture" or "pictures" — that is copy, and it
  // is deliberately outside this slice.)
  const organize = NEW.slice(NEW.indexOf("async function handleOrganize"),
                             NEW.indexOf("async function handleStartBlank"));
  assert.ok(!/length === 1|length > 1/.test(organize), "the client branches on how many pictures there are");
  assert.ok(!/length === 1|length > 1/.test(ORGANIZE), "the server branches on how many pictures there are");
  // And the loop itself is count-agnostic.
  assert.match(organize, /for \(const img of sourceImages\.filter\(/, "the store path is not a plain loop");
});

test("SOURCE IMAGES NEVER BECOME item_photos", () => {
  // They are evidence on the run, not content on an item. Nothing in either
  // path may write the recipient-facing photo table.
  for (const f of ["src/components/new/new-packet-workspace.tsx",
                   "src/app/api/ingest/source-image/route.ts",
                   "src/app/api/ingest/transcribe/route.ts",
                   "src/app/api/ingest/organize/route.ts",
                   "src/lib/source-bundle.ts"])
    assert.ok(!/item_photos/.test(codeOf(f)), `${f} writes a source image into item_photos`);
});

// ---------------------------------------------------------------------------
// 6. NOTHING ELSE MOVED
// ---------------------------------------------------------------------------

test("OMISSION AND GROUPING BEHAVIOUR ARE UNTOUCHED", () => {
  for (const f of ["src/lib/omitted-source.ts", "src/lib/grouping.ts",
                   "src/lib/declared-record.ts", "src/lib/collapse-run.ts"])
    assert.ok(!/source_image|sourceImage|BundleItem/.test(codeOf(f)),
      `${f} learned about source images`);
  const finalize = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.equal((finalize.match(/buildOmission\(/g) ?? []).length, 1);
  assert.match(finalize, /omission_check_failed/);
  // The organize route still carries the grouping pair, coherent, in the same
  // statement as the image pair.
  const stamp = ORGANIZE.slice(ORGANIZE.indexOf("const stamp"), ORGANIZE.indexOf(".update(stamp)"));
  assert.match(stamp, /stamp\.grouping_intent = groupingIntent/);
  assert.match(stamp, /stamp\.grouping_title =/);
});
