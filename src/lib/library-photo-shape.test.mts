// The shape mismatch that made Library editing silently impossible.
//
// PRODUCTION DEFECT, 2026-08-19. The model's contract for an extracted item is
// `photos: string[]` (ingest-validate.ts). The canonical ItemContentPayload
// shape is `{url}[]`. Nothing converted between them, so an AI-imported Library
// entry was stored with bare strings, read back as [{url: undefined}], and the
// editor's `p.url.trim()` threw INSIDE the click handler — no request, no error,
// a Save button that did nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItemContent } from "./item-content.ts";
import { snapshotToItem, heroPhoto, photoUrls } from "./library-adapter.ts";
import { diffItemContent } from "./library.ts";

const IMPORTED = { photos: ["https://a.example/1.jpg", "https://b.example/2.jpg"] };

test("normalising coerces the model's bare strings to the canonical shape", () => {
  assert.deepEqual(normalizeItemContent(IMPORTED).photos,
    [{ url: "https://a.example/1.jpg" }, { url: "https://b.example/2.jpg" }]);
});

test("and leaves the canonical shape untouched", () => {
  assert.deepEqual(normalizeItemContent({ photos: [{ url: "https://a.example/1.jpg" }] }).photos,
    [{ url: "https://a.example/1.jpg" }]);
});

test("mixed and malformed entries are dropped, never turned into undefined urls", () => {
  const out = normalizeItemContent({ photos: ["https://a.example/1.jpg", { url: "https://b.example/2.jpg" }, {}, null, 7, "  "] });
  assert.deepEqual(out.photos, [{ url: "https://a.example/1.jpg" }, { url: "https://b.example/2.jpg" }]);
});

test("an absent photos key still means 'leave unchanged'", () => {
  assert.equal(normalizeItemContent({ title: "x" }).photos, undefined);
  assert.deepEqual(normalizeItemContent({ photos: [] }).photos, []);
});

test("reading an already-stored imported entry does not produce undefined urls", () => {
  // This is the exact value that reached the editor and made Save throw.
  const item = snapshotToItem({ id: "x", revision: 1, updatedAt: "", ...IMPORTED });
  assert.deepEqual(item.photos, ["https://a.example/1.jpg", "https://b.example/2.jpg"]);
  assert.ok(item.photos!.every((u) => typeof u === "string"));
});

test("the list thumbnail resolves for an imported entry", () => {
  assert.equal(heroPhoto({ id: "x", revision: 1, updatedAt: "", ...IMPORTED }), "https://a.example/1.jpg");
});

test("photoUrls tolerates both shapes and rejects everything else", () => {
  assert.deepEqual(photoUrls({ photos: ["a", { url: "b" }, {}, null, ""] }), ["a", "b"]);
  assert.deepEqual(photoUrls({}), []);
  assert.deepEqual(photoUrls({ photos: "not an array" }), []);
});

test("the save-back diff sees a removal even when the ancestor stored strings", () => {
  // Reading a string photo as "" made every photo compare equal, so a genuine
  // removal looked like no change and the safeguard never fired.
  const d = diffItemContent(
    { photos: ["https://a.example/1.jpg", "https://b.example/2.jpg"] } as never,
    { photos: [{ url: "https://a.example/1.jpg" }] } as never);
  assert.equal(d.hasRemovals, true);
  const photos = d.fields.find((f) => f.field === "photos");
  assert.deepEqual(photos?.removed, ["https://b.example/2.jpg"]);
});

// ---------------------------------------------------------------------------
// The class fix: a Save that throws must never again be silent.
// ---------------------------------------------------------------------------
test("the item editor surfaces a thrown save instead of doing nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..",
    "components/editor/block-item-editor.tsx"), "utf8");

  const handler = src.slice(src.indexOf("async function handleSave()"), src.indexOf("async function doSave()"));
  assert.match(handler, /try \{/, "the save must be wrapped");
  assert.match(handler, /catch/, "and its failure caught");
  assert.match(handler, /setError\(/,
    "a thrown handler that shows nothing is indistinguishable from a dead button");
  assert.doesNotMatch(src, /\bp\.url\.trim\(\)/,
    "no unguarded .trim() on a value whose shape comes from storage");
});
