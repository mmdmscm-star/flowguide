// Gates on the paper renderer.
//
// These are SOURCE gates rather than render tests, deliberately and with a
// known limit: the renderer is a .tsx server component, and node's type
// stripping does not compile JSX, so it cannot be rendered here. What actually
// proves the output is a real Letter PDF, printed from a real packet through
// headless Chrome and inspected page by page - see the workstream notes.
//
// What these gates protect is the set of decisions that a PDF proof would catch
// only if someone re-ran it: the private-note exclusion, every photo being
// laid out, and the fragmentation rules. A print regression is unusually quiet
// - the page still renders, it just paginates badly - so the rules that took a
// paper proof to find are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recipientMetadata } from "./recipient-metadata.ts";

/** Source with comments stripped: a rule must be asserted against the CODE,
 *  never against a comment that happens to mention it. */
const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const RENDERER = "src/components/print/print-packet.tsx";
const ROUTE = "src/app/p/[slug]/print/page.tsx";
const CSS = "src/app/p/[slug]/print/print.css";

test("PRIVATE NOTES are never read by the paper renderer", () => {
  // queries.ts already strips notes for a recipient audience; this is the same
  // defence in depth the email renderer carries.
  assert.doesNotMatch(codeOf(RENDERER), /\.notes/, "the print renderer reads item.notes");
});

test("EVERY photo is laid out — no silent truncation", () => {
  const src = codeOf(RENDERER);
  // The live gallery mounts only a window of slides, which is exactly why this
  // renderer exists rather than a print stylesheet over the live page.
  assert.match(src, /rest\.map\(/, "the photos after the hero are not mapped over");
  for (const truncation of [/photos\.slice\(0,\s*\d/, /photos\[0\]\s*\]/, /\.slice\(0,\s*[1-9]\)/]) {
    assert.doesNotMatch(src, truncation, `the renderer truncates the gallery: ${truncation}`);
  }
});

test("tiles are squared by the source, and the hero is a bounded rendition", () => {
  const src = codeOf(RENDERER);
  assert.match(src, /squareThumbnailUrl\(/, "tiles are not square-cropped at the source");
  assert.match(src, /thumbnailUrl\(hero/, "the hero is not a bounded rendition");
});

test("the packet comes from the SAME source as the live page", () => {
  const src = codeOf(ROUTE);
  assert.match(src, /getPublishedPacket/, "print does not read the published packet");
  // A cached print page would keep serving a packet its owner had withdrawn.
  assert.match(src, /force-dynamic/, "the print route may be cached");
});

test("the print URL is private-by-link, like the page it prints", () => {
  // The route now shares ONE metadata constant with /p/[slug] — the two were
  // drifting, and the live page's marketing-OG leak was present here too. So
  // follow the indirection rather than grepping this file for `index: false`:
  // assert the route uses the shared object, and that the object is noindex.
  const src = codeOf(ROUTE);
  assert.match(src, /export const metadata: Metadata = recipientMetadata;/,
    "the print route does not use the shared recipient metadata");
  const r = recipientMetadata.robots as { index?: boolean; follow?: boolean };
  assert.equal(r?.index, false, "the print route is indexable");
  assert.equal(r?.follow, false, "the print route is followable");
});

test("only http(s) may be printed as a destination", () => {
  const src = codeOf(RENDERER);
  assert.match(src, /\^https\?:/, "the print renderer has no URL scheme guard");
});

test("FRAGMENTATION RULES — the ones a paper proof had to find", () => {
  const css = readFileSync(CSS, "utf8");

  // A price table split across a leaf was the real defect in the first Letter
  // proof: one table broke after a single "Type" row.
  assert.match(css, /\.pg-details\s*\{[^}]*break-inside:\s*avoid/,
    "the details table may split across pages again");

  // A community's name must never be the last thing on a page with its
  // photographs overleaf.
  assert.match(css, /\.pg-item-head[\s\S]{0,200}?break-after:\s*avoid/,
    "an item heading may be stranded at a page foot");

  // An item MAY break internally - forcing a dense card whole would either
  // overflow a page or push a mostly-empty one ahead of it.
  assert.match(css, /\.pg-item\s*\{\s*break-inside:\s*auto/,
    "items are being forced onto one page");

  // Backgrounds and borders carry the structure; Chrome drops them otherwise.
  assert.match(css, /print-color-adjust:\s*exact/, "tints and borders will not print");

  // Letter first, as specified.
  assert.match(css, /@page\s*\{[^}]*size:\s*Letter/i, "the page size is not Letter");
});

test("the on-screen toolbar never reaches the paper", () => {
  assert.match(readFileSync(CSS, "utf8"), /\.pg-noprint\s*\{\s*display:\s*none\s*!important/,
    "the print toolbar would be printed");
  assert.match(codeOf("src/components/print/print-toolbar.tsx"), /pg-noprint/,
    "the toolbar does not carry the no-print class");
});

test("Copy Link no longer reports a success it did not have", () => {
  const src = codeOf("src/components/preview-actions.tsx");
  const fn = /async function copyLink\(\)[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  assert.ok(fn, "copyLink is no longer an async function");
  assert.match(fn, /await navigator\.clipboard\.writeText/, "the clipboard write is not awaited");
  assert.match(fn, /catch/, "a rejected clipboard write is not caught");
  // The failure has to be visible, not merely caught.
  assert.match(src, /copyFailed &&/, "a blocked copy says nothing to the professional");
});
