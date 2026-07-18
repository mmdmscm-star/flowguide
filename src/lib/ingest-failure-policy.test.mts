// Regression tests for how a failed chunk is retried vs subdivided.
//
// Observed in acceptance testing: OpenRouter returned HTTP 402 ("out of
// credits"). ai-structure flattened it to a generic 502, so the chunk route
// treated it as "this segment must be too big", subdivided, subdivided again,
// and after split_depth 4 the whole 110-item import died with
// "chunk 39 too small to subdivide further". A billing failure destroyed the run.
//
// The policy is asserted from the route/provider source because it spans an HTTP
// route and a provider call that cannot be exercised without live credits.
// Run: npx tsx --test src/lib/ingest-failure-policy.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const route = readFileSync(join(root, "src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts"), "utf8");
const provider = readFileSync(join(root, "src/lib/ai-structure.ts"), "utf8");

test("the provider distinguishes billing/auth failures from generic errors", () => {
  assert.match(provider, /structuredCode === 402 \|\| aiRes\.status === 402/, "402 detected");
  assert.match(provider, /401|403/, "401/403 detected");
  assert.match(provider, /ai_credits_exhausted/, "distinct error code for exhausted credits");
  assert.match(provider, /ai_key_rejected/, "distinct error code for a rejected key");
  // The actionable message must reassure that input was not lost.
  assert.match(provider, /out of credits[\s\S]*your text was not lost/i, "actionable credits message");
  // The billing branch must come BEFORE the generic 502 fallback.
  const billing = provider.indexOf("billingOrAuth");
  const generic = provider.indexOf('error: "AI service error. Please try again."');
  assert.ok(billing !== -1 && generic !== -1 && billing < generic, "billing checked before the generic fallback");
});

test("the chunk route classifies failures three ways", () => {
  assert.match(route, /const TRANSIENT_MARK = "\[transient\]"/, "transient marker");
  assert.match(route, /const PERMANENT_MARK = "\[permanent\]"/, "permanent marker");
  assert.match(route, /isTransientStatus = \(s: number\) => s === 429 \|\| \(s >= 500 && s <= 599\)/, "transient = 429/5xx");
  assert.match(route, /isPermanentStatus = \(s: number\) => s === 401 \|\| s === 402 \|\| s === 403/, "permanent = 401/402/403");
});

test("a transient failure retries the SAME segment before any subdivision", () => {
  assert.match(route, /wasTransient[\s\S]*attempt > MAX_TRANSIENT_ATTEMPTS[\s\S]*doSplit\(\)/, "splits only after the transient budget");
  assert.match(route, /MAX_TRANSIENT_ATTEMPTS = \d+/, "bounded transient budget");
  // The prior attempt's reason is read back; claim_chunk does not clear `error`.
  assert.match(route, /select\("error"\)[\s\S]*eq\("ordinal", ordinal\)/, "reads the previous failure reason");
});

test("a permanent failure neither retries nor subdivides", () => {
  const permIdx = route.indexOf("prevErr.startsWith(PERMANENT_MARK)");
  assert.ok(permIdx !== -1, "permanent branch exists");
  const splitIdx = route.indexOf("if (!wasTransient || attempt > MAX_TRANSIENT_ATTEMPTS) return doSplit();");
  assert.ok(splitIdx !== -1 && permIdx < splitIdx, "permanent is handled before the split decision");
  assert.match(route, /permanent: true/, "response flags the condition as permanent");
  // It must NOT fall through to a model call.
  const seg = route.slice(permIdx, permIdx + 700);
  assert.ok(!/processSegment\(/.test(seg), "permanent failure does not call the model again");
});

test("oversized segments still pre-split without spending a model call", () => {
  assert.match(route, /if \(shouldPresplit\(segmentText\)\) return doSplit\(\);/, "presplit preserved");
  const pre = route.indexOf("shouldPresplit(segmentText)) return doSplit()");
  const model = route.indexOf("await processSegment({");
  assert.ok(pre !== -1 && model !== -1 && pre < model, "presplit precedes the model call");
});

test("the finalize route never leaks raw Postgres text to the editor", () => {
  const fin = readFileSync(join(root, "src/app/api/ingest/[runId]/finalize/route.ts"), "utf8");
  assert.ok(!/error:\s*error\.message/.test(fin), "raw rpc message is not returned");
  assert.match(fin, /Some parts haven't finished yet/, "incomplete run gets a human message");
  assert.match(fin, /console\.error\("\[finalize\] rpc error:"/, "raw text kept in logs");
});

test("the orchestrator waits for in-flight chunks instead of finalizing early", () => {
  const hook = readFileSync(join(root, "src/lib/useIngestion.ts"), "utf8");
  assert.match(hook, /leaves\.some\(\(c\) => c\.status === "processing"\)[\s\S]*sleep\(RETRY_BACKOFF_MS\)[\s\S]*continue/, "waits on processing chunks");
  const wait = hook.indexOf('c.status === "processing"');
  const finalize = hook.indexOf("/finalize`");
  assert.ok(wait !== -1 && finalize !== -1 && wait < finalize, "the wait precedes the finalize call");
  assert.match(hook, /fin\.status === 409[\s\S]*continue/, "409 keeps driving rather than erroring");
});
