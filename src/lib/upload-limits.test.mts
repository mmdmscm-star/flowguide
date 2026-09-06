// TWO LIMITS THAT WERE ONE NUMBER, AND THE SMALLER ONE WAS INVISIBLE.
//
// MAX_PHOTO_BYTES said 10MB, the bucket said 10MB, and five routes said 10MB.
// The platform said 4.5MB and said it first — before any of our code ran, as a
// plain-text FUNCTION_PAYLOAD_TOO_LARGE that `res.json()` turned into nothing
// and the browser reported as "That picture could not be read."
//
// MEASURED against the deployed route, posting bodies of increasing size to an
// endpoint that answers 401 whenever it is reached at all:
//
//   4000 KB -> 401     4300 KB -> 401     4400 KB -> 413     4500 KB -> 413
//
// So the transport budget is 4 MiB, with roughly 200 KB of measured headroom
// for multipart framing. The bucket's capability did not change and did not
// need to: what storage accepts and what a request can carry are two facts.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_UPLOAD_BYTES, MAX_PHOTO_BYTES, OVERSIZED_IMAGE_MESSAGE } from "./photo-upload.ts";
import { planBundle, blockingImage, blockingMessage } from "./source-bundle.ts";
import { removeContributedBlock } from "./contributed-block.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NEW = codeOf("src/components/new/new-packet-workspace.tsx");

const ROUTES = [
  "src/app/api/ingest/transcribe/route.ts",
  "src/app/api/ingest/source-image/route.ts",
  "src/app/api/library/images/route.ts",
  "src/app/api/profile/images/route.ts",
  "src/app/api/packets/[id]/photos/route.ts",
];
const file = (name: string, size: number, type = "image/jpeg") =>
  ({ name, type, size }) as unknown as File;

// ---------------------------------------------------------------------------
// 1. THE TWO LIMITS
// ---------------------------------------------------------------------------

test("THE TRANSPORT BUDGET IS 4 MiB, and it is not the bucket's limit", () => {
  assert.equal(MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_PHOTO_BYTES, 10 * 1024 * 1024);
  assert.ok(MAX_UPLOAD_BYTES < MAX_PHOTO_BYTES,
    "the transport budget is not smaller than what storage accepts, so one of them is wrong");
  // The rationale travels with the constant, and it is named as a measurement
  // rather than as somebody else's published limit.
  const src = raw("src/lib/photo-upload.ts");
  assert.match(src, /4300 KB\s+->\s+401/, "the measurement is not recorded beside the constant");
  assert.match(src, /4400 KB\s+->\s+413/, "the failing measurement is not recorded");
  assert.match(src, /NOT a provider limit and NOT a\s*\n--?\s*\/\/ storage limit|NOT a provider limit/,
    "the constant is described as somebody else's limit");
});

test("THE BUCKET IS UNCHANGED, and equality with it is no longer claimed", () => {
  // 0029's bucket row still says 10MB. The storage capability does not shrink
  // because the transport did, and this package drafts no migration.
  const sql = raw("supabase/migrations/0029_packet_photo_storage.sql");
  assert.ok(sql.includes(String(MAX_PHOTO_BYTES)), "the bucket limit moved");
  assert.ok(!sql.includes(String(MAX_UPLOAD_BYTES)), "the bucket was changed to the transport budget");
  // The old invariant — that our ceiling EQUALS the bucket's — is retired: it
  // was true and it was the reason the real limit stayed invisible.
  const t = raw("src/lib/photo-upload.test.mts");
  assert.ok(!/MAX_UPLOAD_BYTES/.test(t) || /transport/.test(t),
    "the bucket test conflates the two limits again");
});

test("EVERY IMAGE ROUTE GATES ON THE TRANSPORT BUDGET, and says the same sentence", () => {
  for (const r of ROUTES) {
    const src = codeOf(r);
    assert.match(src, /file\.size > MAX_UPLOAD_BYTES/, `${r} does not gate on the transport budget`);
    assert.match(src, /OVERSIZED_IMAGE_MESSAGE/, `${r} writes its own sentence`);
    assert.ok(!/MAX_PHOTO_BYTES/.test(src),
      `${r} still gates on the bucket's limit, which no request can reach`);
  }
  // The storage layer keeps its own check, beneath them.
  assert.match(codeOf("src/lib/photo-upload.ts"), /bytes\.length > MAX_PHOTO_BYTES/,
    "the storage layer lost its own limit");
  assert.match(OVERSIZED_IMAGE_MESSAGE, /larger than Sendset can upload right now/);
  assert.match(OVERSIZED_IMAGE_MESSAGE, /under 4 MB/);
});

test("THE BROWSER REFUSES BEFORE THE REQUEST EXISTS", () => {
  // It is holding the File, and the platform's own refusal is plain text that
  // `res.json()` turns into nothing — so the useful sentence has to come from
  // here or not at all.
  const client = codeOf("src/lib/image-upload-client.ts");
  assert.match(client, /if \(file\.size > MAX_UPLOAD_BYTES\) return \{ error: OVERSIZED_IMAGE_MESSAGE \}/,
    "the uploader starts a request it knows will be refused");
  assert.ok(client.indexOf("MAX_UPLOAD_BYTES") < client.indexOf("fetch("),
    "the size check runs after the request has begun");
});

// ---------------------------------------------------------------------------
// 2. WHOLE-BUNDLE PREFLIGHT
// ---------------------------------------------------------------------------

test("ONE OVERSIZED PICTURE REFUSES THE WHOLE BUNDLE, by name", () => {
  const big = file("page3.jpg", MAX_UPLOAD_BYTES + 1);
  const p = planBundle([file("page1.jpg", 900_000), file("page2.jpg", 900_000), big]);
  assert.equal(p.ok, false, "an oversized picture was accepted into the plan");
  if (p.ok) return;
  assert.match(p.message, /^page3\.jpg: /, "the refusal does not name the offending file");
  assert.match(p.message, /under 4 MB/);
  // NOTHING is processed: a professional watching two of three pages succeed
  // has every reason to believe the source is complete.
  const ingest = NEW.slice(NEW.indexOf("async function ingestFiles"), NEW.indexOf("function removeImage"));
  assert.match(ingest, /const plan = planBundle\(files\);\s*\n\s*if \(!plan\.ok\) \{ setError\(plan\.message\); return; \}/,
    "the bundle is processed before it is validated");
  assert.ok(ingest.indexOf("planBundle") < ingest.indexOf("URL.createObjectURL"),
    "previews are created before the bundle is checked");
});

test("exactly at the budget is fine; one byte over is not", () => {
  assert.equal(planBundle([file("a.jpg", MAX_UPLOAD_BYTES)]).ok, true);
  assert.equal(planBundle([file("a.jpg", MAX_UPLOAD_BYTES + 1)]).ok, false);
  // A TEXT FILE IS NOT SIZED AGAINST THE IMAGE BUDGET. It has its own, smaller
  // rule — MAX_IMPORT_CHARS * 4, roughly 800KB — because it is read into the box
  // rather than uploaded, and that limit is about how much text is organizable
  // rather than about what a request can carry. Both refusals are real; they are
  // different sentences because they are different problems.
  const bigText = planBundle([file("notes.txt", MAX_UPLOAD_BYTES + 1, "text/plain")]);
  assert.equal(bigText.ok, false);
  if (!bigText.ok) {
    assert.match(bigText.message, /too large/);
    assert.ok(!/under 4 MB/.test(bigText.message),
      "a text file was refused with the image transport sentence");
  }
  assert.equal(planBundle([file("notes.txt", 700_000, "text/plain")]).ok, true,
    "an ordinary text file was caught by a size rule meant for pictures");
});

// ---------------------------------------------------------------------------
// 3. EXACT-BLOCK REMOVAL
// ---------------------------------------------------------------------------

const BLOCK = "Fees listed are as of April 1, 2026 and are subject to change.";

test("AN UNTOUCHED UNIQUE BLOCK COMES OUT WITH ITS SEPARATOR", () => {
  const r = removeContributedBlock(`First page text.\n\n${BLOCK}\n\nThird page text.`, BLOCK);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.text, "First page text.\n\nThird page text.", "the separator was left behind");
  // First block, and only block.
  const first = removeContributedBlock(`${BLOCK}\n\nSecond page.`, BLOCK);
  assert.deepEqual(first, { ok: true, text: "Second page." });
  assert.deepEqual(removeContributedBlock(BLOCK, BLOCK), { ok: true, text: "" });
});

test("AN EDITED BLOCK IS REFUSED, and the text is untouched", () => {
  const edited = `First page.\n\nFees listed are as of April 1, 2026 and are subject to change WITHOUT NOTICE.`;
  const r = removeContributedBlock(edited, BLOCK);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "missing");
  assert.match(r.message, /you’ve changed or removed it/);
  // Deleted entirely is the same answer.
  assert.equal(removeContributedBlock("First page only.", BLOCK).ok, false);
  assert.equal(removeContributedBlock("anything", "").ok, false, "an empty block was removable");
});

test("A DUPLICATED BLOCK IS REFUSED — Sendset cannot tell which copy is which", () => {
  const twice = `${BLOCK}\n\nsomething else\n\n${BLOCK}`;
  const r = removeContributedBlock(twice, BLOCK);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "duplicated");
  assert.match(r.message, /appears more than once/);
  assert.equal(twice, `${BLOCK}\n\nsomething else\n\n${BLOCK}`, "the text was modified by a refusal");
});

test("THE COMPONENT APPLIES THAT RULE, AND ONLY THAT RULE", () => {
  const rm = NEW.slice(NEW.indexOf("function removeImage"), NEW.indexOf("const imagesRef"));
  // reading: not removable at all.
  assert.match(rm, /if \(target\.status === "reading"\)[\s\S]{0,160}return;/,
    "a picture can be removed while its request is in flight");
  // done: exact-block or refuse.
  assert.match(rm, /removeContributedBlock\(rawText, target\.contributedText \?\? "", siblings\)/,
    "a transcribed picture is removed without accounting for its text");
  assert.match(rm, /if \(!cut\.ok\) \{ setError\(`\$\{target\.label\}: \$\{cut\.message\}`\); return; \}/,
    "a refusal is not explained, or does not stop the removal");
  // The ONLY setRawText in the removal path is the exact cut.
  assert.equal((rm.match(/setRawText\(/g) ?? []).length, 1,
    "the removal path writes the box more than once");
  assert.match(rm, /setRawText\(cut\.text\)/, "the removal path edits text it did not cut");
  // failed: no text was contributed, so nothing is checked.
  assert.ok(rm.indexOf('=== "done"') > 0, "a failed picture is held to the transcribed rule");
});

// ---------------------------------------------------------------------------
// 4. THE IN-FLIGHT RACE
// ---------------------------------------------------------------------------

test("A STALE COMPLETION CANNOT APPEND FOR A REMOVED PICTURE", () => {
  const one = NEW.slice(NEW.indexOf("async function transcribeOne"), NEW.indexOf("async function readOneTextFile"));
  assert.match(one, /if \(!liveIds\.current\.has\(entry\.id\)\) return false;\s*\n\s*append\(data\.text\);/,
    "the liveness check is not immediately before the append");
  // A ref, because React state is not readable from inside the awaited handler
  // — and removeImage updates it synchronously, so the check cannot race.
  assert.match(NEW, /const liveIds = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(NEW, /liveIds\.current\.add\(id\)/, "a new picture is never marked live");
  assert.match(NEW, /liveIds\.current\.delete\(id\)/, "a removed picture stays live");
});

test("LABELS NEVER COLLIDE AFTER A REMOVAL", () => {
  // Numbered from a monotonic counter. From the list length, removing picture 2
  // made the next one "Picture 2" as well — and the label's one job is to name
  // the failure unambiguously.
  assert.match(NEW, /const pictureSeq = useRef\(0\)/);
  assert.match(NEW, /label: `Picture \$\{\+\+pictureSeq\.current\}`/);
  const ingest = NEW.slice(NEW.indexOf("async function ingestFiles"), NEW.indexOf("function removeImage"));
  assert.ok(!/sourceImages\.length/.test(ingest), "labels are still derived from the list length");
});

// ---------------------------------------------------------------------------
// 5. THE WINDOW THIS PACKAGE DOES NOT CLOSE
// ---------------------------------------------------------------------------

test("THE RESIDUAL RETENTION WINDOW IS NAMED, not papered over", () => {
  const organize = raw("src/components/new/new-packet-workspace.tsx");
  assert.match(organize, /KNOWN AND NOT FIXED HERE/,
    "the orphan window is not documented where the loop is");
  assert.match(organize, /nothing in this codebase deletes a storage object/i);
  assert.match(organize, /shipped long before this change, with one image/,
    "the pre-existing half of the window is presented as new");
  assert.match(organize, /4300 KB reaches the function, 4400 KB does not/,
    "the reason a batch is impossible is not recorded beside the loop");
  // And it is still true that nothing deletes.
  const anyDelete = ROUTES.concat(["src/lib/photo-upload.ts"])
    .filter((f) => /storage[\s\S]{0,40}\.(remove|delete)\(/.test(codeOf(f)));
  assert.deepEqual(anyDelete, [], "a deletion path appeared without its ownership design");
});

// ---------------------------------------------------------------------------
// 6. ORGANIZE IS A CLAIM ABOUT COMPLETENESS
//
// It says: this text is the source, and these images are what it was read from.
// Neither half is true while a picture is unsettled — and the database cannot
// tell, because 0048 checks that the evidence a run CLAIMS is coherent, never
// that the claim is complete.
// ---------------------------------------------------------------------------

type Pic = { id: string; label: string; status: "reading" | "done" | "failed" };
const pic = (label: string, status: Pic["status"]): Pic => ({ id: label, label, status });

test("A READING PICTURE BLOCKS ORGANIZE, and says so by name", () => {
  // Three selected, page 3 still in flight. handleOrganize snapshots rawText on
  // its first line, so proceeding would create the run from text missing page 3
  // while storing the image page 3 came from.
  const b = blockingImage([pic("Picture 1", "done"), pic("Picture 2", "done"), pic("Picture 3", "reading")]);
  assert.equal(b?.label, "Picture 3");
  assert.equal(blockingMessage(b!), "Picture 3 is still being read. Wait for it to finish before organizing.");
});

test("A FAILED PICTURE BLOCKS ORGANIZE, and names both exits", () => {
  // Three selected, pages 1-2 transcribed, page 3 refused. Storing it would put
  // an image in source_image_urls with nothing in source_text behind it.
  const b = blockingImage([pic("Picture 1", "done"), pic("Picture 2", "done"), pic("Picture 3", "failed")]);
  assert.equal(b?.label, "Picture 3");
  assert.match(blockingMessage(b!), /Try it again or remove it before organizing/);
});

test("the FIRST unsettled picture is named, and a settled bundle blocks nothing", () => {
  const b = blockingImage([pic("Picture 1", "failed"), pic("Picture 2", "reading")]);
  assert.equal(b?.label, "Picture 1", "a later picture was named ahead of an earlier one");
  assert.equal(blockingImage([pic("Picture 1", "done"), pic("Picture 2", "done")]), null);
  assert.equal(blockingImage([]), null, "a text-only source is blocked by nothing");
});

test("THE HANDLER IS THE GUARANTEE, and the button agrees with it", () => {
  const organize = NEW.slice(NEW.indexOf("async function handleOrganize"),
                             NEW.indexOf("async function handleStartBlank"));
  // Refused BEFORE any work: before setProcessing, before the request key,
  // before a single byte is uploaded.
  assert.match(organize, /const blocked = blockingImage\(sourceImages\);\s*\n\s*if \(blocked\) \{ setError\(blockingMessage\(blocked\)\); return; \}/,
    "Organize does not refuse an unsettled bundle");
  assert.ok(organize.indexOf("blockingImage") < organize.indexOf("setProcessing(true)"),
    "the guard runs after the organize has already begun");
  assert.ok(organize.indexOf("blockingImage") < organize.indexOf("source-image"),
    "a picture is uploaded before the bundle is checked");
  // The button uses the SAME predicate, so a disabled control and a refused
  // action cannot disagree about why.
  assert.match(NEW, /const blockingNow = blockingImage\(sourceImages\)/);
  assert.match(NEW, /const ready = Boolean\(rawText\.trim\(\)\) && !processing && !blockingNow;/,
    "the button can be pressed while a picture is unsettled");
  // And a disabled primary button with no reason reads as broken.
  assert.match(NEW, /\{blockingNow && \([\s\S]{0,300}blockingMessage\(blockingNow\)/,
    "the blocking picture is not named next to the button");
});

test("ONLY TRANSCRIBED, STILL-LIVE PICTURES ARE PERSISTED", () => {
  const organize = NEW.slice(NEW.indexOf("async function handleOrganize"),
                             NEW.indexOf("async function handleStartBlank"));
  // Said twice on purpose: the guard above already means every picture is
  // `done`, but this loop is what actually writes provenance and should not
  // depend on a check twenty lines away to be correct.
  assert.match(organize, /for \(const img of sourceImages\.filter\(\(x\) => x\.status === "done"\)\)/,
    "the persistence loop stores pictures that were never transcribed");
  // A REMOVED picture cannot reappear here: removeImage takes it out of
  // sourceImages entirely, with its contributed text, together or not at all.
  const rm = NEW.slice(NEW.indexOf("function removeImage"), NEW.indexOf("const imagesRef"));
  assert.match(rm, /setSourceImages\(\(prev\) => prev\.filter\(\(x\) => x\.id !== id\)\)/,
    "a removed picture stays in the list the persistence loop walks");
  assert.match(rm, /liveIds\.current\.delete\(id\)/, "a removed picture stays live");
  // The loop's only source is that same list.
  assert.equal((organize.match(/of sourceImages/g) ?? []).length, 1,
    "the persistence loop reads a second list of pictures");
});

test("A FAILED PICTURE CAN BE RETRIED, so removal is not the only way past it", () => {
  assert.match(NEW, /async function retryImage\(id: string\)/, "there is no retry");
  const retry = NEW.slice(NEW.indexOf("async function retryImage"), NEW.indexOf("function removeImage"));
  assert.ok(retry.length > 40 && retry.length < 900, `the retry slice is wrong: ${retry.length} chars`);
  assert.match(retry, /target\.status !== "failed"\) return;/, "a reading or done picture can be retried");
  assert.match(retry, /liveIds\.current\.add\(id\)/, "a retried picture is not live, so its result would be dropped");
  assert.match(retry, /await transcribeOne\(/, "retry does not use the same single-image path");
  assert.ok(!/fetch\(/.test(retry), "retry has its own backend call");
  assert.match(NEW, /onClick=\{\(\) => retryImage\(img\.id\)\}/, "there is no way to press it");
  assert.match(NEW, /img\.status === "failed" && \(/, "retry is offered on a picture that did not fail");
});

test("TWO PICTURES WITH IDENTICAL TEXT: neither can be removed", () => {
  // Pictures 1 and 2 are photographs of the same page, so they contribute the
  // same block. The professional then deletes one copy by hand — and the block
  // now appears EXACTLY ONCE, which is the condition removal used to accept.
  // Removing either picture would splice out the survivor, which belongs to the
  // other one just as much. Occurrence counting answers "how many copies";
  // it cannot answer "whose is this".
  const shared = "Fees listed are as of April 1, 2026 and are subject to change.";
  const afterManualEdit = `First page.\n\n${shared}\n\nThird page.`;
  assert.equal(afterManualEdit.split(shared).length - 1, 1, "the fixture no longer has exactly one copy");

  for (const label of ["Picture 1", "Picture 2"]) {
    const r = removeContributedBlock(afterManualEdit, shared, [shared]);
    assert.equal(r.ok, false, `${label} was removed on the strength of a copy it cannot be shown to own`);
    if (r.ok) return;
    assert.equal(r.reason, "shared");
    assert.match(r.message, /Another picture read exactly the same text/);
  }
  // AND THE TEXT IS UNTOUCHED, byte for byte.
  assert.equal(afterManualEdit, `First page.\n\n${shared}\n\nThird page.`);

  // Still refused while BOTH copies are present — the shared claim is checked
  // first, because it holds however many copies survive.
  const bothCopies = `${shared}\n\nmiddle\n\n${shared}`;
  const r2 = removeContributedBlock(bothCopies, shared, [shared]);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "shared");

  // A picture whose text no other live picture claims is unaffected.
  const alone = removeContributedBlock(afterManualEdit, shared, ["something else entirely"]);
  assert.equal(alone.ok, true, "an unshared block stopped being removable");
  if (alone.ok) assert.equal(alone.text, "First page.\n\nThird page.");
});

test("the component asks the question with every other LIVE done picture", () => {
  const rm = NEW.slice(NEW.indexOf("function removeImage"), NEW.indexOf("const imagesRef"));
  assert.match(rm, /\.filter\(\(x\) => x\.id !== id && x\.status === "done" && x\.contributedText\)/,
    "the siblings are not restricted to other live, transcribed pictures");
  assert.match(rm, /removeContributedBlock\(rawText, target\.contributedText \?\? "", siblings\)/,
    "the removal is decided without knowing what the other pictures claim");
});
