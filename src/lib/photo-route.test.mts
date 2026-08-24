// Source gates for the upload route. The dangerous properties of a public
// bucket are all decided in this one file, so they are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/packets/[id]/photos/route.ts", "utf8");
const sql = readFileSync("supabase/migrations/0029_packet_photo_storage.sql", "utf8");
const code = route.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
// SQL COMMENTS STRIPPED. The migration explains at length why it grants no
// write policy and excludes SVG - and a scan of the raw text matches that
// rationale, failing forever on the words written to forbid the thing. Narrow
// the scan; never loosen the pattern.
const ddl = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

test("ownership is checked BEFORE the body is read", () => {
  const ownerAt = code.indexOf('.eq("user_id", session.userId)');
  const bodyAt = code.indexOf("formData()");
  assert.ok(ownerAt > 0 && bodyAt > 0, "route shape changed");
  assert.ok(ownerAt < bodyAt, "a stranger's 10MB upload is read before ownership is checked");
});

test("the stored type comes from the bytes, never the browser", () => {
  assert.match(code, /sniffImageType\(bytes\)/);
  // The client's own claims must not decide what is stored.
  assert.doesNotMatch(code, /file\.type/, "the route trusts the browser's Content-Type");
  assert.doesNotMatch(code, /file\.name/, "the route uses the uploader's filename");
});

test("the object name is random, and carries neither identity nor filename", () => {
  assert.match(code, /randomBytes\(32\)/, "the object name is not strongly random");
  const pathLine = code.split("\n").find((l) => l.includes("objectPath =")) ?? "";
  for (const leak of [/packetId/, /userId/, /file\.name/, /session\./]) {
    assert.doesNotMatch(pathLine, leak, `the object path leaks identity: ${leak}`);
  }
});

test("upserts are refused — a collision is a bug, not a retry", () => {
  assert.match(code, /upsert:\s*false/);
});

test("the bucket is public-read with no write grant to anon or authenticated", () => {
  assert.match(ddl, /'packet-photos',\s*true/);
  assert.match(ddl, /for select/);
  // Any insert/update/delete policy would be a client-side write path.
  assert.doesNotMatch(ddl, /for (insert|update|delete)/i, "the bucket grants a write policy");
  assert.doesNotMatch(ddl, /to (anon|authenticated)/i, "the bucket grants a role directly");
});

test("SVG is excluded at the bucket as well as in the route", () => {
  // Defence in depth: even a bypassed route cannot store one.
  assert.doesNotMatch(ddl, /svg/i);
  assert.match(ddl, /allowed_mime_types/);
});

test("v1 scope: no deletion, no reaper, no resize", () => {
  assert.doesNotMatch(code, /\.remove\(|delete/i, "the route deletes objects");
  assert.doesNotMatch(code, /sharp|resize|transform/i, "the route processes images");
});
