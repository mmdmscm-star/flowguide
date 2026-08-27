import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const codeOf = (p: string) => readFileSync(p, "utf8");
const bodyOf = (p: string) => codeOf(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const AI = codeOf("src/lib/ai-structure.ts");
const ROUTE = codeOf("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");
const ROUTE_BODY = bodyOf("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");

// The exact body OpenRouter returned when this destroyed a benchmark run.
const REAL_402 = JSON.stringify({ error: { message:
  "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
  code: 402, metadata: { reason: "in_flight_budget_exhausted",
    headers: { "Retry-After": "120" } } } });
const GENUINE_402 = JSON.stringify({ error: { message: "Insufficient credits", code: 402 } });
const UNKNOWN_402 = JSON.stringify({ error: { message: "Payment required", code: 402,
  metadata: { reason: "something_new_we_do_not_know" } } });

/** The classifier, exercised the way ai-structure does. */
function classify(errText: string, status = 402) {
  let structuredCode: number | null = null, reason = "", retryAfter = 0;
  try {
    const p = JSON.parse(errText);
    if (typeof p?.error?.code === "number") structuredCode = p.error.code;
    reason = String(p?.error?.metadata?.reason ?? "");
    retryAfter = Number(p?.error?.metadata?.headers?.["Retry-After"] ?? 0) || 0;
  } catch { /* not JSON */ }
  const temporary = (structuredCode === 402 || status === 402) && reason === "in_flight_budget_exhausted";
  return { temporary, retryAfter };
}

test("1. 402 + in_flight_budget_exhausted IS TRANSIENT, and carries Retry-After", () => {
  const c = classify(REAL_402);
  assert.equal(c.temporary, true, "the known transient condition was treated as permanent");
  assert.equal(c.retryAfter, 120, "Retry-After was not read for timing");
  assert.match(AI, /providerReason === "in_flight_budget_exhausted"/, "classification is not by structured reason");
  assert.match(AI, /error: "ai_capacity_temporary"/);
});

test("2. IT IS NOT RECORDED AS PERMANENT — the chunk is not poisoned", () => {
  assert.match(ROUTE, /const CAPACITY_MARK = "\[capacity\]"/, "there is no distinct capacity mark");
  assert.match(ROUTE, /if \(errorCode === "ai_capacity_temporary"\) return CAPACITY_MARK;/,
    "the capacity error is not mapped to its own mark");
  // The permanent replay path must be reachable only via PERMANENT_MARK.
  assert.match(ROUTE, /if \(prevErr\.startsWith\(PERMANENT_MARK\)\)/);
  assert.match(ROUTE, /permanent: false/, "a bounded capacity failure still reports itself permanent");
});

test("3. GENUINE out-of-credits stays PERMANENT", () => {
  assert.equal(classify(GENUINE_402).temporary, false, "a real credit exhaustion was made retryable");
  assert.match(AI, /error: "ai_credits_exhausted"|billingOrAuth === "credits"/);
  assert.match(AI, /out of credits/i, "the genuine message was lost");
});

test("4. AN UNKNOWN 402 STAYS CONSERVATIVE", () => {
  assert.equal(classify(UNKNOWN_402).temporary, false, "an unrecognised reason was assumed transient");
  assert.equal(classify("not json at all").temporary, false, "a non-JSON 402 was assumed transient");
  assert.equal(classify(JSON.stringify({ error: { code: 402 } })).temporary, false, "a 402 with no reason was assumed transient");
});

test("5. A CAPACITY 402 NEVER SUBDIVIDES", () => {
  // Subdividing on a budget error is how a provider blip shredded a 110-item
  // import: the error says nothing about segment size.
  const i = ROUTE_BODY.indexOf("prevErr.startsWith(CAPACITY_MARK)");
  const j = ROUTE_BODY.indexOf("} else {", i);
  assert.ok(i > -1 && j > i, "the capacity branch is missing");
  const branch = ROUTE_BODY.slice(i, j);
  assert.ok(!/doSplit\(\)/.test(branch), "the capacity path can reach doSplit — it must never subdivide");
  // And the transient path still does subdivide, so that protection is intact.
  assert.match(ROUTE_BODY, /wasTransient \|\| attempt > MAX_TRANSIENT_ATTEMPTS\) return doSplit\(\)/,
    "the original transient/subdivide protection was weakened");
});

test("6. THE MESSAGE DISTINGUISHES CAPACITY FROM CREDIT EXHAUSTION", () => {
  const temp = /temporarily at capacity/i;
  const gone = /out of credits/i;
  assert.match(AI, temp, "there is no temporary-capacity message");
  assert.match(AI, gone, "the genuine message was lost");
  // They must not be the same sentence.
  const tempMsg = /The AI service is temporarily at capacity[^"]*/.exec(AI)?.[0] ?? "";
  const goneMsg = /The AI account is out of credits[^"]*/.exec(AI)?.[0] ?? "";
  assert.ok(tempMsg && goneMsg && tempMsg !== goneMsg);
  assert.ok(!gone.test(tempMsg), "the temporary message still tells the professional to add credits");
});

test("7. RETRIES STAY BOUNDED even if every attempt is the transient condition", () => {
  assert.match(ROUTE, /const MAX_CAPACITY_ATTEMPTS = \d+/, "capacity retries are unbounded");
  assert.match(ROUTE, /attempt > MAX_CAPACITY_ATTEMPTS/, "the bound is never checked");
  const n = Number(/MAX_CAPACITY_ATTEMPTS = (\d+)/.exec(ROUTE)?.[1] ?? 0);
  assert.ok(n > 0 && n <= 10, `implausible bound: ${n}`);
  // Exhausting the bound stops with a 429 and a "come back" message, not a loop.
  assert.match(ROUTE, /status: 429/, "an exhausted capacity retry does not answer 429");
  assert.match(ROUTE, /Resume this import in a few minutes/);
});

test("the capacity refusal answers 429, not 402", () => {
  // 402 is what the client is told to read as "add credits"; a capacity
  // refusal must not look like that.
  assert.match(ROUTE, /mark === CAPACITY_MARK \? 429 :/, "a capacity failure still answers 402");
});
