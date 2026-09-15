// Republish and the publication state, in a DOM, clicked impatiently.
//
// A published Sendset with saved changes shows "Saved · Changes not published"
// and a primary Republish. These drive the real controls, the real hook against
// a fake server, and check the wiring in the editors and on Preview.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let controls: typeof import("../components/editor/publish-controls.tsx");
let pubState: typeof import("../components/editor/publication-state.tsx");

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://flowguide.test/edit/p1", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent; g.CustomEvent = dom.window.CustomEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
  controls = await import("../components/editor/publish-controls.tsx");
  pubState = await import("../components/editor/publication-state.tsx");
});

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const click = (b: Element) => b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

async function mountControls(publication: "unknown" | "current" | "changed") {
  const calls = { republish: 0, unpublish: 0 };
  const pending: Deferred<"republished" | "navigating" | "stayed">[] = [];
  let setPublication!: (v: "unknown" | "current" | "changed") => void;
  function Harness() {
    const [pub, set] = React.useState(publication);
    setPublication = set;
    const t = controls.usePublishTransitions({
      publish: async () => "stayed",
      unpublish: async () => { calls.unpublish++; return false; },
      confirmUnpublish: () => true,
      republish: () => { calls.republish++; const d = deferred<"republished" | "navigating" | "stayed">(); pending.push(d); return d.promise; },
    });
    return React.createElement(controls.PublishControls, {
      status: "published", phase: t.phase, copiedLink: false, publication: pub,
      onPublish: t.startPublish, onUnpublish: t.startUnpublish, onCopyLink: () => {}, onRepublish: t.startRepublish,
    });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness)); });
  const labels = () => [...host.querySelectorAll("button")].map((b) => `${b.textContent}${b.disabled ? " (disabled)" : ""}`);
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  const firstSlot = () => host.querySelector("button")!;
  return { calls, pending, labels, button, firstSlot, root, setPublication: (v: "unknown" | "current" | "changed") => setPublication(v) };
}

test("Published with nothing unpublished: no Republish", async () => {
  for (const view of ["current", "unknown"] as const) {
    const h = await mountControls(view);
    assert.deepEqual(h.labels(), ["Copy link", "Unpublish"], `${view}: offered a Republish it cannot justify`);
    h.root.unmount();
  }
});

test("Changes not published: Republish comes first, beside Copy link and Unpublish", async () => {
  const h = await mountControls("changed");
  assert.deepEqual(h.labels(), ["Republish", "Copy link", "Unpublish"]);
  h.root.unmount();
});

test("five fast clicks on Republish send ONE, and the slot never turns into another action under the pointer", async () => {
  const h = await mountControls("changed");
  await act(async () => { for (let i = 0; i < 5; i++) click(h.firstSlot()); });
  assert.equal(h.calls.republish, 1);
  assert.deepEqual(h.labels(), ["Republishing… (disabled)"]);
  await act(async () => { h.setPublication("current"); h.pending[0].resolve("republished"); });
  assert.deepEqual(h.labels(), ["Republished (disabled)"], "Copy link or Unpublish slid into the slot at once");
  await act(async () => { for (let i = 0; i < 10; i++) click(h.firstSlot()); });
  assert.equal(h.calls.unpublish, 0);
  assert.equal(h.calls.republish, 1);
  await act(async () => { await sleep(controls.REARM_AFTER_UNPUBLISH_MS + 50); });
  assert.deepEqual(h.labels(), ["Copy link", "Unpublish"], "after the hold the bar shows the current state");
  h.root.unmount();
});

test("a refused republish returns to Republish for a deliberate retry", async () => {
  const h = await mountControls("changed");
  await act(async () => { click(h.firstSlot()); });
  await act(async () => { h.pending[0].resolve("stayed"); });
  assert.deepEqual(h.labels(), ["Republish", "Copy link", "Unpublish"]);
  h.root.unmount();
});

test("the save sentence", () => {
  assert.equal(pubState.saveLabel("saving", "published", "changed"), "Saving…");
  assert.equal(pubState.saveLabel("error", "published", "changed"), "Save failed");
  assert.equal(pubState.saveLabel("saved", "published", "changed"), "Saved · Changes not published");
  assert.equal(pubState.saveLabel("saved", "published", "current"), "Saved");
  assert.equal(pubState.saveLabel("saved", "published", "unknown"), "Saved", "an outstanding or failed check claims nothing");
  assert.equal(pubState.saveLabel("saved", "draft", "changed"), "Saved", "a draft has nothing published to differ from");
});

// ---------------------------------------------------------------------------
// The hook against a fake server
// ---------------------------------------------------------------------------
async function mountHook(initialStatus: string, server: (n: number) => Promise<{ ok: boolean; body?: unknown }>) {
  const requests: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    requests.push(url);
    const r = await server(requests.length);
    return { ok: r.ok, json: async () => r.body };
  };
  let setSignal!: (n: number) => void, setStatus!: (s: string) => void;
  let seen: { view: string } = { view: "" };
  function Harness() {
    const [signal, s1] = React.useState(0); setSignal = s1;
    const [status, s2] = React.useState(initialStatus); setStatus = s2;
    seen = pubState.usePublicationState("p1", status, signal);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(React.createElement(Harness)); });
  return { requests, root, view: () => seen.view, save: (n: number) => setSignal(n), status: (s: string) => setStatus(s) };
}
const settle = (ms = 30) => act(async () => { await sleep(ms); });

test("the hook asks once on open, and shows exactly what the server says", async () => {
  const h = await mountHook("published", async () => ({ ok: true, body: { published: true, publication: "changed" } }));
  await settle();
  assert.deepEqual(h.requests, ["/api/packets/p1/publication-state"]);
  assert.equal(h.view(), "changed");
  h.root.unmount();
});

test("a draft never asks", async () => {
  const h = await mountHook("draft", async () => ({ ok: true, body: { published: false } }));
  await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.view(), "unknown");
  h.root.unmount();
});

test("several quick saves ask once, after they settle", async () => {
  let answer = "current";
  const h = await mountHook("published", async () => ({ ok: true, body: { published: true, publication: answer } }));
  await settle();
  answer = "changed";
  await act(async () => { h.save(1); }); await settle(100);
  await act(async () => { h.save(2); }); await settle(100);
  await act(async () => { h.save(3); });
  assert.equal(h.requests.length, 1, "asked before the saves settled");
  await settle(pubState.RECHECK_DELAY_MS + 100);
  assert.equal(h.requests.length, 2);
  assert.equal(h.view(), "changed");
  h.root.unmount();
});

test("a slow earlier answer never overwrites a later one", async () => {
  const first = deferred<{ ok: boolean; body?: unknown }>();
  const h = await mountHook("published", (n) => n === 1 ? first.promise : Promise.resolve({ ok: true, body: { published: true, publication: "current" } }));
  await settle();
  await act(async () => { h.save(1); });
  await settle(pubState.RECHECK_DELAY_MS + 100);
  assert.equal(h.view(), "current");
  await act(async () => { first.resolve({ ok: true, body: { published: true, publication: "changed" } }); });
  await settle();
  assert.equal(h.view(), "current", "a stale 'changed' replaced the newer answer");
  h.root.unmount();
});

test("a failed check claims nothing", async () => {
  const h = await mountHook("published", async () => ({ ok: false, body: { error: "state_unavailable" } }));
  await settle();
  assert.equal(h.view(), "unknown");
  h.root.unmount();
});

test("another surface saying it saved (the style picker) makes it ask again", async () => {
  const h = await mountHook("published", async () => ({ ok: true, body: { published: true, publication: "current" } }));
  await settle();
  await act(async () => { pubState.notifyDraftSaved("other-sendset"); });
  await settle(pubState.RECHECK_DELAY_MS + 100);
  assert.equal(h.requests.length, 1, "a save to a different Sendset triggered a check");
  await act(async () => { pubState.notifyDraftSaved("p1"); });
  await settle(pubState.RECHECK_DELAY_MS + 100);
  assert.equal(h.requests.length, 2);
  h.root.unmount();
});

test("unpublishing drops a 'changed' at once", async () => {
  const h = await mountHook("published", async () => ({ ok: true, body: { published: true, publication: "changed" } }));
  await settle();
  assert.equal(h.view(), "changed");
  await act(async () => { h.status("draft"); });
  assert.equal(h.view(), "unknown");
  h.root.unmount();
});

// ---------------------------------------------------------------------------
// Wiring, autosave and guards
// ---------------------------------------------------------------------------
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/[^\n]*/g, "");

test("legacy editor: the bar says it, the bottom bar republishes, and republish stays in the editor", () => {
  const e = code("src/components/editor/legacy-packet-editor.tsx");
  assert.match(e, /\{saveLabel\(saveStatus, packet\.status, publication\.view\)\}/);
  assert.match(e, /usePublicationState\(packetId, packet\?\.status \?\? "draft", saveStatus\)/);
  assert.match(e, /publication=\{publication\.view\}\s+onRepublish=\{publishTransitions\.startRepublish\}/);
  const fn = e.slice(e.indexOf("async function republishPacket("), e.indexOf("const publication = usePublicationState"));
  assert.ok(fn.length > 100, "republishPacket not found");
  assert.doesNotMatch(fn, /router\.push/, "a republish must not leave the editor");
  assert.match(fn, /publication\.refresh\(0\)/);
  assert.match(fn, /return "republished"/);
});

test("autosave is preserved and no manual Save button exists", () => {
  for (const f of ["src/components/editor/legacy-packet-editor.tsx", "src/components/editor/block-packet-editor.tsx",
                   "src/components/editor/publish-controls.tsx", "src/components/preview-actions.tsx"]) {
    assert.doesNotMatch(code(f), />\s*Save\s*</, `${f} grew a manual Save button`);
  }
  const e = code("src/components/editor/legacy-packet-editor.tsx");
  assert.ok((e.match(/setSaveStatus\("saving"\)/g) ?? []).length >= 5, "autosave paths were removed");
});

test("block editor: the pill says it and points to Preview; published structure stays locked", () => {
  const b = code("src/components/editor/block-packet-editor.tsx");
  assert.match(b, /const readOnly = status !== "draft";/, "the draft-only block structure guard changed");
  assert.match(b, /"Saved · Changes not published"/);
  assert.match(b, /href=\{`\/preview\/\$\{packetId\}`\}[\s\S]{0,200}Review and republish/);
});

test("Preview: Republish beside the draft it would publish; style choices ask again", () => {
  const a = code("src/components/preview-actions.tsx");
  assert.match(a, /publication\.view === "changed" &&[\s\S]{0,600}You have unpublished changes\.<\/strong> This preview shows your current draft; email and print use the last published version until you republish\.[\s\S]{0,400}onClick=\{startPublish\}[\s\S]{0,120}Republish/);
  assert.match(code("src/components/preview-surface.tsx"), /saveSucceeded\(s, request\.seq\)\); notifyDraftSaved\(packetId\);/);
});

test("the draft-only guards are untouched", () => {
  const own = code("src/app/api/packets/[id]/ownership/route.ts");
  assert.match(own, /if \(packet\.status !== "draft"\)/);
  assert.match(code("src/components/editor/legacy-packet-editor.tsx"), /\{packet\.status === "draft" && \(/, "conversion is still offered only for drafts");
});

test("the unavailable page speaks of a Sendset, neutrally", () => {
  const nf = readFileSync("src/app/p/[slug]/not-found.tsx", "utf8");
  assert.match(nf, />This Sendset is no longer available\.</);
  assert.match(nf, /If you were expecting to see it, contact the person who shared the link\./);
  const visible = nf.replace(/\/\/[^\n]*/g, "").match(/>[^<>{}]+</g)?.join(" ") ?? "";
  assert.doesNotMatch(visible, /packet/i, "the public 404 still says 'packet'");
  assert.doesNotMatch(visible, /not found/i);
});
