// "CHECK YOUR EMAIL" IS A CLAIM ABOUT SOMETHING THAT HAPPENED.
//
// The route asked Resend to send, read the refusal, logged it, and then
// returned {ok:true} anyway. The login page believed it and displayed "Check
// your email" — so a professional sat watching an inbox for twenty minutes
// while the server had known, in under a second, that nothing had been sent.
//
// These tests are mounted rather than read, because the defect was never in a
// function: every part worked, and the lie was in what one part told another.
// The only place it is visible is on the screen, so that is where it is proved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTE = readFileSync(join(ROOT, "src/app/api/auth/send-magic-link/route.ts"), "utf8");

/** The message the ROUTE actually returns when Resend refuses, read out of the
 *  route itself. Hard-coding it here too would let the two halves of this proof
 *  drift apart: the mounted test would keep passing against a message the
 *  server had stopped sending. */
const SEND_FAILURE: string | null = (() => {
  const at = ROUTE.indexOf('console.error("Failed to send email:');
  if (at < 0) return null;
  const m = ROUTE.slice(at).match(/return NextResponse\.json\(\s*\{ error: "([^"]+)"/);
  return m ? m[1] : null;
})();
/** Read it where a test needs it, so losing it fails THAT test by name rather
 *  than collapsing the whole file — including the success case, which a broken
 *  failure branch does not affect. */
const failureMessage = () => {
  assert.ok(SEND_FAILURE, "the send-failure branch returns no literal message");
  return SEND_FAILURE!;
};

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let LoginPage: typeof import("../app/login/page.tsx").default;
let SearchParamsContext: React.Context<unknown>;

/** What Resend is pretending to have said this time. */
let sendOutcome: { ok: boolean; status: number; body: unknown } = {
  ok: true, status: 200, body: { ok: true },
};
/** Every request the page made, so a rejected send can be shown to have asked. */
let calls: Array<{ path: string; body: unknown }> = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://sendset.io/login", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => {
    calls.push({ path: new URL(url, "https://sendset.io").pathname,
                 body: JSON.parse(init?.body ?? "{}") });
    return Promise.resolve({
      ok: sendOutcome.ok, status: sendOutcome.status,
      json: async () => sendOutcome.body,
    } as unknown as Response);
  }) as typeof fetch;

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ SearchParamsContext } = await import(
    "next/dist/shared/lib/hooks-client-context.shared-runtime.js"
  ) as unknown as { SearchParamsContext: React.Context<unknown> });
  LoginPage = (await import("../app/login/page.tsx")).default;
});
after(() => dom.window.close());

/** Mount the login page, type an address, and submit it. Returns the text a
 *  person would be looking at afterwards. */
async function signIn(email: string): Promise<string> {
  calls = [];
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(SearchParamsContext.Provider,
      { value: new dom.window.URLSearchParams("") },
      React.createElement(LoginPage)));
  });

  const input = host.querySelector("input#email") as HTMLInputElement;
  assert.ok(input, "the login form has no email field");
  const setValue = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, email);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const text = host.textContent ?? "";
  await act(async () => { root.unmount(); });
  host.remove();
  return text;
}

// ---------------------------------------------------------------------------
// THE TWO OUTCOMES
// ---------------------------------------------------------------------------

test("ACCEPTED: the success experience is exactly what it was", async () => {
  sendOutcome = { ok: true, status: 200, body: { ok: true } };
  const screen = await signIn("someone@example.com");

  assert.match(screen, /Check your email/, "the success screen is gone");
  assert.match(screen, /someone@example\.com/, "the address is no longer confirmed back");
  assert.match(screen, /expires in 15 minutes/, "the expiry note is gone");
  assert.doesNotMatch(screen, /We couldn't send/, "an error is shown on a successful send");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/auth/send-magic-link");
});

test("REJECTED: the person is told, and is NOT sent to an empty inbox", async () => {
  // The exact shape the route now returns when Resend refuses.
  sendOutcome = { ok: false, status: 502, body: { error: failureMessage() } };
  const screen = await signIn("someone@example.com");

  assert.ok(screen.includes(failureMessage()),
    "the failure is not shown to the person who caused it");
  assert.doesNotMatch(screen, /Check your email/,
    "THE DEFECT: a failed send still says the email was sent");
  assert.doesNotMatch(screen, /expires in 15 minutes/,
    "the page still describes an email that does not exist");
  // It failed, and the form is still there to try again with.
  assert.match(screen, /Send me a sign-in link/, "there is no way to retry");
});

test("NO RESEND INTERNALS REACH THE SCREEN", async () => {
  // The real production body: a status code, a validation name, and the
  // account owner's own address. None of it is the user's business, and the
  // last part is somebody else's email.
  sendOutcome = { ok: false, status: 502, body: { error: failureMessage() } };
  const screen = (await signIn("someone@example.com")).toLowerCase();
  for (const leak of ["403", "resend", "validation_error", "statuscode",
                      "mmdmscm", "resend.com/domains", "verify a domain"]) {
    assert.ok(!screen.includes(leak), `the screen exposes "${leak}"`);
  }
});

// ---------------------------------------------------------------------------
// AND IT SAYS NOTHING ABOUT THE ADDRESS
// ---------------------------------------------------------------------------

test("the refusal is a CONSTANT — it cannot become an enumeration signal", () => {
  // The route never asks whether an account exists (users are created at
  // verify time), so the send outcome carries no account signal today. Keeping
  // the message a fixed literal is what stops one being introduced later by
  // interpolating the address, or the reason, into it.
  // Scoped to the SEND-failure branch. The route has other error responses —
  // the 400 for a malformed address, the 429 for the rate limit — and matching
  // the first one in the file would have proved nothing about this one.
  assert.equal(failureMessage(), "We couldn't send the sign-in email. Please try again.");
  const branch = ROUTE.slice(ROUTE.indexOf('console.error("Failed to send email:'));
  assert.ok(!/\$\{/.test(branch.slice(0, branch.indexOf("}"))),
    "the failure message interpolates something");
  // No lookup was added to decide what to say.
  assert.ok(!/from\("users"\)/.test(ROUTE),
    "the send route now reads the users table — that is an enumeration signal");
});

// ---------------------------------------------------------------------------
// THE ROUTE'S END OF THE CONTRACT
// ---------------------------------------------------------------------------

test("a refused send is answered with a NON-OK status", () => {
  // The client branches on res.ok and nothing else, so the status is the whole
  // signal. 200 was the bug.
  assert.match(ROUTE, /console\.error\("Failed to send email:"[\s\S]{0,900}?status: 502/,
    "the failure branch does not return a non-ok status");
  const failIdx = ROUTE.indexOf('console.error("Failed to send email:');
  const okIdx = ROUTE.indexOf('NextResponse.json({ ok: true })');
  assert.ok(failIdx > -1 && okIdx > failIdx,
    "the success response no longer comes after the failure branch");
  assert.match(ROUTE.slice(failIdx, okIdx), /return NextResponse\.json\(/,
    "the failure branch falls through to the success response");
});

test("the Resend body is LOGGED, never returned", () => {
  assert.match(ROUTE, /console\.error\("Failed to send email:", await res\.text\(\)\)/,
    "the diagnostic that found this in production is gone");
  // res.text() is read once, into the log. Nothing carries it onward.
  assert.ok(!/NextResponse\.json\([^)]*res\.text\(\)/.test(ROUTE),
    "the Resend body is returned to the caller");
  assert.equal((ROUTE.match(/res\.text\(\)/g) ?? []).length, 1,
    "the Resend body is read more than once");
});

test("NOTHING ELSE ABOUT THE ROUTE MOVED", () => {
  // Scope: the rate limit, the token, the row it writes and the dev path are
  // all untouched. Each is a thing this change deliberately did not do.
  assert.match(ROUTE, />= 5\)/, "the rate limit changed");
  assert.match(ROUTE, /15 \* 60 \* 1000/, "the token lifetime changed");
  assert.match(ROUTE, /from\("magic_links"\)\s*\.insert/, "the row it writes changed");
  assert.match(ROUTE, /🔗 Magic link for/, "the dev-mode path changed");
  assert.match(ROUTE, /RESEND_FROM_EMAIL \|\| "Sendset <onboarding@resend\.dev>"/,
    "the sender or the email template changed");
});
