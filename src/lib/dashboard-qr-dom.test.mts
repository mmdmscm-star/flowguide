// A published Sendset's QR code, from My Sendsets — without republishing.
//
// Drives the real dashboard in a DOM served from a non-canonical host, with a
// fake server that records every request. Opening the QR code must add no
// request and no navigation: it is the share step's own panel, regenerated in
// the browser from the slug.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let AppRouterContext: React.Context<unknown>;
let Dashboard: React.ComponentType;

const PUB_A = { id: "a1", slug: "harbor-view-7k2", title: "Harbor options", client_name: "the Smiths", status: "published", viewed: false, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-10T00:00:00Z" };
const PUB_B = { id: "b2", slug: "k3x9q2m7p4r8t1v6w5y0za", title: "Venues", client_name: "", status: "published", viewed: true, created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-09T00:00:00Z" };
const DRAFT = { id: "c3", slug: "draft-slug-9zz", title: "Work in progress", client_name: "", status: "draft", viewed: false, created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" };

const requests: string[] = [];
const pushed: string[] = [];
const ROUTER = { push: (to: string) => { pushed.push(to); }, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {} };

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://flowguide-ruddy.vercel.app/dashboard", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string, init?: { method?: string }) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const body = url === "/api/packets" ? { packets: [PUB_A, PUB_B, DRAFT] } : url === "/api/auth/me" ? { user: { email: "pro@example.com" } } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as { AppRouterContext: React.Context<unknown> });
  Dashboard = (await import("../components/dashboard/dashboard-workspace.tsx")).default;
});
after(() => dom.window.close());

async function mount() {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER }, React.createElement(Dashboard))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return { host, root };
}
const rowOf = (host: HTMLElement, title: string) => [...host.querySelectorAll("h3")].find((h) => h.textContent === title)!.closest("div.rounded-\\[var\\(--radius-control\\)\\]") as HTMLElement;
const buttonsIn = (el: Element) => [...el.querySelectorAll("button")].map((b) => b.textContent);
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
const qrButton = (row: HTMLElement) => [...row.querySelectorAll("button")].find((b) => b.textContent === "QR code");

test("published rows offer QR code beside Copy link; drafts do not", async () => {
  const { host, root } = await mount();
  const a = rowOf(host, "Harbor options"), d = rowOf(host, "Work in progress");
  assert.ok(a && d, "fixture rows did not render");
  const actions = buttonsIn(a).filter((t) => ["Edit", "Copy link", "QR code", "Duplicate", "Delete"].includes(t!));
  assert.deepEqual(actions, ["Edit", "Copy link", "QR code", "Duplicate", "Delete"]);
  assert.equal(qrButton(d), undefined, "a draft offered a QR code for a link that does not work yet");
  root.unmount();
});

test("opening it shows the share step's panel for the canonical link — no request, no navigation, nothing written", async () => {
  const { host, root } = await mount();
  const before = requests.length, pushesBefore = pushed.length;
  const a = rowOf(host, "Harbor options");
  await click(qrButton(a)!);
  const img = a.querySelector("img")!;
  assert.ok(img, "the QR panel did not open under its row");
  assert.equal(img.getAttribute("alt"), "QR code that opens https://sendset.io/p/harbor-view-7k2");
  assert.equal(qrButton(a)!.getAttribute("aria-expanded"), "true");
  assert.deepEqual(buttonsIn(a).slice(-3), ["Download PNG", "Download SVG", "Done"], "not the share step's panel");
  assert.doesNotMatch(a.innerHTML, /vercel\.app/);
  assert.equal(requests.length, before, `opening the QR code sent a request: ${requests.slice(before).join(", ")}`);
  assert.equal(pushed.length, pushesBefore, "opening the QR code navigated");
  root.unmount();
});

test("one panel at a time; the button and Done both close it", async () => {
  const { host, root } = await mount();
  const a = rowOf(host, "Harbor options"), b = rowOf(host, "Venues");
  await click(qrButton(a)!);
  await click(qrButton(b)!);
  assert.equal(a.querySelector("img"), null, "the first panel stayed open");
  assert.equal(b.querySelector("img")!.getAttribute("alt"), "QR code that opens https://sendset.io/p/k3x9q2m7p4r8t1v6w5y0za");
  await click(qrButton(b)!);
  assert.equal(b.querySelector("img"), null, "the button did not close its panel");
  await click(qrButton(b)!);
  await click([...b.querySelectorAll("button")].find((x) => x.textContent === "Done")!);
  assert.equal(b.querySelector("img"), null, "Done did not close the panel");
  root.unmount();
});

test("the dashboard reuses the share step's component, which stays on the share step", () => {
  const dash = readFileSync("src/components/dashboard/dashboard-workspace.tsx", "utf8");
  assert.match(dash, /import QrCodePanel from "@\/components\/qr-code-panel";/);
  assert.match(dash, /packet\.status === "published" && qrId === packet\.id && \([\s\S]{0,200}<QrCodePanel slug=\{packet\.slug\} onClose=\{\(\) => setQrId\(null\)\} \/>/);
  assert.match(readFileSync("src/components/preview-actions.tsx", "utf8"), /<QrCodePanel slug=\{slug\} onClose=\{\(\) => setShowQr\(false\)\} \/>/);
});
