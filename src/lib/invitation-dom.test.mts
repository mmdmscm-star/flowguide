// The two clicks that matter: Approve & send invite, and Get started.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let AppRouterContext: React.Context<unknown>;
let InviteRequestList: typeof import("../components/invite-request-list.tsx").InviteRequestList;
let AcceptInvitation: typeof import("../components/accept-invitation.tsx").AcceptInvitation;

type Call = { url: string; body?: unknown };
const calls: Call[] = [];
const pushed: string[] = [];
let reply: { ok: boolean; body: unknown } = { ok: true, body: {} };
const ROUTER = { push: (to: string) => { pushed.push(to); }, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {} };

const ROWS = [
  { id: "r1", name: "Jane Doe", email: "jane@example.com", use_case: "Venue lists", created_at: "2026-09-15T00:00:00Z", approved_at: null, invitation_sent_at: null, hasAccount: false },
  { id: "r2", name: "Sam Ray", email: "sam@example.com", use_case: "Tours", created_at: "2026-09-14T00:00:00Z", approved_at: "2026-09-14T01:00:00Z", invitation_sent_at: "2026-09-14T01:00:01Z", hasAccount: false },
];
// Approved, but that address could already sign in: nothing was reserved, so
// there is nothing to send.
const HAS_ACCOUNT = { id: "r3", name: "Pat Lee", email: "pat@example.com", use_case: "Tours", created_at: "2026-09-13T00:00:00Z", approved_at: "2026-09-13T01:00:00Z", invitation_sent_at: null, hasAccount: true };

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://sendset.io/invites", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: reply.ok, status: reply.ok ? 200 : 404, json: async () => reply.body };
  }) as unknown as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as { AppRouterContext: React.Context<unknown> });
  ({ InviteRequestList } = await import("../components/invite-request-list.tsx"));
  ({ AcceptInvitation } = await import("../components/accept-invitation.tsx"));
});
after(() => dom.window.close());

async function mount(element: React.ReactElement) {
  calls.length = 0; pushed.length = 0;
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER }, element)); });
  return { host, root };
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });

test("a pending request offers Approve & send invite; an approved one offers Send again", async () => {
  reply = { ok: true, body: { status: "approved", sent: true, message: "Approved — invitation sent." } };
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: ROWS as never }));
  assert.ok(button(host, "Approve & send invite"), "the pending request has no approve action");
  assert.ok(button(host, "Send again"), "the approved request has no resend action");
  assert.equal([...host.querySelectorAll("button")].length, 2, "one action per request");
  await click(button(host, "Approve & send invite")!);
  assert.deepEqual(calls, [{ url: "/api/invites/approve", body: { requestId: "r1" } }]);
  assert.match(host.textContent!, /Approved — invitation sent\./);
  // After approving, that row offers only the deliberate resend.
  assert.equal(button(host, "Approve & send invite"), undefined);
  assert.equal([...host.querySelectorAll("button")].filter((b) => b.textContent === "Send again").length, 2);
  root.unmount();
});

test("an impatient double click approves once", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    await held;
    return { ok: true, status: 200, json: async () => ({ status: "approved", sent: true, message: "Approved — invitation sent." }) };
  };
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: ROWS as never }));
  const approve = button(host, "Approve & send invite")!;
  await click(approve); await click(approve); await click(approve);
  assert.equal(calls.length, 1, "a repeated click sent another approval");
  assert.ok((button(host, "Sending…") as HTMLButtonElement).disabled);
  await act(async () => { release(); await Promise.resolve(); });
  root.unmount();
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: reply.ok, status: reply.ok ? 200 : 404, json: async () => reply.body };
  };
});

test("an approved request whose address already has an account offers nothing to send", async () => {
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: [HAS_ACCOUNT] as never }));
  assert.match(host.textContent!, /Already has an account/);
  assert.equal(button(host, "Send again"), undefined, "an account holder was offered an invitation");
  assert.equal(button(host, "Approve & send invite"), undefined);
  assert.equal([...host.querySelectorAll("button")].length, 0, "an approved account holder needs no action at all");
  assert.doesNotMatch(host.textContent!, /not sent|invitation sent/, "it must not claim anything about an invitation");
  root.unmount();
});

test("approving an address that already has an account flips it to that state, with no action", async () => {
  reply = { ok: true, body: { status: "has_account", message: "That address can already sign in — no invitation needed." } };
  const pendingHolder = { ...HAS_ACCOUNT, id: "r4", approved_at: null, hasAccount: false };
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: [pendingHolder] as never }));
  await click(button(host, "Approve & send invite")!);
  assert.match(host.textContent!, /Already has an account/);
  assert.equal(button(host, "Send again"), undefined, "the answer said no invitation was needed, yet one is offered");
  assert.match(host.querySelector('[role="status"]')!.textContent!, /can already sign in/);
  root.unmount();
});

test("Send again sends again, and says so", async () => {
  reply = { ok: true, body: { status: "resent", sent: true, message: "Invitation sent again." } };
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: [ROWS[1]] as never }));
  await click(button(host, "Send again")!);
  assert.deepEqual(calls, [{ url: "/api/invites/resend", body: { requestId: "r2" } }]);
  assert.match(host.textContent!, /Invitation sent again\./);
  root.unmount();
});

test("a refused action says what happened and leaves the request as it was", async () => {
  reply = { ok: false, body: { error: "approve_failed" } };
  const { host, root } = await mount(React.createElement(InviteRequestList, { rows: [ROWS[0]] as never }));
  await click(button(host, "Approve & send invite")!);
  assert.match(host.querySelector('[role="status"]')!.textContent!, /didn't work/);
  assert.ok(button(host, "Approve & send invite"), "a failed approval must stay retryable");
  root.unmount();
});

test("Get started accepts once and lands on the dashboard", async () => {
  reply = { ok: true, body: { ok: true, created: true } };
  const { host, root } = await mount(React.createElement(AcceptInvitation, { token: "tok-123" }));
  const get = button(host, "Get started")!;
  await click(get); await click(get);
  assert.equal(calls.length, 1, "a second click accepted twice");
  assert.deepEqual(calls[0], { url: "/api/auth/accept-invitation", body: { token: "tok-123" } });
  assert.deepEqual(pushed, ["/dashboard"]);
  root.unmount();
});

test("an expired invitation explains itself and points at sign-in", async () => {
  reply = { ok: false, body: { error: "expired", message: "This invitation link has expired. Go to the sign-in page and use the same email address this invitation was sent to." } };
  const { host, root } = await mount(React.createElement(AcceptInvitation, { token: "tok-old" }));
  await click(button(host, "Get started")!);
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /expired[\s\S]*same email address this invitation was sent to/);
  assert.equal(host.querySelector("a")!.getAttribute("href"), "/login");
  assert.deepEqual(pushed, [], "a refusal must not navigate");
  assert.ok(button(host, "Get started"), "the button comes back for a retry");
  root.unmount();
});
