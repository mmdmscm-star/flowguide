// The editor's publish controls, clicked the way an impatient person clicks.
//
// The reported sequence: Publish felt slow, so it was clicked again and again;
// the request finished, the same slot turned into Unpublish, and one of the
// remaining clicks took the new Sendset offline. These tests drive the real
// hook and component in a DOM and assert that cannot happen.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let mod: typeof import("../components/editor/publish-controls.tsx");

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/edit/p1", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
  mod = await import("../components/editor/publish-controls.tsx");
});

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

/** Mounts the real controls with the real hook, as the editor does. */
async function mount(initialStatus: "draft" | "published", opts: { confirm?: () => boolean } = {}) {
  const calls = { publish: 0, unpublish: 0, confirm: 0 };
  const pending = { publish: [] as Deferred<"navigating" | "stayed">[], unpublish: [] as Deferred<boolean>[] };
  let setStatus!: (s: string) => void;
  function Harness() {
    const [status, set] = React.useState<string>(initialStatus);
    setStatus = set;
    const t = mod.usePublishTransitions({
      publish: () => { calls.publish++; const d = deferred<"navigating" | "stayed">(); pending.publish.push(d); return d.promise; },
      unpublish: () => { calls.unpublish++; const d = deferred<boolean>(); pending.unpublish.push(d); return d.promise; },
      confirmUnpublish: () => { calls.confirm++; return opts.confirm ? opts.confirm() : true; },
    });
    return React.createElement(mod.PublishControls, {
      status, phase: t.phase, copiedLink: false,
      onPublish: t.startPublish, onUnpublish: t.startUnpublish, onCopyLink: () => {},
    });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness)); });
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (label: string) => buttons().find((b) => b.textContent === label);
  // Click the way a mouse does: dispatched at whatever is in the slot now.
  const clickSlot = () => { const b = buttons().at(-1)!; b.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); };
  return { calls, pending, buttons, button, clickSlot, setStatus: (s: string) => setStatus(s), root };
}

test("five fast clicks on Publish send ONE publish and show Publishing… at once", async () => {
  const h = await mount("draft");
  await act(async () => { for (let i = 0; i < 5; i++) h.clickSlot(); });
  assert.equal(h.calls.publish, 1, "a repeated click started another publish");
  const busy = h.button("Publishing…");
  assert.ok(busy && busy.disabled && busy.getAttribute("aria-busy") === "true", "no disabled, announced Publishing… state");
  await act(async () => { for (let i = 0; i < 5; i++) h.clickSlot(); });
  assert.equal(h.calls.publish, 1, "clicks on the busy control started another publish");
  h.root.unmount();
});

test("when publish completes, the slot does not become Unpublish under a still-clicking pointer", async () => {
  const h = await mount("draft");
  await act(async () => { h.clickSlot(); });
  await act(async () => {
    h.setStatus("published");                       // even if the status arrives
    h.pending.publish[0].resolve("navigating");     // and the request completes
  });
  assert.equal(h.button("Unpublish"), undefined, "Unpublish appeared in the slot while the editor was leaving");
  const done = h.button("Published");
  assert.ok(done && done.disabled, "the finished publish is not an inert Published");
  await act(async () => { for (let i = 0; i < 10; i++) h.clickSlot(); });
  assert.equal(h.calls.unpublish, 0, "a queued click unpublished the Sendset");
  assert.equal(h.calls.confirm, 0, "a queued click even reached the unpublish confirmation");
  assert.equal(h.calls.publish, 1);
  h.root.unmount();
});

test("a publish that stays (refused, cancelled) releases the control for a deliberate retry", async () => {
  const h = await mount("draft");
  await act(async () => { h.clickSlot(); });
  await act(async () => { h.pending.publish[0].resolve("stayed"); });
  const again = h.button("Publish");
  assert.ok(again && !again.disabled, "a refused publish left the control stuck");
  await act(async () => { h.clickSlot(); });
  assert.equal(h.calls.publish, 2);
  h.root.unmount();
});

test("Unpublish asks first; declining does nothing", async () => {
  const h = await mount("published", { confirm: () => false });
  await act(async () => { h.button("Unpublish")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.unpublish, 0, "unpublished without confirmation");
  assert.ok(h.button("Unpublish") && !h.button("Unpublish")!.disabled, "declining left the control stuck");
  h.root.unmount();
});

test("confirmed Unpublish sends once, then holds an inert Unpublished before Publish returns", async () => {
  const h = await mount("published");
  await act(async () => { for (let i = 0; i < 5; i++) h.clickSlot(); });
  assert.equal(h.calls.unpublish, 1, "repeated clicks sent more than one unpublish");
  assert.equal(h.calls.confirm, 1, "repeated clicks asked more than once");
  assert.ok(h.button("Unpublishing…")?.disabled);
  await act(async () => { h.setStatus("draft"); h.pending.unpublish[0].resolve(true); });
  assert.equal(h.button("Publish"), undefined, "Publish appeared under the pointer the moment unpublish finished");
  assert.ok(h.button("Unpublished")?.disabled);
  await act(async () => { for (let i = 0; i < 5; i++) h.clickSlot(); });
  assert.equal(h.calls.publish, 0, "a queued click republished");
  await act(async () => { await new Promise((r) => setTimeout(r, mod.REARM_AFTER_UNPUBLISH_MS + 50)); });
  const pub = h.button("Publish");
  assert.ok(pub && !pub.disabled, "Publish never came back");
  h.root.unmount();
});

test("a failed unpublish returns to Unpublish, still live", async () => {
  const h = await mount("published");
  await act(async () => { h.clickSlot(); });
  await act(async () => { h.pending.unpublish[0].resolve(false); });
  assert.ok(h.button("Unpublish") && !h.button("Unpublish")!.disabled);
  h.root.unmount();
});

test("the confirmation says what unpublishing does, and that it can be undone", () => {
  assert.equal(mod.UNPUBLISH_CONFIRM, "Unpublish this Sendset? Its shared link will stop working until you publish it again.");
});

// ---------------------------------------------------------------------------
// Wiring: every surface that can publish or unpublish.
// ---------------------------------------------------------------------------
const codeOf = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the editor bar renders PublishControls and has no Publish/Unpublish buttons of its own", () => {
  const editor = codeOf("src/components/editor/legacy-packet-editor.tsx");
  assert.match(editor, /<PublishControls[\s\S]{0,300}onPublish=\{publishTransitions\.startPublish\}[\s\S]{0,120}onUnpublish=\{publishTransitions\.startUnpublish\}/);
  assert.match(editor, /confirmUnpublish: \(\) => confirm\(UNPUBLISH_CONFIRM\)/);
  assert.doesNotMatch(editor, />\s*Unpublish\s*</, "a second Unpublish button exists in the editor");
  assert.doesNotMatch(editor, /onClick=\{\(\) => publishPacket\(/, "a Publish button bypasses the transition guard");
  assert.doesNotMatch(editor, /setPacket\(\(prev\) => prev \? \{ \.\.\.prev, status: "published" \}/,
    "the editor flips to published locally before leaving, re-rendering Unpublish under the pointer");
  const fn = editor.slice(editor.indexOf("async function unpublishPacket()"));
  assert.doesNotMatch(fn.slice(0, 600), /confirm\(/, "the request asks again, so two dialogs could stack");
});

test("the Preview publish button refuses a second start before it re-renders", () => {
  const preview = codeOf("src/components/preview-actions.tsx");
  assert.match(preview, /if \(publishInFlight\.current\) return;/);
  assert.match(preview, /onClick=\{startPublish\} disabled=\{publishing\}/);
});

test("no other surface offers Publish or Unpublish", () => {
  const files = ["src/components/dashboard/dashboard-workspace.tsx", "src/components/editor/block-packet-editor.tsx"];
  for (const f of files) {
    const code = codeOf(f);
    assert.doesNotMatch(code, /action: "(publish|unpublish)"/, `${f} sends a publish action`);
  }
});
