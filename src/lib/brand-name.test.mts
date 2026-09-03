// THE NAME, ON THE SURFACES A PERSON ACTUALLY SEES.
//
// One word does both jobs:
//
//   Sendset    the product — what the sign-in page is headed, what the footer
//              is powered by, and what speaks in the first person when
//              something goes wrong: "Sendset could not read that file."
//              It is ALSO one communication object: "this Sendset".
//   Sendsets   more than one of those objects: "My Sendsets".
//
// Because product and object share a word, most of what this file checks is
// number: many take the plural, one does not, and a determiner in front of
// "Sendsets" is how that distinction dies.
//
// Deliberately not policed: comments, flowguide_session, FLOWGUIDE_*, the cron
// job, the packet tables, /p/[slug], and FlowGuideTray. So these tests read
// CODE with comments removed, and name the internal identifier allowed to live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "")).join("\n");

const SURFACES = [
  "src/app/page.tsx",
  "src/app/login/page.tsx",
  "src/app/layout.tsx",
  "src/app/p/[slug]/page.tsx",
  "src/app/p/[slug]/not-found.tsx",
  "src/app/preview/[id]/page.tsx",
  "src/lib/recipient-metadata.ts",
  "src/components/print/print-packet.tsx",
  "src/components/nav/creator-nav.tsx",
  "src/components/dashboard/dashboard-workspace.tsx",
  "src/components/editor/legacy-packet-editor.tsx",
  "src/components/library/library-workspace.tsx",
  "src/components/settings/profile-settings.tsx",
  "src/components/new/new-packet-workspace.tsx",
  "src/app/api/auth/send-magic-link/route.ts",
  "src/lib/email-render.ts",
  "src/lib/review-units.ts",
  "src/lib/text-file-import.ts",
  "src/lib/delete-packet.ts",
  "src/lib/library-copy-failure.ts",
];

/** The one old-brand identifier that is internal and stays. */
const ALLOWED = /FlowGuideTray/g;

test("EVERY EARLIER NAME IS GONE from the surfaces a person sees", () => {
  // Two rebrands have passed through this code. Both old names are failures.
  for (const f of SURFACES) {
    const left = codeOf(f).replace(ALLOWED, "");
    for (const dead of ["FlowGuide", "GuideLink"])
      assert.ok(!left.includes(dead),
        `${f} still shows "${dead}": ${left.split("\n").find((l) => l.includes(dead))?.trim()}`);
  }
});

test("the /new copy does not say the name twice", () => {
  // Collapsing a two-word scheme into one word produced "Sendset will shape it
  // into a Sendset". That was a retargeting defect, not a standing rule about
  // English, so what is pinned here is the corrected line rather than a global
  // ban on repeating the name.
  assert.match(codeOf("src/components/new/new-packet-workspace.tsx"),
    /Sendset will shape it into a draft you can review, refine, and send\./,
    "the /new intro copy changed");
});

test("the product names itself where the product is meant", () => {
  const layout = codeOf("src/app/layout.tsx");
  assert.match(layout, /title: "Sendset"/, "the page title");
  assert.match(layout, /siteName: "Sendset"/, "the OG site name");
  assert.match(codeOf("src/lib/recipient-metadata.ts"),
    /RECIPIENT_TITLE = "Sendset"/, "the recipient card");
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx",
                   "src/components/print/print-packet.tsx"])
    assert.match(codeOf(f), /Powered by Sendset\b/, `${f} does not name the product`);
  assert.match(codeOf("src/app/api/auth/send-magic-link/route.ts"),
    /subject: "Sign in to Sendset"/, "the sign-in email subject");
});

test("MANY take the plural, ONE does not", () => {
  const nav = codeOf("src/components/nav/creator-nav.tsx");
  assert.match(nav, /label: "My Sendsets"/, "the dashboard lists many");
  assert.match(nav, /label: "New Sendset"/, "creating makes exactly one");

  const dash = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.match(dash, /No Sendsets yet/, "the empty heading counts none of many");
  assert.match(dash, /Search your Sendsets/, "the search box");
  assert.match(dash, /Create your first Sendset\b/, "the first one is one");

  const editor = codeOf("src/components/editor/legacy-packet-editor.tsx");
  assert.match(editor, /Sendset name/, "the private title field");
  assert.match(editor, /Your Sendset is live!/, "the publish confirmation");
  // A determiner in front of the plural is the way this goes wrong.
  for (const f of SURFACES)
    for (const wrong of [/\bthis Sendsets\b/, /\ba Sendsets\b/, /\bNew Sendsets\b/,
                         /\bevery Sendsets\b/, /\bAny Sendsets\b/])
      assert.ok(!wrong.test(codeOf(f)), `${f} pluralises a single object: ${wrong}`);
});

test("A SENDSET IS NOT A URL — it renders many ways", () => {
  // The canonical communication object: web, email, message, print, PDF, a QR
  // destination. Copy must not shrink it to the link that happens to reach it.
  const landing = codeOf("src/app/page.tsx");
  for (const shrink of [/a Sendset is (just |simply |merely )?a link/i, /just a link/i,
                        /nothing but a link/i])
    assert.ok(!shrink.test(landing), `the landing page reduces the object to a URL: ${shrink}`);
  assert.match(codeOf("src/app/layout.tsx"),
    /send it by link, email, message, or print/,
    "the delivery methods stopped being plural");
});

test("metadataBase is the canonical domain", () => {
  const layout = codeOf("src/app/layout.tsx");
  assert.match(layout, /metadataBase: new URL\("https:\/\/sendset\.io"\)/,
    "metadataBase is not the canonical apex domain");
  assert.doesNotMatch(layout, /vercel\.app|guidelinks\.io|flowguide/i,
    "a stale host is hard-coded as the metadata base");
  assert.doesNotMatch(layout, /metadataBase: new URL\("[^"]*\/"\)/,
    "metadataBase has a trailing slash");
});

test("the internal names this pass deliberately did NOT rename", () => {
  assert.match(codeOf("src/lib/auth.ts"), /SESSION_COOKIE = "flowguide_session"/,
    "the session cookie was renamed — every signed-in person would be logged out");
  assert.match(codeOf("src/components/library/flowguide-tray.tsx"), /export function FlowGuideTray/,
    "an internal component was renamed by a copy pass");
  assert.match(codeOf("src/app/api/auth/send-magic-link/route.ts"), /magic_links/,
    "a table name changed");
});
