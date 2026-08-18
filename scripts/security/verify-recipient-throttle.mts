// Prove the recipient-link rate limit is actually live.
//
//   npx tsx scripts/security/verify-recipient-throttle.mts https://flowguide-ruddy.vercel.app
//
// WHY THIS EXISTS. The protection is a Vercel WAF rule configured in the
// dashboard, which is the right mechanism — it runs at the edge, costs the
// recipient page nothing, and needs no application state. But a dashboard
// setting is invisible to code review, untested, and silently lost if the
// project is recreated or the rule is edited. This script is the only thing
// standing between "we configured it" and "it works".
//
// SAFE. It requests slugs that cannot exist (a random prefix under a reserved
// namespace) so it never touches a real packet, never reads client data, and
// writes nothing. It is deliberately serial — the point is to trip a limit, not
// to generate load.
//
// Rule under test, from docs/investigations/recipient-link-hardening-design.md:
//   path starts with /p/ · fixed window 60s · limit 60 · key IP
//
// While the rule is in LOG mode this script is EXPECTED to report "not
// enforcing" — that is the intended first state, not a failure. Flip the rule to
// Deny once the logs show no legitimate traffic tripping it, then re-run.

const BASE = process.argv[2];
if (!BASE || !BASE.startsWith("https://")) {
  console.error("usage: verify-recipient-throttle.mts https://<production-host>");
  process.exit(2);
}

const LIMIT = Number(process.env.THROTTLE_LIMIT ?? 60);
const CEILING = LIMIT * 3;            // give up well past the limit
const NAMESPACE = `zz-throttle-probe-${Date.now().toString(36)}`;

console.log(`\nrecipient throttle probe — ${BASE}`);
console.log(`expecting the limit to engage at or before ${LIMIT} requests to /p/*`);
// Printed so the run can be located in Firewall Observability afterwards. In Log
// mode the dashboard is the ONLY place the result is visible, and without this
// there is no way to filter to exactly these requests.
console.log(`path filter for the logs: /p/${NAMESPACE}-*`);
console.log(`started at: ${new Date().toISOString()}\n`);

let firstThrottledAt: number | null = null;
let sent = 0;
const statuses = new Map<number, number>();
const started = Date.now();
let windowNote = "";

/** Any header a firewall might use to signal it acted. Captured because in LOG
 *  mode the status code alone cannot distinguish "rule matched and logged" from
 *  "rule never matched" — both are a plain 404 from outside. */
const interesting = (h: Headers) =>
  [...h.entries()].filter(([k]) =>
    k.startsWith("x-vercel") || k.includes("ratelimit") || k.includes("rate-limit") ||
    k === "retry-after" || k.includes("firewall"));

for (let i = 1; i <= CEILING; i++) {
  // A slug that cannot collide with a real packet: reserved prefix + counter.
  const res = await fetch(`${BASE}/p/${NAMESPACE}-${i}`, { redirect: "manual" });
  sent = i;
  statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);

  if (i === 1 || i === LIMIT + 1) {
    console.log(`  [request ${i}] status ${res.status}, elapsed ${Date.now() - started}ms`);
    for (const [k, v] of interesting(res.headers)) console.log(`      ${k}: ${v}`);
  }
  // The rule counts per 60s window, so exceeding the limit only proves anything
  // if the requests actually landed inside one.
  if (i === LIMIT + 1) {
    const secs = (Date.now() - started) / 1000;
    windowNote = secs <= 60
      ? `${LIMIT + 1} requests sent in ${secs.toFixed(1)}s — inside the 60s window, so the limit WAS exceeded`
      : `${LIMIT + 1} requests took ${secs.toFixed(1)}s — LONGER than the 60s window, so the limit may never have been exceeded`;
    console.log(`  ${windowNote}`);
  }

  // 429 is the default action; Deny may surface as 403. Either proves the rule
  // is enforcing. A 404 means the request reached the app and found nothing,
  // which is the un-throttled path.
  if (res.status === 429 || res.status === 403) {
    firstThrottledAt = i;
    break;
  }
  if (i % 20 === 0) console.log(`  ${i} requests, still ${res.status}`);
}

console.log(`\nsent ${sent} requests`);
console.log("status counts:", JSON.stringify(Object.fromEntries(statuses)));

console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (windowNote) console.log(windowNote);

if (firstThrottledAt === null) {
  console.log(`\nNOT BLOCKING — ${sent} requests to /p/* were all served.`);
  console.log("");
  console.log("In LOG mode this is the CORRECT result: the rule counts and records,");
  console.log("it does not reject. What this probe canNOT tell you is whether the rule");
  console.log("MATCHED — a logged request and an unmatched request are both a plain 404");
  console.log("from outside. That answer lives in Firewall Observability, and it is the");
  console.log("thing to read before switching to Deny.");
  console.log("");
  console.log("If the rule were set to Deny, this same output WOULD be a failure.");
  process.exitCode = 1;
} else {
  console.log(`\nENFORCING — throttled at request ${firstThrottledAt}.`);
  if (firstThrottledAt > LIMIT) {
    // Not a failure. Vercel counts per region, so the observed trip point can
    // legitimately sit above a single region's configured limit.
    console.log(`Above the configured ${LIMIT}, which is expected: Vercel counts`);
    console.log("rate limits per region, so the global trip point can exceed one region's limit.");
  }
  console.log("\nNote: this proves the rule engages, NOT that it is tuned correctly.");
  console.log("Whether legitimate recipients stay under it is answered by Firewall");
  console.log("Observability over days in Log mode, not by this script.");
}
