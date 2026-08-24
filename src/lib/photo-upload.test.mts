import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sniffImageType, ACCEPTED_PHOTO_TYPES, MAX_PHOTO_BYTES } from "./photo-upload.ts";
import { isCreatorUploaded, CREATOR_UPLOAD_PATH } from "./creator-media.ts";
import { buildMediaLedger } from "./media-ledger.ts";

const pad = (head: number[], n = 32) => Buffer.concat([Buffer.from(head), Buffer.alloc(n)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);

test("the four accepted formats are recognised from their bytes", () => {
  assert.equal(sniffImageType(JPEG)?.ext, "jpg");
  assert.equal(sniffImageType(PNG)?.ext, "png");
  assert.equal(sniffImageType(GIF)?.ext, "gif");
  assert.equal(sniffImageType(WEBP)?.ext, "webp");
});

test("SVG is refused — it is a script container on a public bucket", () => {
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null);
  assert.ok(!ACCEPTED_PHOTO_TYPES.some((t) => /svg/i.test(t.mime)), "svg reached the allowlist");
});

test("a file that merely CLAIMS to be an image is refused", () => {
  // The header and the extension are attacker-controlled; the bytes are not.
  assert.equal(sniffImageType(Buffer.from("<!doctype html><script>alert(1)</script>")), null);
  assert.equal(sniffImageType(Buffer.from("GIF but not really, just text here")), null);
});

test("RIFF alone is not WEBP", () => {
  // RIFF is also WAV and AVI. Accepting the first four bytes would store those.
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(16)]);
  assert.equal(sniffImageType(wav), null);
});

test("empty and truncated input is refused rather than guessed", () => {
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8])), null);   // too short to judge
});

test("the size ceiling matches the bucket's own limit", () => {
  const sql = readFileSync("supabase/migrations/0029_packet_photo_storage.sql", "utf8");
  assert.ok(sql.includes(String(MAX_PHOTO_BYTES)),
    `bucket limit and MAX_PHOTO_BYTES disagree (${MAX_PHOTO_BYTES})`);
});

// ------------------------------------------------------- the creator rule ---

const UPLOADED = `https://abc.supabase.co${CREATOR_UPLOAD_PATH}a1/a1b2c3d4.jpg`;

test("a URL under our bucket is creator-supplied; anything else is not", () => {
  assert.equal(isCreatorUploaded(UPLOADED), true);
  assert.equal(isCreatorUploaded("https://res.cloudinary.com/x/image/upload/v1/a.jpg"), false);
  assert.equal(isCreatorUploaded("https://example.com/photo.jpg"), false);
  assert.equal(isCreatorUploaded(""), false);
  assert.equal(isCreatorUploaded(null), false);
});

test("the rule is not fooled by the path appearing in a query string", () => {
  assert.equal(isCreatorUploaded(`https://evil.example.com/x?u=${CREATOR_UPLOAD_PATH}a/b.jpg`), false);
  // ...nor by http, nor by a bare prefix with no object after it.
  assert.equal(isCreatorUploaded(`http://abc.supabase.co${CREATOR_UPLOAD_PATH}a/b.jpg`), false);
  assert.equal(isCreatorUploaded(`https://abc.supabase.co${CREATOR_UPLOAD_PATH}`), false);
});

test("REGRESSION: an uploaded photo must not read as media the source forgot", () => {
  // This is the collision the rule exists to prevent. Before it, the next
  // finalize of ANY run on the packet would emit media_not_in_source - a
  // BLOCKING failure - because the creator used the product correctly.
  const source = "Alpha House\nhttps://cdn.example.com/alpha.jpg\n";
  const ledger = buildMediaLedger({
    source,
    stored: [
      { url: "https://cdn.example.com/alpha.jpg", itemId: "i1" },
      { url: UPLOADED, itemId: "i1" },
    ],
  });
  assert.deepEqual(ledger.failures.filter((f) => f.code === "media_not_in_source"), []);
  // ...and the source photo is still accounted for, so the rule did not simply
  // switch the check off.
  assert.equal(ledger.failures.length, 0, JSON.stringify(ledger.failures));
});

test("a pasted URL absent from the source is STILL reported", () => {
  // The rule is narrow: it exempts what we stored, not everything unexplained.
  const ledger = buildMediaLedger({
    source: "Alpha House\nhttps://cdn.example.com/alpha.jpg\n",
    stored: [
      { url: "https://cdn.example.com/alpha.jpg", itemId: "i1" },
      { url: "https://res.cloudinary.com/other/image/upload/v1/x.jpg", itemId: "i1" },
    ],
  });
  assert.equal(ledger.failures.filter((f) => f.code === "media_not_in_source").length, 1);
});
