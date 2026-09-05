import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  unitId, buildReviewUnits, attachItems, isResolvable, isReviewRequired,
  unresolvedCount, hasUnresolvableBlocker, guidanceFor,
  REVIEW_REQUIRED, OBSERVED_ONLY,
} from "./review-units.ts";
import type { UnresolvedUnit } from "./enforce-chunk.ts";

const read = (p: string) => readFileSync(p, "utf8");
const unit = (o: Partial<UnresolvedUnit>): UnresolvedUnit => ({
  record: 0, title: "Alpha", kind: "privacy-rejected", text: "some prose", reason: "no authority", ...o,
});

test("a unit id is derived from content, so it survives a reload and a replay", () => {
  const base = { chunk: 0, record: 2, kind: "privacy-rejected", text: "hello" };
  assert.equal(unitId("run-1", base), unitId("run-1", base));
  const a = unitId("run-1", base);
  // ...and is not shared with a different unit, which is what would let one
  // decision clear the wrong piece of content.
  assert.notEqual(a, unitId("run-1", { ...base, record: 3 }));
  assert.notEqual(a, unitId("run-1", { ...base, chunk: 1 }));
  assert.notEqual(a, unitId("run-1", { ...base, text: "hello " }));
  assert.notEqual(a, unitId("run-2", base));
});

test("a review-required exception and observed telemetry are not the same thing", () => {
  const out = buildReviewUnits("r", 0, [
    unit({ text: "held prose" }),
    unit({ kind: "source-unresolved", text: "$4,200/mo" }),
  ]);
  // Observed-unresolved material is recognized but unproven, so it is recorded
  // and NOT turned into a question. Promoting it would produce review fatigue
  // and teach people to click through warnings.
  assert.equal(out.length, 1, "observed telemetry must not become a blocker");
  assert.equal(out[0].text, "held prose");
  assert.equal(out[0].code, "privacy_rejected");
  assert.equal(out[0].status, "unresolved");
});

test("every kind enforcement can emit is classified explicitly, in exactly one class", () => {
  // The UnresolvedUnit union is the authority. A kind nobody classified would
  // fall through to the fail-closed default and start asking questions nobody
  // designed - so the classification must be total, and the two classes must
  // not overlap.
  const declared = readFileSync("src/lib/enforce-chunk.ts", "utf8");
  const union = /kind:\s*((?:"[a-z-]+"\s*\|?\s*)+);/.exec(declared);
  assert.ok(union, "could not find the UnresolvedUnit kind union");
  const kinds = [...union![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 2, `expected the union to declare kinds, found ${kinds.length}`);
  for (const k of kinds) {
    const inReview = k in REVIEW_REQUIRED, inObserved = k in OBSERVED_ONLY;
    assert.ok(inReview !== inObserved, `${k} is in neither class or both`);
  }
});

test("an unclassified kind fails CLOSED - it becomes a question, not silence", () => {
  // Something the layer produced but nobody classified is, by definition, not
  // proven safe to hide.
  assert.equal(isReviewRequired("something-nobody-classified"), true);
  assert.equal(isReviewRequired("source-unresolved"), false);
});

test("guidance comes from the registry so a future exception brings its own", () => {
  const [f] = buildReviewUnits("r", 0, [unit({})]);
  assert.match(guidanceFor(f), /private note/);
  assert.match(guidanceFor({ id: "x", code: "future_thing", kind: "future-thing" }),
    /needs a decision/);
});

test("the same excerpt on the same record is one decision, not two", () => {
  const out = buildReviewUnits("r", 0, [unit({ text: "same" }), unit({ text: "same" })]);
  assert.equal(out.length, 1);
});

test("an empty excerpt is not a decision anyone can make", () => {
  assert.equal(buildReviewUnits("r", 0, [unit({ text: "   " })]).length, 0);
});

test("a unit names an item only when the title identifies exactly one", () => {
  const built = buildReviewUnits("r", 0, [unit({ title: "Alpha" })]);
  const one = attachItems(built, new Map([["Alpha", ["item-1"]]]));
  assert.deepEqual(one[0].itemIds, ["item-1"]);
  // Two items share the title. Pointing at whichever sorted first would be
  // worse than pointing at none: the title is displayed either way.
  const two = attachItems(built, new Map([["Alpha", ["item-1", "item-2"]]]));
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
  assert.equal(hasUnresolvableBlocker(buildReviewUnits("r", 0, [unit({})])), false);
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

test("NO CONTROL SENDS CONTENT — a disposition is all the client may say", () => {
  const c = read("src/components/ImportProgress.tsx");
  // This mattered before because FlowGuide must not choose a destination. It
  // matters MORE now that one disposition writes: `kept_private` takes its text
  // from the stored unit, server-side, so a tampered client cannot post
  // arbitrary prose into somebody's private notes. The browser says which
  // decision was made and nothing else.
  const calls = [...c.matchAll(/resolveUnit\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3, "the three dispositions are not all offered");
  for (const c2 of calls) {
    assert.match(c2, /^f\.id,\s*"(kept_private|resolved|ignored)"$/,
      `resolveUnit carries content: ${c2}`);
  }
});

test("the RPC reads the text from the STORED unit, never from a parameter", () => {
  const sql = readFileSync("supabase/migrations/0043_review_keep_as_private_note.sql", "utf8");
  assert.match(sql, /v_text := v_unit->>'text';/,
    "the note text does not come from the unit the server already holds");
  // The signature is unchanged, so there is no parameter that could carry prose.
  assert.match(sql, /p_owner uuid, p_run_id uuid, p_unit_id text, p_status text/);
});

test("finalize aggregates the dedicated channel, and does not re-derive units", () => {
  const f = read("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.match(f, /from\("ingestion_chunks"\)\s*\.select\("review_units"\)/);
  assert.match(f, /attachItems\(\[\.\.\.byId\.values\(\)\], byTitle\)/);
  // IDS ARE ASSIGNED WHERE UNITS ARE PRODUCED, and finalize does not recompute
  // a CHUNK's id: doing so would make it depend on finalize's view of the world
  // rather than the chunk's, and a stale client would clear the wrong card.
  //
  // The one unit finalize MINTS is the one no chunk could have produced. "Which
  // source lines reached none of the assembled item?" cannot be answered before
  // the run-level fold, because no chunk can see another chunk's output — asked
  // per chunk on the Spring Lake run it gives 58 answers, of which most are
  // artefacts. So it is produced here, once, and its id is derived from its
  // content exactly as a chunk's is, which keeps a replay stable.
  const mints = f.match(/unitId\(/g) ?? [];
  assert.equal(mints.length, 1, "finalize mints more than the one run-level unit");
  const at = f.indexOf("unitId(");
  const near = f.slice(Math.max(0, at - 600), at + 200);
  assert.match(near, /source-details-omitted/,
    "finalize mints an id for something other than the run-level omission unit");
  assert.match(near, /chunk: -1/, "the minted unit claims to belong to a chunk");
  // And no chunk-produced unit is re-derived: the aggregation still copies.
  assert.match(f, /for \(const u of c\.review_units \?\? \[\]\) if \(u\?\.id && !byId\.has\(u\.id\)\)/);
});

test("a replayed finalize cannot resurrect decisions already made", () => {
  const f = read("src/app/api/ingest/[runId]/finalize/route.ts");
  // `reused` alone is the wrong test: a finalize that applied and then died
  // before writing its review is also a replay, and skipping there would leave
  // the run finalized with unresolved work and publishing open.
  assert.match(f, /alreadyDecided\s*=\s*cleared\?\.status === "finalized" && cleared\?\.review\?\.ok === true/);
  assert.match(f, /if \(!ok && alreadyDecided\)/);
});
