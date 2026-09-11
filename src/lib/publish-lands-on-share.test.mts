// ONE POST-PUBLISH EXPERIENCE.
//
// Publishing from the editor's bottom bar opened a dialog holding the link and
// nothing else. Publishing from Preview landed on a page with the client
// message already written, the email version, Print/Save as PDF, and a way back
// to the editor. Same action, same endpoint, two outcomes — decided by which
// button someone happened to press, with the weaker one sitting in the bar on
// the surface where all the work happens.
//
// The editor now hands over to the share step. These hold the two halves of
// that: publishing goes there, and the other one does not come back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const EDITOR = "src/components/editor/legacy-packet-editor.tsx";
const SHARE = "src/components/preview-actions.tsx";

/** `publishPacket` from its opening to the next declaration. */
function publishHandler(src: string) {
  const from = src.indexOf("async function publishPacket");
  assert.ok(from >= 0, "the editor no longer has a publish handler");
  const next = src.indexOf("async function handleUnpublish", from);
  return src.slice(from, next > from ? next : undefined);
}

test("PUBLISHING HANDS OVER TO THE SHARE STEP", () => {
  const handler = publishHandler(codeOf(EDITOR));
  assert.match(handler, /router\.push\(`\/preview\/\$\{packetId\}`\)/,
    "a successful publish does not take the professional to the share step");
  // And it happens on SUCCESS, not before the request settles.
  const sendAt = handler.indexOf("/publish");
  const goAt = handler.indexOf("router.push(`/preview/");
  assert.ok(sendAt >= 0 && goAt > sendAt,
    "the editor navigates away before knowing whether publishing worked");
});

test("...AND THE SECOND EXPERIENCE IS GONE, not merely unused", () => {
  const editor = codeOf(EDITOR);
  assert.doesNotMatch(editor, /showPublishModal/,
    "the editor's own publish dialog is still there, so there are two again");
  assert.doesNotMatch(editor, /Your Sendset is live/,
    "the dialog's copy survived, which means the dialog did");
});

test("THE SHARE STEP STILL CARRIES WHAT MADE IT WORTH LANDING ON", () => {
  // The whole reason for routing here. If these leave, the convergence has
  // quietly become the weaker experience for everyone instead of the stronger
  // one — which is worse than the fork it replaced.
  const share = codeOf(SHARE);
  for (const [what, re] of [
    // THE JSX, NOT THE IMPORT. Matching the bare name passed against a file
    // that still imported the panel but no longer rendered it.
    ["the prefilled client message", /<ClientMessagePanel/],
    ["the email version", /<EmailVersionPanel/],
    ["a way back to the editor", /\/edit\/\$\{packetId\}/],
  ] as Array<[string, RegExp]>)
    assert.match(share, re, `the share step no longer offers ${what}`);
  // The two copy actions live in the panel this page mounts, not in this file —
  // asserting them here matched only a COMMENT about them, which comment
  // stripping then removed. Check them where they are rendered.
  const message = codeOf("src/components/client-message-panel.tsx");
  assert.match(message, /Copy message/, "the prefilled message cannot be copied");
  assert.match(message, /Copy link only/, "there is no way to take just the link");
});

/** The branch rendered once publishing has succeeded, from its guard to the
 *  draft branch's `return`. */
export function publishedBranch(src: string) {
  const from = src.indexOf('if (status === "published")');
  assert.ok(from >= 0, "the share step no longer has a published state");
  const to = src.indexOf("\n  return (", from);
  return src.slice(from, to > from ? to : undefined);
}

test("IT READS AS A SENDSET AT THE MOMENT OF SUCCESS", () => {
  // This surface used to be reached deliberately and was outside the brand
  // guard. It now receives everyone who publishes.
  //
  // THE PROPERTY, NOT ONE SENTENCE. This pinned the literal "can now see this
  // Sendset", which is a proxy for the rule and not the rule: a visual pass
  // rewrote the confirmation into a heading and a lede that both say Sendset,
  // and the proxy failed while the rule held. So the whole published branch is
  // checked instead — every word of it, which is more than the one line was.
  const branch = publishedBranch(codeOf(SHARE));
  assert.match(branch, /\bSendset\b/,
    "the moment of success never names what was published");
  // `packetId` is the internal identifier and is allowed; prose is not.
  assert.doesNotMatch(branch.replace(/packetId/g, ""), /packet/i,
    "the success copy still calls a Sendset a packet");
  // And it must actually say the state was reached, not merely offer sharing.
  assert.match(branch, /Published/, "nothing confirms that publishing worked");
});
