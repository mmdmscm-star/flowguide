// Source gates for profile image upload. The security-critical decisions are
// shared with the packet-photo route; these pin that they STAY shared, and that
// the snapshot behaviour this feature depends on is not quietly altered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/profile/images/route.ts", "utf8");
const packetRoute = readFileSync("src/app/api/packets/[id]/photos/route.ts", "utf8");
const helper = readFileSync("src/lib/photo-upload.ts", "utf8");
const field = readFileSync("src/components/editor/image-upload-field.tsx", "utf8");
const editor = readFileSync("src/components/editor/legacy-packet-editor.tsx", "utf8");
const publish = readFileSync("src/app/api/packets/[id]/publish/route.ts", "utf8");
const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("both upload routes share ONE implementation of the storage rules", () => {
  // Two copies of the path-randomness or the type sniffing is two places for
  // one of them to drift.
  for (const [name, src] of [["profile", route], ["packet", packetRoute]] as const) {
    assert.match(src, /storeCreatorImage/, `${name} route does not use the shared helper`);
    assert.doesNotMatch(strip(src), /randomBytes/, `${name} route rolls its own object name`);
    assert.doesNotMatch(strip(src), /sniffImageType/, `${name} route rolls its own type check`);
  }
  assert.match(helper, /randomBytes\(32\)/);
  assert.match(helper, /upsert:\s*false/);
});

test("the profile route's ownership check is the session, and it is present", () => {
  assert.match(route, /const session = await getSession\(\)/);
  assert.match(route, /if \(!session\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/);
  // There is no packet here, so there must be no packet lookup pretending to be one.
  assert.doesNotMatch(strip(route), /from\("packets"\)/);
});

test("the route stores bytes and does NOT write the profile", () => {
  // Which field the URL lands in belongs to the existing save path.
  assert.doesNotMatch(strip(route), /professional_profiles|logo_url|headshot_url/,
    "the upload route also writes the profile");
});

test("all four identity fields accept upload AND still accept a pasted URL", () => {
  assert.equal((editor.match(/<ImageUploadField/g) ?? []).length, 4,
    "expected profile logo + headshot and custom logo + headshot");
  // The url box is still there inside the shared field.
  assert.match(field, /type="url"/);
  assert.match(field, /onChange=\{\(e\) => onChange\(e\.target\.value\)\}/);
});

test("the field uploads but does not decide where the URL goes", () => {
  assert.match(field, /fetch\("\/api\/profile\/images"/);
  assert.doesNotMatch(strip(field), /logoUrl|headshotUrl|professional_profiles/,
    "the shared field knows which field it fills");
});

test("SNAPSHOT: publishing freezes the CURRENT profile into the packet", () => {
  // This is what stops an already-published FlowGuide changing when the
  // professional later updates their logo. If this stops being a snapshot, the
  // upload feature silently starts rewriting delivered packets.
  assert.match(publish, /professional_snapshot: professionalSnapshot/);
  assert.match(publish, /from\("professional_profiles"\)[\s\S]{0,200}logo_url, headshot_url/);
  // ...and the recipient read path prefers the snapshot over the live profile.
  const queries = readFileSync("src/lib/queries.ts", "utf8");
  assert.match(queries, /snapshot\.logoUrl \|\| ""/);
  assert.match(queries, /logo_url: snapshot\.logoUrl/);
});

test("v1 scope: no cropping, no cleanup of replaced images, no retroactive updates", () => {
  const all = route + field + helper;
  for (const banned of [/crop/i, /sharp|resize/i, /\.remove\(/, /retroactive/i]) {
    assert.doesNotMatch(strip(all), banned, `scope broadened: ${banned}`);
  }
});
