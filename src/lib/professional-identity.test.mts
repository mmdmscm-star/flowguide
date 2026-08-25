import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { identityGap, isIdentityReady, IDENTITY_GAP_MESSAGE } from "./professional-identity.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ---------------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------------

test("a name, and at least one way to reply", () => {
  assert.equal(identityGap({ name: "Dana", email: "d@example.com" }), null);
  assert.equal(identityGap({ name: "Dana", phone: "(206) 555-0100" }), null);
  assert.equal(identityGap({ name: "Dana", email: "d@example.com", phone: "555" }), null);
  assert.ok(isIdentityReady({ name: "Dana", phone: "555" }));
});

test("no name is the first gap; no way to reply is the second", () => {
  assert.equal(identityGap({}), "no_profile");
  assert.equal(identityGap({ email: "d@example.com" }), "no_profile", "a contact without a name is still nameless");
  assert.equal(identityGap({ name: "Dana" }), "no_contact");
});

test("whitespace is not a value", () => {
  assert.equal(identityGap({ name: "   ", email: "d@example.com" }), "no_profile");
  assert.equal(identityGap({ name: "Dana", email: "  ", phone: "\t" }), "no_contact");
});

test("NO CONTACT AT ALL is ready — that is identity_mode 'none', not an omission", () => {
  // The publish route passes null for a packet that deliberately carries no
  // professional. Absence of a contact and an incomplete contact are different
  // answers, and collapsing them would either block that mode or excuse a
  // half-filled profile.
  assert.equal(identityGap(null), null);
  assert.equal(identityGap(undefined), null);
});

test("the gap values ARE the publish route's error codes", () => {
  assert.deepEqual(Object.keys(IDENTITY_GAP_MESSAGE).sort(), ["no_contact", "no_profile"]);
  assert.equal(IDENTITY_GAP_MESSAGE.no_profile, "No professional contact information");
  assert.equal(IDENTITY_GAP_MESSAGE.no_contact, "No email or phone in professional contact");
});

// ---------------------------------------------------------------------------
// ONE SOURCE OF TRUTH — the point of the whole exercise
// ---------------------------------------------------------------------------

test("PUBLISH asks the shared rule rather than carrying its own copy", () => {
  const src = codeOf("src/app/api/packets/[id]/publish/route.ts");
  assert.match(src, /identityGap\(contact\)/, "publish no longer uses the shared rule");
  // The old inline checks must be gone, or there are two rules again.
  assert.doesNotMatch(src, /!contact\.name\?\.trim\(\)/, "publish still has its own name check");
  assert.doesNotMatch(src, /!contact\.email\?\.trim\(\) && !contact\.phone\?\.trim\(\)/,
    "publish still has its own contact check");
});

test("the DASHBOARD prompt asks the same rule, not a 'has a name' guess", () => {
  const shell = codeOf("src/app/dashboard/page.tsx");
  assert.match(shell, /identityGap\(/, "the dashboard invents its own readiness rule");
  assert.match(shell, /IDENTITY_GAP_PROMPT\[gap\]/, "the prompt does not use the shared copy");
  // The prompt must NOT sit behind the workspace's client loading gate, or a new
  // professional meets a spinner where the guidance should be.
  assert.match(shell, /<DashboardWorkspace/, "the shell no longer renders the workspace");
  const workspace = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.doesNotMatch(workspace, /profile\?\.name\s*&&/, "the dashboard re-derives readiness locally");
});

test("SETTINGS asks the same rule too", () => {
  assert.match(codeOf("src/components/settings/profile-settings.tsx"), /identityGap\(profile\)/,
    "settings invents its own readiness rule");
});

// ---------------------------------------------------------------------------
// ONE FORM
// ---------------------------------------------------------------------------

test("there is exactly ONE professional profile form", () => {
  const shared = "src/components/editor/professional-profile-fields.tsx";
  const fields = codeOf(shared);
  for (const f of ["name", "businessName", "email", "phone", "footerLabel",
                   "logoUrl", "headshotUrl", "websiteUrl", "links"]) {
    assert.ok(fields.includes(`value.${f}`), `the shared form is missing ${f}`);
  }

  // The legacy editor must RENDER it, not re-implement it.
  const legacy = codeOf("src/components/editor/legacy-packet-editor.tsx");
  assert.match(legacy, /<ProfessionalProfileFields/, "the legacy editor no longer uses the shared form");
  assert.doesNotMatch(legacy, /placeholder="Footer label \(e\.g\. Your Advisor\)"/,
    "the legacy editor still has its own copy of the profile fields");

  // Settings renders the same component rather than a second form.
  assert.match(codeOf("src/components/settings/profile-settings.tsx"), /<ProfessionalProfileFields/,
    "settings has its own form");
});

test("the BLOCK editor can reach identity — via the shared form, not a second one", () => {
  const block = codeOf("src/components/editor/block-packet-editor.tsx");
  assert.match(block, /<CreatorNav/, "the block editor still has no route to the professional's details");
  assert.doesNotMatch(block, /ProfessionalProfileFields|api\/profile/,
    "the block editor grew its own profile form");
});

test("the nav actually offers it", () => {
  const nav = codeOf("src/components/nav/creator-nav.tsx");
  assert.match(nav, /href:\s*"\/settings"/, "settings is not reachable from the nav");
});

test("the profile image upload path is unchanged and shared", () => {
  const fields = codeOf("src/components/editor/professional-profile-fields.tsx");
  assert.match(fields, /<ImageUploadField/, "the upload field was dropped from the profile form");
  // Both logo and headshot, as before.
  assert.equal((fields.match(/<ImageUploadField/g) ?? []).length, 2,
    "expected exactly the logo and headshot upload fields");
});

test("PER-PACKET IDENTITY SEMANTICS ARE UNTOUCHED", () => {
  const legacy = codeOf("src/components/editor/legacy-packet-editor.tsx");
  // The custom identity is a packet-owned peer of the account profile and must
  // still save to the PACKET, never to /api/profile.
  assert.match(legacy, /patchCustomIdentity/, "the per-packet custom identity was removed");
  assert.match(legacy, /identityMode === "custom"/, "the custom identity branch was removed");
  assert.match(legacy, /identityMode === "default"/, "the default-profile branch was removed");

  const publish = codeOf("src/app/api/packets/[id]/publish/route.ts");
  for (const mode of [/mode === "none"/, /mode === "custom"/]) {
    assert.match(publish, mode, `publish lost an identity mode: ${mode}`);
  }
  // skipProfileCheck must still publish with an empty snapshot, unchanged.
  assert.match(publish, /skipProfileCheck \? \{\} :/, "skip-profile publishing behaviour changed");
});
