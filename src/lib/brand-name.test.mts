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
import { publishedBranch } from "./publish-lands-on-share.test.mts";

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
  // THE SHARE STEP'S OWN COPY, which the server shell above does not contain.
  // It was outside this list while it spoke only to someone who had navigated
  // to Preview deliberately; it now receives everyone who publishes, and it was
  // saying "your client can now see this packet" at the moment of success.
  "src/components/preview-actions.tsx",
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
  // THE RECIPIENT CARD NAMES THE PRODUCT WITHOUT BEING TITLED BY IT. Its title
  // is now the sender — "Ramona Maurer shared a Sendset with you" — so the product's
  // own name lives in the site name and in the line under it, which is where a
  // client should meet it: after the person they already know.
  const recipient = codeOf("src/lib/recipient-metadata.ts");
  assert.match(recipient, /siteName: "Sendset"/, "the recipient card's site name");
  assert.match(recipient, /RECIPIENT_DESCRIPTION = "View on Sendset\."/, "the recipient card");
  assert.match(recipient, /RECIPIENT_TITLE_ANONYMOUS = "A Sendset has been shared with you"/,
    "an unsigned Sendset still names the product");
  // THE SIGNATURE AT THE FOOT OF A SENDSET. It was the same sentence written
  // out in three files; the two WEB views now share one component, so the name
  // is asserted where it is actually written rather than three times over. The
  // printed copy keeps its own text-only tail: paper has no link to follow and
  // no reason to spend ink on a mark.
  assert.match(codeOf("src/components/sendset-signature.tsx"), /Made with Sendset\b/,
    "the recipient signature does not name the product");
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"])
    assert.match(codeOf(f), /<SendsetSignature \/>/, `${f} does not sign off as Sendset`);
  // ONE SENTENCE ACROSS EVERY RENDERER THAT CARRIES ONE. The printed copy says
  // the same four words as the web signature, text-only: no icon, because ink;
  // no link, because paper. Email carries no signature at all and is not
  // asserted here — a sender's own message is not a place for our mark.
  assert.match(codeOf("src/components/print/print-packet.tsx"), /Made with Sendset\b/,
    "the printed copy does not name the product");
  assert.ok(!/Powered by Sendset/.test(codeOf("src/components/print/print-packet.tsx")),
    "the printed tail still uses the superseded wording");
  assert.match(codeOf("src/app/api/auth/send-magic-link/route.ts"),
    /subject: "Sign in to Sendset"/, "the sign-in email subject");
});

test("the signature is MEANT TO BE SEEN, and it is a link", () => {
  // The line it replaced was `faint`, which on the default treatment is grey at
  // 40% opacity — a mark you notice only if you already knew it was there. The
  // point of the change was that a client can read it, so the token is asserted
  // rather than left to whoever edits this next. `subtle` is the same token the
  // rest of the page uses for supporting text, and measures 8.2:1 against the
  // page on the default treatment.
  const sig = codeOf("src/components/sendset-signature.tsx");
  assert.match(sig, /var\(--sg-subtle\)/, "the signature is drawn in a quieter token again");
  assert.ok(!/--sg-faint/.test(sig), "the signature went back to the washed-out token");
  // A LINK, to one place, and not a button.
  assert.match(sig, /href="https:\/\/sendset\.io"/, "the signature leads nowhere");
  assert.ok(!/bg-accent|sg-btn|rounded-full|font-semibold/.test(sig),
    "the signature acquired button styling");
  assert.ok(!/Create your own|Try Sendset|Get started/i.test(sig),
    "the signature became an advertisement");
  // NOT ICON-ONLY: words a screen reader can read, and a decorative mark.
  assert.match(sig, /alt=""/, "the mark is described, so the link is announced twice");
  assert.match(sig, /Made with Sendset/, "the link has no text of its own");
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
  // THE CONFIRMATION LIVES WHERE PUBLISHING NOW LANDS. It used to be a dialog
  // in the editor; publishing routes into the share step instead, so there is
  // one post-publish experience rather than two. What has to stay true is that
  // the sentence a professional reads at the moment of success calls the thing
  // a Sendset — wherever that sentence is.
  // THE BRANCH, NOT THE SENTENCE — see publish-lands-on-share.test.mts, which
  // owns this rule and exports the branch it applies to. Pinned here as one
  // literal, it failed the first time the confirmation was rewritten while
  // still saying "Sendset" in every line of it.
  const branch = publishedBranch(codeOf("src/components/preview-actions.tsx"));
  assert.match(branch, /\bSendset\b/, "the publish confirmation");
  assert.doesNotMatch(branch.replace(/packetId/g, ""), /packet/i,
    "the publish confirmation calls a Sendset a packet");
  assert.doesNotMatch(editor, /Your Sendset is live/,
    "the editor still has its own publish dialog, so there are two of them again");
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
