// THE PRIVATE NOTE MUST NOT REACH A RECIPIENT.
//
// These are source invariants, not behaviour tests: they exist so that a future
// change which re-opens this hole fails the suite instead of production. The
// hole was not a rendering bug — ItemCard is a "use client" component, so the
// item it receives is serialized into the RSC payload embedded in the HTML, and
// a note would have been readable in view-source even with the JSX removed.
// That is why the assertions below are about DATA, not markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p)) acc.push(p);
  }
  return acc;
}
const files = walk("src");

// The ONLY places allowed to hand a professional their private note.
const DATA_OPT_IN = ["src/lib/block-editor.ts"];        // /edit/[id]
const VIEW_OPT_IN = ["src/components/editor/block-packet-editor.tsx"];

test("the recipient packet query does not assemble notes at all", () => {
  const q = read("src/lib/queries.ts");
  const fn = q.slice(q.indexOf("export async function getPublishedPacket"), q.indexOf("export async function assembleItemsByIds"));
  assert.doesNotMatch(fn, /notes:/, "getPublishedPacket still assembles a notes field for the recipient");
  // ...and the guard is real: the function is still there and still assembling items.
  assert.match(fn, /description:\s*item\.description/, "the recipient item shape is not where it was — re-verify by hand");
});

test("the shared assembler defaults to the recipient and gates notes on audience", () => {
  const q = read("src/lib/queries.ts");
  assert.match(q, /audience:\s*Audience\s*=\s*"recipient"/, "the assembler no longer defaults to recipient");
  assert.match(q, /audience === "professional" \? \{ notes:/, "notes is no longer gated on audience");
});

test("ItemCard defaults to the recipient audience", () => {
  const c = read("src/components/item-card.tsx");
  assert.match(c, /audience = "recipient"/, "ItemCard no longer defaults to recipient");
  assert.match(c, /audience === "professional" && item\.notes/, "ItemCard renders notes without an audience gate");
});

test("only the editor opts in — at the data layer and in the view", () => {
  const dataOptIns = files.filter((f) => /assembleItemsByIds\([^)]*"professional"/s.test(read(f)));
  assert.deepEqual(dataOptIns.sort(), DATA_OPT_IN.sort(),
    `unexpected reader receiving private notes: ${dataOptIns.join(", ")}`);

  const viewOptIns = files.filter((f) => /<ItemCard[^>]*audience="professional"/s.test(read(f)));
  assert.deepEqual(viewOptIns.sort(), VIEW_OPT_IN.sort(),
    `unexpected surface rendering private notes: ${viewOptIns.join(", ")}`);
});

test("no recipient surface opts in", () => {
  // /p/[slug] is the recipient. /preview/[id] is the professional looking at
  // what the recipient sees, so it must behave identically — it is listed here
  // deliberately, not by accident.
  for (const f of [
    "src/app/p/[slug]/page.tsx",
    "src/app/preview/[id]/page.tsx",
    "src/app/prototype/persisted-blocks/[packetId]/page.tsx",
    "src/components/section-group.tsx",
    "src/components/packet-block-body.tsx",
    "src/lib/block-preview.ts",
  ]) {
    assert.doesNotMatch(read(f), /"professional"/, `${f} opts into private notes`);
  }
});

test("ItemCard is still a client component — the reason data-layer stripping is required", () => {
  // If this ever stops being true the RSC-payload argument changes, and the
  // reasoning in queries.ts should be re-read rather than assumed.
  assert.match(read("src/components/item-card.tsx").slice(0, 40), /^"use client"/);
});

test("the privacy gate lives in the read layer, not in SQL", () => {
  // An earlier version asserted `max(migrationNumber) <= 26`. Its own comment
  // said it was "not that the schema froze afterwards" — and then it froze the
  // schema, so 0027 broke it for a reason that has nothing to do with private
  // notes. A high-water mark is not an invariant; it is a number that has to be
  // edited every time unrelated work lands, and a test edited that often stops
  // being read.
  //
  // The durable claim is where the gate LIVES. Notes are withheld by the
  // assembler choosing an audience; if that decision ever moves into SQL the
  // rule has two homes that can disagree, which is the failure mode this file
  // exists to prevent. Comments are stripped first — the migrations discuss
  // recipients in prose, and a scan that matched its own rationale would be
  // measuring the wrong thing.
  const sqlOnly = (t: string) => t.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const offenders = readdirSync("supabase/migrations")
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .filter((f) => /\baudience\b/i.test(sqlOnly(read(join("supabase/migrations", f)))));
  assert.deepEqual(offenders, [], `audience gating leaked into SQL: ${offenders.join(", ")}`);

  // ABSENCE READS AS SUCCESS: an empty migrations directory would also produce
  // an empty offender list. Assert there was something to scan.
  const scanned = readdirSync("supabase/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
  assert.ok(scanned.length >= 26, `only ${scanned.length} migrations scanned`);
});
