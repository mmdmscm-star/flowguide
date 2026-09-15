// The two early-access forms, in a DOM: what they send, what they show, and
// what they never put in a URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let AppRouterContext: React.Context<unknown>;
let JoinForm: React.ComponentType;
let EarlyAccessForm: React.ComponentType;

type Call = { url: string; method?: string; body?: unknown };
const calls: Call[] = [];
const pushed: string[] = [];
let reply: { ok: boolean; body: unknown } = { ok: true, body: { ok: true } };
const ROUTER = { push: (to: string) => { pushed.push(to); }, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {} };

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://sendset.io/join", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: reply.ok, status: reply.ok ? 200 : 403, json: async () => reply.body };
  }) as unknown as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as { AppRouterContext: React.Context<unknown> });
  JoinForm = (await import("../components/join-form.tsx")).JoinForm;
  EarlyAccessForm = (await import("../components/early-access-form.tsx")).EarlyAccessForm;
});
after(() => dom.window.close());

async function mount(Component: React.ComponentType) {
  calls.length = 0; pushed.length = 0;
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER }, React.createElement(Component))); });
  return { host, root };
}
const type = (el: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
const submit = (host: HTMLElement) => act(async () => {
  host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
});
const alertText = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? "";

// ---------------------------------------------------------------------------
test("the invite code is sent in the request body, and the dashboard follows", async () => {
  reply = { ok: true, body: { ok: true, created: true } };
  const { host, root } = await mount(JoinForm);
  await type(host.querySelector("#invite-code")!, "htg4m 9xq2k 7vpzb 3ndr6");
  await submit(host);
  assert.deepEqual(calls, [{ url: "/api/auth/redeem-invite", method: "POST", body: { code: "htg4m 9xq2k 7vpzb 3ndr6" } }]);
  assert.doesNotMatch(calls[0].url, /code|htg4m/i, "the code must never travel in a URL");
  assert.deepEqual(pushed, ["/dashboard"]);
  root.unmount();
});

test("a refused code is shown as the server said it, and can be corrected", async () => {
  reply = { ok: false, body: { error: "invite_invalid", message: "That invite code isn't valid." } };
  const { host, root } = await mount(JoinForm);
  await type(host.querySelector("#invite-code")!, "WRONG-WRONG-WRONG-WRON");
  await submit(host);
  assert.equal(alertText(host), "That invite code isn't valid.");
  assert.deepEqual(pushed, [], "a refusal must not navigate");
  reply = { ok: true, body: { ok: true } };
  await submit(host);
  assert.equal(calls.length, 2, "the form must stay usable after a refusal");
  assert.deepEqual(pushed, ["/dashboard"]);
  root.unmount();
});

test("an impatient double submit sends one redemption", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    await held;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const { host, root } = await mount(JoinForm);
  await type(host.querySelector("#invite-code")!, "HTG4M-9XQ2K-7VPZB-3NDR6");
  await submit(host);
  await submit(host);
  await submit(host);
  assert.equal(calls.length, 1);
  assert.ok((host.querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the button stays live during the check");
  await act(async () => { release(); await Promise.resolve(); });
  root.unmount();
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: reply.ok, status: reply.ok ? 200 : 403, json: async () => reply.body };
  };
});

test("the request form sends name, email and use case, then thanks the person", async () => {
  reply = { ok: true, body: { ok: true, message: "Thank you — your request is in. I read these myself and will be in touch." } };
  const { host, root } = await mount(EarlyAccessForm);
  await type(host.querySelector("#ea-name")!, "Jane Doe");
  await type(host.querySelector("#ea-email")!, "jane@example.com");
  await type(host.querySelector("#ea-use")!, "Sending venue options to families.");
  await submit(host);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/early-access");
  assert.deepEqual(calls[0].body, { name: "Jane Doe", email: "jane@example.com", useCase: "Sending venue options to families.", website: "" });
  assert.match(host.textContent!, /Thank you — your request is in\./);
  assert.equal(host.querySelector("form"), null, "the form is replaced by the answer");
  root.unmount();
});

test("the honeypot is hidden from people and from assistive technology", async () => {
  const { host, root } = await mount(EarlyAccessForm);
  const pot = host.querySelector("#ea-website")!;
  assert.ok(pot, "the honeypot field is gone");
  assert.equal((pot as HTMLInputElement).value, "", "a person is never asked to fill it");
  assert.equal(pot.getAttribute("tabindex"), "-1");
  const wrapper = pot.closest("[aria-hidden]");
  assert.ok(wrapper && /left-\[-9999px\]/.test(wrapper.className), "it must be off-screen and aria-hidden");
  root.unmount();
});

test("a refused request keeps what was typed and says why", async () => {
  reply = { ok: false, body: { error: "rate_limited", message: "You've already sent a request — I have it, and I'll be in touch." } };
  const { host, root } = await mount(EarlyAccessForm);
  await type(host.querySelector("#ea-name")!, "Jane");
  await type(host.querySelector("#ea-email")!, "jane@example.com");
  await type(host.querySelector("#ea-use")!, "Venues");
  await submit(host);
  assert.match(alertText(host), /already sent a request/);
  assert.equal((host.querySelector("#ea-use") as HTMLTextAreaElement).value, "Venues", "the answer they wrote was thrown away");
  root.unmount();
});
