// ADDING A PICTURE DIRECTLY TO A SENDSET.
//
// The picture is an ordinary item: same table, same item_photos, same three
// renderers. What is new is a way to add one without first inventing a thing to
// hang it on, and a field that calls itself Caption when that is what it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isPictureItem, titleLabelFor } from "./picture-item.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDITOR = readFileSync(join(ROOT, "src/components/editor/legacy-packet-editor.tsx"), "utf8");
const PHOTO = { id: "p1", url: "https://x.test/storage/v1/object/public/packet-photos/abc.jpg" };

// ---------------------------------------------------------------------------
// WHAT COUNTS AS A PICTURE
// ---------------------------------------------------------------------------

test("a photo and nothing else IS a picture", () => {
  assert.equal(isPictureItem({ photos: [PHOTO] }), true);
  assert.equal(titleLabelFor({ photos: [PHOTO] }), "Caption");
  // Bare-string photos, the shape the Library stores.
  assert.equal(isPictureItem({ photos: [PHOTO.url] }), true);
});

test("NO PHOTO IS NOT A PICTURE, and neither is a blank photo row", () => {
  assert.equal(isPictureItem({ photos: [] }), false);
  assert.equal(isPictureItem({}), false);
  assert.equal(isPictureItem(null), false);
  // "Add photo" leaves an empty row on screen while it is being typed into.
  assert.equal(isPictureItem({ photos: [{ id: "p1", url: "" }] }), false);
  assert.equal(isPictureItem({ photos: [{ id: "p1", url: "not a url" }] }), false);
  assert.equal(titleLabelFor({ photos: [] }), "Item title");
});

test("IT STOPS BEING A PICTURE the moment it carries anything else", () => {
  for (const [field, value] of [
    ["address", "1 A St"],
    ["description", "A place"],
  ] as const)
    assert.equal(isPictureItem({ photos: [PHOTO], [field]: value }), false,
      `${field} no longer makes it a thing rather than an image`);

  assert.equal(isPictureItem({ photos: [PHOTO], details: [{ label: "Rent", value: "$1" }] }), false);
  assert.equal(isPictureItem({ photos: [PHOTO], links: [{ url: "https://x.test" }] }), false);
  assert.equal(isPictureItem({ photos: [PHOTO], contacts: [{ name: "Dana" }] }), false);
  assert.equal(titleLabelFor({ photos: [PHOTO], address: "1 A St" }), "Item title");
});

test("A ROW THE CREATOR HAS NOT FILLED IN is not content", () => {
  // The editor keeps blank rows on screen while they are being typed into and
  // persistence drops them; counting them would flip the label mid-keystroke.
  assert.equal(isPictureItem({ photos: [PHOTO], details: [{ label: "", value: "" }] }), true);
  assert.equal(isPictureItem({ photos: [PHOTO], links: [{ url: "" }] }), true);
  assert.equal(isPictureItem({
    photos: [PHOTO],
    contacts: [{ name: "", role: "", phone: "", email: "", website: "" }],
  }), true);
});

test("A PRIVATE NOTE SAYS NOTHING about what the item is to a reader", () => {
  // notes never reach a recipient, so they cannot make a picture stop being one.
  assert.equal(isPictureItem({ photos: [PHOTO], notes: "call them back" } as never), true);
});

// ---------------------------------------------------------------------------
// THE ORDER THE FLOW HAPPENS IN — this is the whole safety of it
// ---------------------------------------------------------------------------

const addPicture = () =>
  EDITOR.slice(EDITOR.indexOf("async function addPicture("),
               EDITOR.indexOf("async function addItem(sectionId: string)"));

test("UPLOAD FIRST, CREATE SECOND — a cancelled picker leaves nothing", () => {
  const fn = addPicture();
  const upload = fn.indexOf("/photos`");
  const create = fn.indexOf("addItem(sectionId)");
  assert.ok(upload > -1, "the picture is not uploaded through the packet photo route");
  assert.ok(create > -1, "no item is created");
  assert.ok(upload < create,
    "the item is created before the upload, so a cancel or a failure strands an " +
    "untitled item — which also blocks publishing");
});

test("A FAILED UPLOAD RETURNS before anything is created", () => {
  const fn = addPicture();
  const guard = fn.indexOf("if (!up.ok || !stored?.url)");
  assert.ok(guard > -1, "the upload result is not checked");
  assert.ok(guard < fn.indexOf("addItem(sectionId)"), "the check comes after the item is made");
  assert.match(fn.slice(guard, guard + 200), /return;/, "a failed upload falls through");
});

test("CHOOSING NOTHING DOES NOTHING", () => {
  // The control is a native file input; cancelling it fires no change with a
  // file, and the handler refuses to run without one.
  const control = EDITOR.slice(EDITOR.indexOf("+ Add picture"), EDITOR.indexOf("+ Add items with AI"));
  assert.match(control, /if \(f\) addPicture\(section\.id, f\)/,
    "the flow can start without a file");
  assert.match(control, /e\.target\.value = ""/, "the same file cannot be chosen twice");
});

test("THE FAILURE IS SHOWN WHERE THE ACTION WAS, not inside an item", () => {
  // photoError renders inside an item's photo block. A picture that failed has
  // no item, so it needs its own channel or the message lands unseen.
  assert.match(addPicture(), /setPictureError\(/, "it reports through the item photo error");
  assert.ok(!/setPhotoError\(/.test(addPicture()), "it still writes to the item-level error");
  assert.match(EDITOR, /\{pictureError && \(/, "the picture error is never rendered");
});

// ---------------------------------------------------------------------------
// AND NOTHING ARCHITECTURAL MOVED
// ---------------------------------------------------------------------------

test("IT REUSES THE EXISTING UPLOAD ROUTE AND THE EXISTING PHOTO SHAPE", () => {
  const fn = addPicture();
  assert.match(fn, /\/api\/packets\/\$\{packetId\}\/photos/,
    "it does not use the ownership-checked packet photo route");
  // The same payload the ordinary photo path sends, so update_item_content and
  // every renderer see exactly what they already handle.
  assert.match(fn, /photos: \[\{ url \}\]/, "the stored shape is not the existing one");
  assert.ok(!/storage_path|caption|image_block|picture_items/.test(fn),
    "the flow invented a new field or table");
});

test("the entry point sits beside Add Item, in the section", () => {
  const row = EDITOR.slice(EDITOR.indexOf("+ Add Item"), EDITOR.indexOf("+ Add items with AI"));
  assert.match(row, /\+ Add picture/, "there is no Add picture control in the section row");
  assert.match(row, /accept=\{PHOTO_ACCEPT_ATTR\}/,
    "the picker accepts anything, rather than the types the bucket allows");
});
