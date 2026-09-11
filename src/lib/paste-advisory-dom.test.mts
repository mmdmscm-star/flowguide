// THE ADVISORY MUST BE ANSWERED, NOT MERELY SEEN.
//
// A warning that sits on screen while the submit button still works is
// decoration that happens to be true. Once the two clipboard readings
// contradict each other, creating a draft waits for the professional to say
// which way they want it — either answer will do, and neither is pushed.
//
// Both halves are asserted: the disabled control AND the handler behind it. A
// control can be stale; a handler cannot. This file follows the same rule the
// picture-settling guard in the same component already states about itself.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Workspace: React.ComponentType;
let host: HTMLElement;
/** Every non-GET the page makes. Creating a draft is a POST; if one appears
 *  while the advisory is unanswered, the gate leaked. */
let writes: string[] = [];

const ROWS: Array<[string, string]> = [
  ["Taco Carne Asada", "$4.93"], ["Regular Burrito", "$15.08"],
  ["Taco Carnitas", "$4.64"], ["#5. Enchiladas Combo", "$17.98"],
  ["Taco Pollo Asado", "$4.64"], ["Taco", "$5.80"],
];
/** The real page's shape: the price written before the name, floated right. */
const HTML = ROWS.map(([n, p]) =>
  `<div class="media"><span class="pull-right">${p}</span>` +
  `<h4 class="media-heading">${n}</h4><div class="text-sm">About ${n}.</div></div>`).join("");
/** Its flattening: each name, its description, then the NEXT row's price. */
const PLAIN = ROWS.flatMap(([n], i) =>
  [n, `About ${n}.`, ROWS[i + 1]?.[1] ?? ""]).filter(Boolean).join("\n");
/** A paste with nothing wrong with it. */
const CLEAN_PLAIN = ROWS.flatMap(([n, p]) => [n, p, `About ${n}.`]).join("\n");
const CLEAN_HTML = ROWS.map(([n, p]) =>
  `<div class="row"><h4>${n}</h4><span>${p}</span><div>About ${n}.</div></div>`).join("");

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/new", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  g.DOMParser = dom.window.DOMParser;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  // getter-only on modern Node, like navigator: define, do not assign.
  Object.defineProperty(g, "crypto",
    { value: { randomUUID: () => "test-key" }, configurable: true });
  g.fetch = (async (url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") !== "GET") writes.push(String(url));
    return { ok: true, status: 200, json: async () => ({ packetId: "p", runId: "r", packet: { id: "p" } }) } as Response;
  }) as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  const ctx = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  const routerCtx = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  Workspace = (await import("../components/new/new-packet-workspace.tsx")).default as never;
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };
  (globalThis as Record<string, unknown>).__wrap = (el: unknown) =>
    React.createElement(routerCtx.AppRouterContext.Provider, { value: router as never },
      React.createElement(ctx.SearchParamsContext.Provider, { value: new URLSearchParams() as never },
        React.createElement(ctx.PathnameContext.Provider, { value: "/new" as never }, el as never)));
});

beforeEach(async () => {
  writes = [];
  host = dom.window.document.getElementById("root")! as unknown as HTMLElement;
  host.innerHTML = "";
  const root = createRoot(host as unknown as Element);
  const wrap = (globalThis as Record<string, unknown>).__wrap as (e: unknown) => unknown;
  await act(async () => { root.render(wrap(React.createElement(Workspace)) as never); });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
});

async function paste(html: string, plain: string) {
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  const ev = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData",
    { value: { getData: (t: string) => (t === "text/html" ? html : t === "text/plain" ? plain : "") } });
  await act(async () => { ta.dispatchEvent(ev); });
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(ta, plain); ta.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

const btn = (re: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()));
const click = async (el: Element | undefined) => {
  assert.ok(el, "control not found");
  await act(async () => { el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
};

/** Force the control live and press it. Removing the ATTRIBUTE is not enough on
 *  its own — the DOM property is what suppresses the click — so both go. */
async function pressAnyway(b: HTMLButtonElement) {
  b.removeAttribute("disabled");
  (b as { disabled: boolean }).disabled = false;
  await click(b);
}

test("A CLICK REALLY DOES IMPORT — the control for every 'nothing happened' below", async () => {
  // Without this, "no write occurred" proves only that the test failed to press
  // anything. It is the positive half of the gate.
  await paste(CLEAN_HTML, CLEAN_PLAIN);
  await pressAnyway(btn(/^Create first draft$/)! as HTMLButtonElement);
  assert.ok(writes.some((w) => /\/api\/ingest\/organize/.test(w)),
    `pressing Create did not start an import: ${JSON.stringify(writes)}`);
});

test("while the advisory stands, no import can start", async () => {
  await paste(HTML, PLAIN);
  assert.match(host.textContent ?? "", /may not line up/, "the advisory did not appear");
  const create = btn(/^Create first draft$/)! as HTMLButtonElement;
  assert.equal(create.hasAttribute("disabled"), true, "the control is still live");
  // Pressed anyway, hard. Note what this does and does NOT prove: React
  // suppresses events on a control whose PROPS say disabled, so forcing the DOM
  // attribute and property does not get past it. This therefore proves the
  // enforced path — the control — and cannot reach the handler behind it. The
  // handler's own refusal is asserted structurally below, because there is no
  // state in which the UI offers a live button with the advisory standing.
  await pressAnyway(create);
  assert.deepEqual(writes, [], `an import ran with the advisory unanswered: ${writes.join(", ")}`);
});

test("...and the handler refuses too, so a stale control cannot let one through", () => {
  // Belt and braces, stated the way this component already states it about
  // pictures: "a control can be stale, a handler cannot". Structural because
  // the DOM cannot reach it (see above) — it catches the guard being deleted,
  // which is the realistic regression.
  const src = readFileSync(join(ROOT, "src/components/new/new-packet-workspace.tsx"), "utf8");
  const handler = src.slice(src.indexOf("async function handleOrganize"),
                            src.indexOf("async function handleStartBlank"));
  assert.match(handler, /if \(pairingWarning\)/,
    "handleOrganize no longer refuses while the advisory is unanswered");
  assert.match(handler, /return;/, "the refusal does not stop the import");
});

test("“Use it as pasted” answers it, and the text is untouched", async () => {
  await paste(HTML, PLAIN);
  await click(btn(/Use it as pasted/));
  assert.doesNotMatch(host.textContent ?? "", /may not line up/, "the advisory survived the answer");
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(ta.value, PLAIN, "answering the advisory changed the pasted text");
  assert.equal(btn(/^Create first draft$/)!.hasAttribute("disabled"), false, "still blocked after answering");
});

test("“Clear and re-copy” answers it by emptying the box", async () => {
  await paste(HTML, PLAIN);
  await click(btn(/Clear and re-copy/));
  assert.doesNotMatch(host.textContent ?? "", /may not line up/, "the advisory survived the answer");
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(ta.value, "", "the box was not cleared");
});

test("AN ORDINARY PASTE IS NEVER GATED", async () => {
  await paste(CLEAN_HTML, CLEAN_PLAIN);
  assert.doesNotMatch(host.textContent ?? "", /may not line up/, "a clean paste was warned about");
  assert.equal(btn(/^Create first draft$/)!.hasAttribute("disabled"), false,
    "a clean paste was blocked");
});

test("Start blank instead is NOT gated — it ignores the pasted text", async () => {
  await paste(HTML, PLAIN);
  const blank = btn(/Start blank instead/)!;
  assert.equal(blank.hasAttribute("disabled"), false, "the way out was blocked too");
});
