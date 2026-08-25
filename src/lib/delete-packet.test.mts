import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteConfirmMessage } from "./delete-packet.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ---------------------------------------------------------------------------
// THE CONFIRMATION IDENTIFIES THE PACKET
//
// This is the whole feature. A creator opens a draft, decides they don't want
// it, and needs to know the thing about to be deleted is the thing they were
// looking at — which is exactly what several identically-untitled rows on the
// dashboard cannot tell them.
// ---------------------------------------------------------------------------

test("a titled FlowGuide is named, with the client when there is one", () => {
  assert.match(deleteConfirmMessage({ title: "Possible Communities" }),
    /^Delete "Possible Communities"\?/);
  assert.match(deleteConfirmMessage({ title: "Possible Communities", clientName: "the Alvarez family" }),
    /^Delete "Possible Communities" \(for the Alvarez family\)\?/);
});

test("AN UNTITLED FLOWGUIDE SAYS SO — it is never called by a made-up name", () => {
  const m = deleteConfirmMessage({ title: "", clientName: "the Alvarez family" });
  assert.match(m, /^Delete this untitled FlowGuide \(for the Alvarez family\)\?/);
  // Whitespace is not a title.
  assert.match(deleteConfirmMessage({ title: "   " }), /untitled FlowGuide/);
  // And it must not invent one, the way the old dashboard copy did.
  assert.doesNotMatch(m, /Untitled Packet/);
});

test("with NOTHING to identify it, say that plainly and give the date", () => {
  const m = deleteConfirmMessage({ title: "", clientName: "", createdAt: "2026-08-12T09:30:00Z" });
  assert.match(m, /It has no title and no client name\. Created 12 August 2026\./);
});

test("the date is read off the stored string, not through a timezone", () => {
  // `new Date("2026-08-12")` is UTC midnight — the 11th in every western
  // timezone. A draft created on the 12th must never offer to delete one
  // "created 11 August".
  assert.match(deleteConfirmMessage({ createdAt: "2026-08-12" }), /Created 12 August 2026/);
  assert.match(deleteConfirmMessage({ createdAt: "2026-01-01T00:00:00Z" }), /Created 1 January 2026/);
  assert.match(deleteConfirmMessage({ createdAt: "2026-12-31T23:59:59Z" }), /Created 31 December 2026/);
});

test("a missing or unusable date degrades to the sentence without it", () => {
  for (const bad of [undefined, null, "", "not a date", "2026-13-45"]) {
    const m = deleteConfirmMessage({ title: "", clientName: "", createdAt: bad });
    assert.match(m, /It has no title and no client name\./);
    assert.doesNotMatch(m, /Created/, `expected no date clause for ${JSON.stringify(bad)}`);
  }
});

test("the 'nothing to identify it' line appears ONLY when that is true", () => {
  assert.doesNotMatch(deleteConfirmMessage({ title: "X", createdAt: "2026-08-12" }), /no title/);
  assert.doesNotMatch(deleteConfirmMessage({ clientName: "Y", createdAt: "2026-08-12" }), /no title/);
});

test("PUBLISHED carries the broken-link warning; a draft does not", () => {
  const published = deleteConfirmMessage({ title: "X", status: "published" });
  assert.match(published, /Anyone you shared the link with will no longer be able to open it\./);
  assert.doesNotMatch(deleteConfirmMessage({ title: "X", status: "draft" }), /shared the link/);
});

test("every message ends by saying it cannot be undone", () => {
  for (const p of [{}, { title: "X" }, { title: "X", status: "published" },
                   { title: "", clientName: "", createdAt: "2026-08-12" }]) {
    assert.match(deleteConfirmMessage(p), /This cannot be undone\.$/);
  }
});

// ---------------------------------------------------------------------------
// ONE MECHANISM
// ---------------------------------------------------------------------------

test("EVERY caller goes through the shared request helper", () => {
  for (const caller of [
    "src/components/editor/delete-packet-action.tsx",
    "src/components/dashboard/dashboard-workspace.tsx",
  ]) {
    const src = codeOf(caller);
    assert.match(src, /deletePacketRequest\(/, `${caller} does not use the shared helper`);
    // A second hand-rolled DELETE would be a second mechanism.
    assert.doesNotMatch(src, /method:\s*"DELETE"/, `${caller} rolls its own delete request`);
  }
});

test("and every caller uses the shared confirmation wording", () => {
  for (const caller of [
    "src/components/editor/delete-packet-action.tsx",
    "src/components/dashboard/dashboard-workspace.tsx",
  ]) {
    assert.match(codeOf(caller), /deleteConfirmMessage\(/, `${caller} writes its own confirmation`);
  }
});

test("A FAILED DELETE IS VISIBLE, and does not navigate away", () => {
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  // The push must be inside the try, after the await — never in a finally.
  assert.match(action, /await deletePacketRequest\(packetId\);[\s\S]{0,120}router\.push\("\/dashboard"\)/,
    "navigation is not gated on the delete succeeding");
  assert.match(action, /catch[\s\S]{0,160}setError\(/, "a failed delete says nothing");
  assert.doesNotMatch(action, /finally[\s\S]{0,80}router\.push/, "it navigates away even on failure");

  const dash = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.match(dash, /catch[\s\S]{0,160}setDeleteError\(/, "the dashboard still fails silently");
  assert.match(dash, /\{deleteError &&/, "the dashboard error is never rendered");
});

test("the helper throws rather than returning a flag a caller can ignore", () => {
  const lib = codeOf("src/lib/delete-packet.ts");
  assert.match(lib, /if \(!res\.ok\)[\s\S]{0,200}throw new Error/, "a non-OK response is not thrown");
  assert.match(lib, /catch[\s\S]{0,120}throw new Error/, "a network failure is not thrown");
});

// ---------------------------------------------------------------------------
// PLACEMENT AND SCOPE
// ---------------------------------------------------------------------------

test("BOTH editors mount the one component", () => {
  for (const editor of [
    "src/components/editor/legacy-packet-editor.tsx",
    "src/components/editor/block-packet-editor.tsx",
  ]) {
    assert.match(codeOf(editor), /<DeletePacketAction/, `${editor} cannot delete its own FlowGuide`);
  }
});

test("the destructive action is NOT in the bar that holds Publish", () => {
  const legacy = codeOf("src/components/editor/legacy-packet-editor.tsx");
  const bar = legacy.indexOf('className="fixed bottom-0');
  const del = legacy.indexOf("<DeletePacketAction");
  assert.ok(del > -1 && bar > -1, "expected both the action and the action bar");
  assert.ok(del < bar, "the delete action was moved into the fixed action bar beside Publish");
  // And it is a text link, not a filled button competing with the primary action.
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  assert.doesNotMatch(action, /bg-red-[56]00|bg-accent/, "the delete action is styled as a primary button");
});

test("no lifecycle system crept in", () => {
  const lib = codeOf("src/lib/delete-packet.ts");
  const action = codeOf("src/components/editor/delete-packet-action.tsx");
  // \bundo\b, not /undo/: the required copy says "cannot be undone", and a
  // pattern that matches its own mandated wording forbids the feature by
  // forbidding the sentence that promises the feature does not exist.
  for (const forbidden of [/archive/i, /\btrash\b/i, /soft.?delete/i, /\bundo\b/i, /\brestore\b/i, /\bbulk\b/i]) {
    assert.doesNotMatch(lib + action, forbidden, `scope crept: ${forbidden}`);
  }
});
