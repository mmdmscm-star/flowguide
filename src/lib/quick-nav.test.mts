// Gates on the quick-navigation presentation preference (migration 0030).
//
// The behaviour that must not regress is mostly about DEFAULTS: a packet that
// says nothing, a column that is missing, a caller that forgets the prop — all
// three have to keep rendering the index, because the setting shipped after
// 62 packets already existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const GROUP = "src/components/section-group.tsx";
const CONTENTS = "src/components/section-contents.tsx";
const QUERIES = "src/lib/queries.ts";
const ROUTE = "src/app/api/packets/[id]/route.ts";
const EDITOR = "src/components/editor/legacy-packet-editor.tsx";
const MIGRATION = "supabase/migrations/0030_packet_show_quick_nav.sql";

test("OFF is opt-in: every unset path still renders the index", () => {
  const group = codeOf(GROUP);
  // The prop defaults to true, so a caller that forgets it behaves as before.
  assert.match(group, /showQuickNav = true/, "the prop does not default to on");

  // Both read paths use `!== false`, so null / undefined / missing column read
  // as ON. `=== true` would make a missing value hide the index.
  const q = codeOf(QUERIES);
  const reads = q.match(/showQuickNav: packet\.show_quick_nav !== false/g) ?? [];
  assert.equal(reads.length, 2, "expected the published path and the preview path to read it the same way");
  assert.doesNotMatch(q, /show_quick_nav === true/, "a missing value would hide the index");
});

test("the live view and the creator PREVIEW read the same preference", () => {
  for (const page of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"]) {
    assert.match(codeOf(page), /showQuickNav=\{packet\.showQuickNav !== false\}/,
      `${page} does not pass the preference through`);
  }
});

test("SECTIONCONTENTS IS UNTOUCHED, and still owns the single-item rule", () => {
  const contents = codeOf(CONTENTS);
  // The rule that a one-item section shows no index is a fact about the
  // content, and must not have migrated into the preference.
  assert.match(contents, /items\.length < 2/, "the single-item rule left SectionContents");
  assert.doesNotMatch(contents, /showQuickNav|show_quick_nav/,
    "the preference leaked into the navigation component");
});

test("the two rules stay in two homes", () => {
  // SectionGroup decides the preference; SectionContents decides the count.
  assert.match(codeOf(GROUP), /\{showQuickNav && <SectionContents/,
    "SectionGroup no longer gates on the preference");
  assert.doesNotMatch(codeOf(GROUP), /items\.length/,
    "SectionGroup duplicated the single-item rule");
});

test("the write path accepts a boolean and nothing else", () => {
  const route = codeOf(ROUTE);
  assert.match(route, /showQuickNav: "show_quick_nav"/, "the field is not in the allowlist");
  assert.match(route, /typeof body\.showQuickNav !== "boolean"/, "a non-boolean is not rejected");
});

test("ONE control, packet-level, defaulting to on", () => {
  const editor = codeOf(EDITOR);
  assert.match(editor, /Show quick navigation/, "the control is missing");
  assert.match(editor, /Display a clickable list of items at the top of sections with multiple items\./,
    "the helper text changed");
  // Exactly one checkbox for this — a per-section control was explicitly out.
  assert.equal((editor.match(/setShowQuickNav\(/g) ?? []).length, 2,
    "expected one setter and one call site, i.e. a single packet-level control");
  // Saved immediately, not behind the shared debounce timer.
  assert.match(editor, /savePacketFields\(\{ showQuickNav: next \}\)/,
    "the toggle is not saved immediately");
});

test("the BLOCK editor gets no control, because block mode has no index", () => {
  assert.doesNotMatch(codeOf("src/components/editor/block-packet-editor.tsx"), /showQuickNav/,
    "a control was added where it can have no effect");
  assert.doesNotMatch(codeOf("src/components/packet-block-body.tsx"), /SectionContents/,
    "block mode grew an index");
});

test("EMAIL AND PRINT ARE UNAFFECTED — neither has an index to hide", () => {
  for (const renderer of ["src/lib/email-render.ts", "src/components/print/print-packet.tsx"]) {
    const src = codeOf(renderer);
    assert.doesNotMatch(src, /showQuickNav/, `${renderer} started reading a live-view preference`);
    assert.doesNotMatch(src, /SectionContents/, `${renderer} has an index`);
  }
});

test("the migration keeps its warning, and the column stays presentation", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /boolean not null default true/, "the column shape changed");
  // The header must keep telling the next person not to reclassify it.
  assert.match(sql, /ingest_bump_packet_self/, "the content_rev warning was removed");
  assert.match(sql, /don't|do not/i, "the warning no longer warns");
});
