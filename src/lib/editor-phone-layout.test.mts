// THE LEGACY EDITOR HAS TO BE EDITABLE ON A PHONE.
//
// It is where every new Sendset lands — /new creates a legacy packet and sends
// the professional straight into it — and on an iPhone it was a page 504px wide
// in a 375px viewport. Every detail's value, every remove button and the whole
// "Move to" control sat past the right edge, and the controls that were on
// screen were 15 to 24px targets. The chrome had been converted to the creator
// design system; the inside of an item, where the editing happens, never was.
//
// Measured after the fix at 320, 375 and 390px against a mounted editor served
// over http: nothing past the edge, every item-level control at least 40px, the
// narrowest typing field 156px at 320 — and at 1280px the same rows, side by
// side, as before.
//
// This file is source-level because the property is a layout one and jsdom has
// no layout engine. What it pins is each mechanism that measurement relied on,
// so that tidying one of them away is a test failure rather than a phone that
// quietly stops working again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const EDITOR = read("src/components/editor/legacy-packet-editor.tsx");
const BUTTON = read("src/components/ui/button.tsx");

/** One component's body, from its declaration to the next top-level function. */
function component(name: string) {
  const from = EDITOR.indexOf(`function ${name}(`);
  assert.ok(from >= 0, `${name} is gone`);
  const next = EDITOR.indexOf("\nfunction ", from + 10);
  return EDITOR.slice(from, next > from ? next : undefined);
}

test("A DETAIL'S LABEL AND VALUE STACK ON A PHONE, and sit side by side from sm", () => {
  const row = component("SortableDetailRow");
  assert.match(row, /flex min-w-0 flex-1 flex-col gap-1\.5 sm:flex-row/,
    "the label/value pair no longer stacks on a phone — each field is ~145px again");
  // Both fields may shrink; without this an <input> holds ~20 characters of
  // width and the pair pushes the page sideways.
  const inputs = row.match(/<input[\s\S]*?\/>/g) ?? [];
  assert.equal(inputs.length, 2, "a detail row should have exactly two fields");
  for (const i of inputs) assert.match(i, /min-w-0/, "a detail field cannot shrink");
});

test("LINK ROWS STACK THE SAME WAY", () => {
  const item = component("ItemEditor");
  const at = item.indexOf("onUpdateLink(item.id, link.id, \"url\"");
  assert.ok(at > 0, "the link row moved");
  const row = item.slice(item.lastIndexOf("<div key={link.id}", at), item.indexOf("</Button>", at));
  assert.match(row, /flex-col gap-1\.5 sm:flex-row/, "the url and label fields no longer stack on a phone");
});

/** The custom-organization links: packet-level rather than item-level, but the
 *  same two-fields-and-a-remove row, and outside both components above — which
 *  is how a mutation to it once passed this file untouched. */
function customLinks() {
  const from = EDITOR.indexOf("updateCustomLink(index, \"label\"");
  assert.ok(from > 0, "the custom links row moved");
  return EDITOR.slice(EDITOR.lastIndexOf("<div key={index}", from), EDITOR.indexOf("</Button>", from));
}

test("NO FIELD IN AN ITEM IS A FLEX CHILD THAT CANNOT SHRINK", () => {
  // The systemic cause: 25 flex inputs without min-w-0. Any field that grows
  // with flex must also be allowed to shrink.
  const scopes: Array<[string, string]> = [
    ["SortableDetailRow", component("SortableDetailRow")],
    ["ItemEditor", component("ItemEditor")],
    ["custom links", customLinks()],
  ];
  for (const [name, body] of scopes) {
    // EACH FIELD'S OWN className, read up to the next field. Matching the tag
    // to its first ">" stopped inside `onChange={(e) =>`, so any field whose
    // className came after its handler was read as having no classes and was
    // skipped — which is how removing min-w-0 from two rows passed this test.
    const fields = [...body.matchAll(
      /<(input|select)\b((?:(?!<(?:input|select)\b)[\s\S])*?)className=\{?[`"]([^`"]*)[`"]/g)]
      .map((m) => ({ tag: m[0], cls: m[3] }));
    assert.ok(fields.length > 0, `${name}: found no fields — this test is reading the wrong code`);
    for (const { tag, cls } of fields) {
      if (/type="file"/.test(tag)) continue;
      if (!/flex-1|flex-\[2\]/.test(cls)) continue;
      assert.match(cls, /min-w-0/, `${name}: a flex field cannot shrink: ${cls}`);
    }
  }
  // …and the custom links stack on a phone like the item's own link rows.
  assert.match(customLinks(), /flex-col gap-1\.5 sm:flex-row/,
    "the custom links row no longer stacks on a phone");
});

test("THE ITEM HEADER'S ACTIONS TAKE THEIR OWN LINE ON A PHONE", () => {
  const item = component("ItemEditor");
  assert.match(item, /flex flex-wrap items-center gap-2 sm:flex-nowrap/,
    "the item header no longer wraps, so Move to / collapse / delete run off the screen");
  assert.match(item, /flex w-full items-center justify-end gap-1 sm:w-auto sm:flex-none/,
    "the actions no longer take a full line on a phone");
});

test("ITEM-LEVEL ACTIONS ARE THE SHARED BUTTON, not hand-sized glyphs", () => {
  assert.match(BUTTON, /icon: "h-10 w-10 sm:h-8 sm:w-8/, "the square button size is gone");
  const item = component("ItemEditor") + component("SortableDetailRow");
  for (const label of ["Delete item", "Remove link", "Remove photo", "Reorder detail", "Drag to reorder"])
    assert.match(item, new RegExp(`<Button[^>]*?(size="icon"[\\s\\S]{0,300}?${label}|${label}[\\s\\S]{0,300}?size="icon")`),
      `"${label}" is not a square shared Button`);
  // The one raw <button> left is the photo overlay, which is positioned over a
  // thumbnail and has its own touch treatment below.
  const raw = item.match(/<button\b/g) ?? [];
  assert.equal(raw.length, 1, `an item-level control is a hand-sized <button> again (${raw.length})`);
  // Nothing in an item is a 1.5-padding bordered field any more.
  assert.doesNotMatch(item, /px-2\.5 py-1\.5 rounded border border-line text-body/,
    "an undersized field is back instead of INPUT_SHELL");
});

test("A DRAG HANDLE STILL LETS A FINGER DRAG", () => {
  // touch-none is what makes the pointer sensor read a finger drag as a drag
  // rather than a page scroll. Making the handle a Button must not drop it.
  assert.match(EDITOR, /const HANDLE = "touch-none cursor-grab active:cursor-grabbing"/);
  for (const name of ["SortableDetailRow", "ItemEditor"])
    assert.match(component(name), /\{\.\.\.listeners\}[\s\S]{0,120}className=\{`\$\{HANDLE\}/,
      `${name}: the drag handle lost touch-none`);
});

test("A PHOTO CAN BE REMOVED WITHOUT A MOUSE", () => {
  // It was opacity-0 until hovered, and a touch screen has no hover.
  const item = component("ItemEditor");
  const overlay = item.slice(item.indexOf('aria-label="Remove photo"') - 200, item.indexOf('aria-label="Remove photo"') + 500);
  assert.match(overlay, /group-hover:opacity-100/, "the desktop hover reveal is gone");
  assert.match(overlay, /pointer-coarse:opacity-100/,
    "the remove button is invisible on a touch screen again");
  assert.match(overlay, /pointer-coarse:h-8 pointer-coarse:w-8/, "the touch target shrank back to 20px");
});

test("CONTACTS ARE ONE COLUMN ON A PHONE", () => {
  const item = component("ItemEditor");
  assert.match(item, /grid grid-cols-1 gap-2 sm:grid-cols-2/, "contacts are two ~140px columns on a phone again");
  // A bare col-span-2 in a one-column grid opens an implicit second column.
  assert.match(item, /sm:col-span-2/);
  assert.doesNotMatch(item, /\$\{cInput\} col-span-2/, "col-span-2 applies on a phone and breaks the grid");
});

test("DESKTOP IS THE SAME ROWS — every stack is undone at sm", () => {
  // Each phone-only arrangement must name its sm: counterpart, or desktop got
  // the phone layout too.
  const both = component("SortableDetailRow") + component("ItemEditor");
  const stacks = both.match(/flex-col gap-1\.5 sm:flex-row/g) ?? [];
  assert.ok(stacks.length >= 2, "expected the detail and link stacks");
  assert.equal((both.match(/\bflex-col\b/g) ?? []).length,
    (both.match(/sm:flex-row/g) ?? []).length,
    "a flex-col in the item editor has no sm:flex-row, so desktop stacks as well");
});
