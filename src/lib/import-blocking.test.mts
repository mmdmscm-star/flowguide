// A finalized import whose review is still pending blocks publishing, and the
// finalize route replaces the pending marker with a recorded verdict or refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLOCKING_RUN_FILTER, BLOCKING_RUN_STATUSES,
  isReviewPending, isReviewUndecided, runBlocksPublishing,
} from "./import-blocking.ts";

// Comments name the old behaviour; only code counts.
const codeOf = (p: string) => readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const FINALIZE = "src/app/api/ingest/[runId]/finalize/route.ts";
const PUBLISH = "src/app/api/packets/[id]/publish/route.ts";
const INGEST = "src/app/api/packets/[id]/ingest/route.ts";
const HOOK = "src/lib/useIngestion.ts";

test("which runs block publishing", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["active", {}, true],
    ["finalizing", {}, true],
    ["needs_review", { ok: false, failures: [{ code: "x" }] }, true],
    ["finalized", { pending: true }, true],
    ["finalized", {}, false],                       // every run before 0051
    ["finalized", { ok: true, summary: "" }, false],
    ["finalized", { pending: "true" }, false],      // the marker is a boolean, not text
    ["discarded", { pending: true }, false],
  ];
  for (const [status, review, blocks] of cases) {
    assert.equal(runBlocksPublishing({ status, review }), blocks, `${status} ${JSON.stringify(review)}`);
  }
  assert.equal(runBlocksPublishing(null), false);
  assert.equal(isReviewPending({ pending: true }), true);
  assert.equal(isReviewPending([{ pending: true }]), false);
});

test("an undecided review is a finalized run with no verdict yet", () => {
  assert.equal(isReviewUndecided({ status: "finalized", review: { pending: true } }), true);
  assert.equal(isReviewUndecided({ status: "finalized", review: {} }), true);
  assert.equal(isReviewUndecided({ status: "finalized", review: { ok: true } }), false);
  assert.equal(isReviewUndecided({ status: "finalized", review: { ok: false } }), false);
  assert.equal(isReviewUndecided({ status: "needs_review", review: { pending: true } }), false);
});

test("the PostgREST filter says the same thing as runBlocksPublishing", () => {
  assert.deepEqual([...BLOCKING_RUN_STATUSES], ["active", "finalizing", "needs_review"]);
  assert.equal(BLOCKING_RUN_FILTER,
    "status.in.(active,finalizing,needs_review),and(status.eq.finalized,review->pending.eq.true)");
});

test("every packet-side lookup uses the one definition, not a copied status list", () => {
  for (const file of [PUBLISH, INGEST]) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /\.in\("status",\s*\["active",\s*"finalizing",\s*"needs_review"\]\)/,
      `${file} still has its own copy of the blocking statuses`);
  }
  assert.equal((codeOf(INGEST).match(/\.or\(BLOCKING_RUN_FILTER\)/g) ?? []).length, 2,
    "both the reconnect lookup and the existing-run check must see a pending run");
  assert.equal((codeOf(PUBLISH).match(/\.or\(BLOCKING_RUN_FILTER\)/g) ?? []).length, 1);
});

test("publishing refuses a pending run, and refuses when it cannot check", () => {
  const code = codeOf(PUBLISH);
  const gate = code.indexOf(".or(BLOCKING_RUN_FILTER)");
  const unavailable = code.indexOf('"import_check_unavailable"');
  const finishing = code.indexOf('"import_finishing"');
  const update = code.indexOf('status: "published"');
  assert.ok(gate > 0 && unavailable > gate && finishing > gate, "the gate must read errors and name the pending case");
  assert.ok(finishing < update && unavailable < update, "both refusals come before the publishing write");
  assert.match(code.slice(unavailable, unavailable + 200), /status: 503/);
  assert.match(code,
    /const \{ data: activeRun, error: activeRunErr \}[\s\S]{0,400}\.or\(BLOCKING_RUN_FILTER\)[\s\S]{0,80}\.maybeSingle\(\);\s*if \(activeRunErr\) \{[\s\S]{0,200}"import_check_unavailable"/,
    "the refusal must be driven by the query's own error");
  assert.match(code.slice(finishing, finishing + 250), /status: 409/);
});

test("finalize records BOTH verdicts, only onto an undecided review", () => {
  const code = codeOf(FINALIZE);
  const write = code.indexOf('.update(verdict)');
  assert.ok(write > 0, "the verdict must be persisted");
  assert.match(code, /const verdict = ok \? \{ review \} : \{ status: "needs_review", review \};/,
    "a clean run is recorded too, not only one that needs review");
  const chain = code.slice(write, write + 300);
  assert.match(chain, /\.eq\("status", "finalized"\)/);
  assert.match(chain, /\.is\("review->ok", null\)/, "only an undecided review may be replaced");
  assert.match(code, /isReviewUndecided\(cleared/);
});

test("finalize fails closed: a failed check or a failed write returns 503 and writes nothing", () => {
  const code = codeOf(FINALIZE);
  const catchAt = code.lastIndexOf("} catch (e) {");
  const handler = code.slice(catchAt, catchAt + 400);
  assert.match(handler, /"review_not_recorded"/);
  assert.match(handler, /status: 503/);
  assert.doesNotMatch(handler, /\.update\(|review: \{\}|\.from\(/, "the catch must not reset or write the review");
  assert.match(code, /if \(reviewErr\) throw new Error/, "a write error must reach the fail-closed catch");
  assert.match(code, /if \(isReviewUndecided\(after\)\) throw new Error/, "a write that did not land must too");
  // Reads that feed the verdict throw rather than reading an error as "no rows".
  for (const what of ['"packet"', '"sections"', '"items"', '"photos"', '"review units"', '"item titles"', '"run state"']) {
    assert.match(code, new RegExp(`must\\([\\s\\S]{0,200}?${what}\\)`), `${what} read must fail closed`);
  }
  assert.match(code, /if \(blocksRes\.error\) throw new Error/);
  assert.doesNotMatch(code, /return NextResponse\.json\(\{ ok: true[^}]*\}\);\s*\}\s*catch/,
    "success must not be returned from inside the accounting block");
});

test("the client treats a pending run as unfinished and replays finalize", () => {
  const code = codeOf(HOOK);
  assert.match(code, /if \(run\.status === "finalized" && !isReviewPending\(run\.review\)\) \{[^}]*phase: "done"/,
    "a pending run must not be reported Done");
});
