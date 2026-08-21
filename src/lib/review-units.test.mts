import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  unitId, toReviewFailures, isResolvable, unresolvedCount, hasUnresolvableBlocker,
} from "./review-units.ts";
import type { UnresolvedUnit } from "./enforce-chunk.ts";

const read = (p: string) => readFileSync(p, "utf8");
const unit = (o: Partial<UnresolvedUnit>): UnresolvedUnit => ({
  record: 0, title: "Alpha", kind: "privacy-rejected", text: "some prose", reason: "no authority", ...o,
});

test("a unit id is derived from content, so it survives a reload and a replay", () => {
  const a = unitId("run-1", { record: 2, kind: "privacy-rejected", text: "hello" });
  const b = unitId("run-1", { record: 2, kind: "privacy-rejected", text: "hello" });
  assert.equal(a, b);
  // ...and is not shared with a different unit, which is what would let one
  // decision clear the wrong piece of content.
  assert.notEqual(a, unitId("run-1", { record: 3, kind: "privacy-rejected", text: "hello" }));
  assert.notEqual(a, unitId("run-1", { record: 2, kind: "privacy-rejected", text: "hello " }));
  assert.notEqual(a, unitId("run-2", { record: 2, kind: "privacy-rejected", text: "hello" }));
});

test("only privacy-rejected units block publishing", () => {
  const out = toReviewFailures("r", [
    unit({ text: "held prose" }),
    unit({ kind: "source-unresolved", text: "$4,200/mo" }),
  ]);
  // SOURCE_UNRESOLVED is evidence, not a blocker. Blocking on it would put
  // nearly every import into review.
  assert.equal(out.length, 1, "source-unresolved must not become a blocker");
  assert.equal(out[0].text, "held prose");
  assert.equal(out[0].status, "unresolved");
});

test("the same excerpt on the same record is one decision, not two", () => {
  const out = toReviewFailures("r", [unit({ text: "same" }), unit({ text: "same" })]);
  assert.equal(out.length, 1);
});

test("an empty excerpt is not a decision anyone can make", () => {
  assert.equal(toReviewFailures("r", [unit({ text: "   " })]).length, 0);
});

test("a unit names an item only when the title identifies exactly one", () => {
  const one = toReviewFailures("r", [unit({ title: "Alpha" })], new Map([["Alpha", ["item-1"]]]));
  assert.deepEqual(one[0].itemIds, ["item-1"]);
  // Two items share the title. Pointing at whichever sorted first would be
  // worse than pointing at none: the title is displayed either way.
  const two = toReviewFailures("r", [unit({ title: "Alpha" })], new Map([["Alpha", ["item-1", "item-2"]]]));
  assert.equal(two[0].itemIds, undefined);
  assert.equal(two[0].title, "Alpha", "the professional must still see which record it came from");
});

test("a legacy failure with no status counts as outstanding", () => {
  // This mirrors the RPC's own count. Reading a missing status as "handled"
  // would finalize a run with real work still in it.
  assert.equal(unresolvedCount([{ id: "a", code: "media_missing" }]), 1);
  assert.equal(unresolvedCount([{ id: "a", code: "x", status: "resolved" }]), 0);
  assert.equal(unresolvedCount([{ id: "a", code: "x", status: "ignored" }]), 0);
});

test("a media failure is not resolvable by these controls and still blocks", () => {
  const media = { id: "", code: "media_missing", url: "https://x/y.jpg" };
  assert.equal(isResolvable(media), false);
  // The run therefore keeps discard as its exit - the per-unit controls must
  // not appear to clear a blocker they cannot clear.
  assert.equal(hasUnresolvableBlocker([media]), true);
  assert.equal(hasUnresolvableBlocker(toReviewFailures("r", [unit({})])), false);
});

// ---------------------------------------------------------------- source gates

test("the resolve route takes the owner from the session and never from the body", () => {
  const r = read("src/app/api/ingest/[runId]/review/[unitId]/route.ts");
  assert.match(r, /p_owner:\s*session\.userId/, "the owner is no longer the session's");
  // The body is read for `status` only. Comments are stripped first: the file
  // explains at length why a body-supplied owner is forbidden, and a scan that
  // matched its own rationale would be measuring the wrong thing.
  const code = r.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /body\s*[?.]*\.\s*(owner|user|userId|p_owner)/i,
    "the route reads an owner out of the request body");
});

test("resolution goes through the RPC, not through a direct table write", () => {
  const r = read("src/app/api/ingest/[runId]/review/[unitId]/route.ts");
  assert.match(r, /rpc\("resolve_review_unit"/);
  // A direct update could clear a unit without the last-unit transition, which
  // is precisely the split-brain the RPC exists to prevent.
  assert.doesNotMatch(r, /from\("ingestion_runs"\)[\s\S]{0,80}\.update\(/);
});

test("the held excerpt is shown to the creator", () => {
  const c = read("src/components/ImportProgress.tsx");
  // A decision about writing nobody can read is not a decision.
  assert.match(c, /\{f\.text\}/, "the panel no longer renders the verbatim excerpt");
  assert.match(c, /resolveUnit\(f\.id, "resolved"\)/);
  assert.match(c, /resolveUnit\(f\.id, "ignored"\)/);
  // Async state must be visible: a button that does nothing visible while it
  // works reads as broken.
  assert.match(c, /disabled=\{resolving === f\.id\}/);
});

test("neither control writes the held prose anywhere", () => {
  const c = read("src/components/ImportProgress.tsx");
  // FlowGuide choosing a destination is the error this panel exists to prevent,
  // so the only thing either button sends is a status.
  const calls = [...c.matchAll(/resolveUnit\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2);
  for (const c2 of calls) {
    assert.match(c2, /^f\.id,\s*"(resolved|ignored)"$/, `resolveUnit carries content: ${c2}`);
  }
});

test("finalize gathers units from the chunk ledgers rather than re-deriving them", () => {
  const f = read("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.match(f, /toReviewFailures\(runId, units, byTitle\)/);
  assert.match(f, /from\("ingestion_chunks"\)\s*\.select\("fact_ledger"\)/);
});
