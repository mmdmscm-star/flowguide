// DIRECT IMAGE UPLOAD, ON EVERY SURFACE THAT EDITS ITEM PHOTOS.
//
// The capability already existed everywhere except the Library; what was
// missing was a way to reach it. In the Sendset editor Upload only appeared
// after "+ Add" produced a blank URL row, so the common thing was two moves
// behind the uncommon one. In the Library it did not exist at all.
//
// The part worth guarding is not the button. It is WHICH ROUTE each surface
// uploads through, because that is the authorization decision — and the editor
// those surfaces share must not be the thing that makes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadCreatorImage } from "./image-upload-client.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped. These files explain themselves at length and
 *  legitimately NAME the things the code must not do — "place an object in the
 *  bucket" is the explanation, not a second storage mechanism. */
const codeOf = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const LEGACY = read("src/components/editor/legacy-packet-editor.tsx");
const SHARED = codeOf("src/components/editor/block-item-editor.tsx");
const LIB_WS = read("src/components/library/library-workspace.tsx");
const LIB_IMPORT = read("src/components/library/import-with-ai.tsx");
const BLOCK = read("src/components/editor/block-packet-editor.tsx");
const ROUTE = codeOf("src/app/api/library/images/route.ts");

// ---------------------------------------------------------------------------
// A — REACHABLE WITHOUT MAKING A BLANK ROW FIRST
// ---------------------------------------------------------------------------

test("the Sendset item's Photos HEADER offers Upload, not just + Add", () => {
  const header = LEGACY.slice(LEGACY.indexOf("uppercase tracking-wide\">Photos<"));
  const upload = header.indexOf("onUploadNewPhoto(item.id, f)");
  const addUrl = header.indexOf("onAddPhoto(item.id)");
  assert.ok(upload > -1, "the header has no direct upload");
  assert.ok(addUrl > -1, "the manual URL path was removed");
  assert.ok(upload < addUrl, "upload is not the first action offered");
  // It takes a file directly — no photo id, so no row has to exist yet.
  assert.match(LEGACY, /onUploadNewPhoto: \(itemId: string, file: File\) => void;/,
    "the header upload still needs a pre-created photo row");
});

test("CANCEL AND FAILURE LEAVE THE ITEM'S PHOTOS ALONE", () => {
  const fn = LEGACY.slice(LEGACY.indexOf("async function uploadNewPhoto("),
                          LEGACY.indexOf("function removePhoto("));
  // Cancel never calls the handler at all.
  assert.match(LEGACY, /if \(f\) onUploadNewPhoto\(item\.id, f\)/,
    "the handler can run without a file");
  // Failure returns before anything is appended or saved.
  const guard = fn.indexOf('if ("error" in res)');
  assert.ok(guard > -1, "the upload result is not checked");
  assert.ok(guard < fn.indexOf("setItems("), "photos are changed before the result is known");
  assert.match(fn.slice(guard, guard + 120), /return;/, "a failed upload falls through");
  assert.ok(fn.indexOf("setItems(") < fn.indexOf("debouncedSave("),
    "it saves before it has anything to save");
});

// ---------------------------------------------------------------------------
// B — WHO CHOOSES THE ROUTE
// ---------------------------------------------------------------------------

test("THE SHARED EDITOR DOES NOT OWN THE AUTHORIZATION CHOICE", () => {
  // It is handed the ability to upload, never the address.
  assert.ok(!/\/api\/library\/images|\/api\/packets\//.test(SHARED),
    "the shared item editor hard-codes an upload endpoint");
  assert.match(SHARED, /uploadImage\?: UploadImage;/, "it cannot be handed an uploader");
  assert.match(SHARED, /if \(!uploadImage\) return;/,
    "it assumes an uploader exists");
  // Absent, the Photos block is what it always was.
  assert.match(SHARED, /\{uploadImage && \(/, "Upload renders even with no way to upload");
});

test("LIBRARY SURFACES USE THE SESSION-SCOPED LIBRARY ROUTE", () => {
  for (const [name, src] of [["library-workspace", LIB_WS], ["import-with-ai", LIB_IMPORT]] as const) {
    const uses = [...src.matchAll(/uploadImage=\{\(f\) => uploadCreatorImage\("([^"]+)"/g)].map((m) => m[1]);
    assert.ok(uses.length > 0, `${name} passes no uploader`);
    for (const u of uses)
      assert.equal(u, "/api/library/images", `${name} uploads Library material through ${u}`);
  }
  // Both Library call sites in the workspace, not just one.
  assert.equal((LIB_WS.match(/uploadCreatorImage\("\/api\/library\/images"/g) ?? []).length, 2,
    "one of the workspace's two editors cannot upload");
});

test("A PACKET-BACKED EDITOR KEEPS THE STRONGER PACKET-OWNED ROUTE", () => {
  assert.match(BLOCK, /uploadCreatorImage\(`\/api\/packets\/\$\{packetId\}\/photos`, f\)/,
    "block-mode Sendset editing downgraded to the session-scoped route");
  assert.ok(!BLOCK.includes("/api/library/images"),
    "a packet surface uploads through the Library route");
  assert.match(LEGACY, /uploadCreatorImage\(`\/api\/packets\/\$\{packetId\}\/photos`/,
    "the legacy editor stopped using the packet-owned route");
});

// ---------------------------------------------------------------------------
// THE ROUTE ITSELF
// ---------------------------------------------------------------------------

test("the Library route stores bytes and nothing else", () => {
  assert.match(ROUTE, /const session = await getSession\(\);/, "it is not authenticated");
  assert.match(ROUTE, /storeCreatorImage\(supabase, Buffer\.from/,
    "it does not reuse the shared store, so validation can drift");
  // It must not write Library rows — attaching a URL is the ownership- and
  // revision-checked update path's job.
  assert.ok(!/library_items|updateLibraryItem|from\("library/.test(ROUTE),
    "the upload route writes Library content, bypassing the revision check");
  assert.ok(!/createClient|storage\.from|bucket/.test(ROUTE),
    "it reaches storage directly instead of through storeCreatorImage");
});

// ---------------------------------------------------------------------------
// THE CLIENT HELPER
// ---------------------------------------------------------------------------

test("the helper reports the server's own sentence when there is one", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: false, json: async () => ({ message: "That image is larger than 10MB. Try a smaller one." }),
    })) as unknown as typeof fetch;
    const bad = await uploadCreatorImage("/api/library/images", new File([], "x.png"));
    assert.deepEqual(bad, { error: "That image is larger than 10MB. Try a smaller one." });

    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ url: "https://x.test/a.png" }) })) as unknown as typeof fetch;
    assert.deepEqual(await uploadCreatorImage("/api/library/images", new File([], "x.png")),
      { url: "https://x.test/a.png" });

    // An ok response with no url is a failure, not a success with undefined.
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    assert.ok("error" in await uploadCreatorImage("/api/library/images", new File([], "x.png")));
  } finally {
    globalThis.fetch = orig;
  }
});
