// A BLOCKED PUBLISH MUST LAND SOMEWHERE YOU CAN ACT.
//
// Publishing from the editor with a photo the source puts on another item
// returned 409 `ownership_unresolved`. The editor turned that into a red
// banner at the top of the page — a sentence naming a problem, on the one
// surface with nothing to press about it. The panel that can actually resolve
// it already existed, on Preview.
//
// So the editor hands over instead of growing a second copy of that panel, and
// the reason travels in the URL so the arrival explains itself. Three things
// have to hold, and the middle one is the one that would rot silently:
//   1. the 409 routes to Preview carrying the reason,
//   2. Preview, GIVEN that reason, FETCHES and RENDERS the findings on arrival,
//   3. and without it nothing changes for everybody else.
//
// (2) is asserted against the mounted component, not its source, because
// "the prop is threaded" and "the professional sees the findings" are
// different claims and only the second one is the fix.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const EDITOR = "src/components/editor/legacy-packet-editor.tsx";
const PAGE = "src/app/preview/[id]/page.tsx";

/** The one code the panel treats as blocking, spelled the way the server
 *  spells it. A fixture using any other code renders the advisory styling and
 *  would pass a laxer assertion while proving nothing. */
const BLOCKING = [{
  code: "media_on_wrong_record",
  url: "https://cdn.example/a.jpg",
  itemId: "i1", itemTitle: "Fountaingrove Lodge",
  proposedItemId: "i2", proposedItemTitle: "Oakmont Gardens",
  detail: "This photo appears in the source under Oakmont Gardens.",
  actions: ["move", "keep"] as Array<"move" | "keep">,
}];

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Share: React.ComponentType<Record<string, unknown>>;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/preview/p1", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Element = dom.window.Element;
  g.Node = dom.window.Node; g.MouseEvent = dom.window.MouseEvent;
  g.getComputedStyle = dom.window.getComputedStyle;
  // getter-only on modern Node: define, do not assign.
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  g.self = g; g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  Share = (await import("../components/preview-actions.tsx")).PreviewActions as never;
});

/** Mount the share step the way the page does, and report what the
 *  professional is looking at a moment after arriving. */
async function arrive(resolveOwnership: boolean) {
  const calls: string[] = [];
  (globalThis as Record<string, unknown>).fetch = (async (url: string) => {
    calls.push(String(url));
    return String(url).endsWith("/ownership")
      ? { ok: true, status: 200,
          json: async () => ({ findings: BLOCKING, blockingCount: 1, kept: [], checked: true }) } as Response
      : { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  // A fresh container each time: React holds onto a root by element, and
  // reusing one would mean the second arrival re-renders the first mount.
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  await act(async () => {
    createRoot(host as unknown as Element).render(React.createElement(Share, {
      packetId: "p1", slug: "s", initialStatus: "draft",
      title: "T", clientName: "C", professionalName: "P", resolveOwnership,
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  return {
    calls,
    text: host.textContent ?? "",
    buttons: [...host.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? ""),
  };
}

test("A BLOCKED PUBLISH LEAVES THE EDITOR FOR THE PLACE THAT CAN FIX IT", () => {
  const editor = codeOf(EDITOR);
  const at = editor.indexOf('data.error === "ownership_unresolved"');
  assert.ok(at >= 0, "the editor no longer recognises the blocked-publish response");
  const branch = editor.slice(at, at + 400);
  assert.match(branch, /router\.push\(`\/preview\/\$\{packetId\}\?resolve=photos`\)/,
    "a blocked publish does not hand over to the share step with its reason");
  // It must LEAVE, not navigate and also set the banner it replaced.
  assert.match(branch, /return;/, "the blocked-publish branch falls through to the banner");
});

test("...AND THE GENERIC BANNER NO LONGER SPEAKS FOR IT", () => {
  const editor = codeOf(EDITOR);
  const push = editor.indexOf("?resolve=photos");
  const banner = editor.indexOf("setPublishError(errMsg)");
  assert.ok(push >= 0 && banner > push,
    "the banner runs before the handover, so the dead end is still reachable");
  // The 503 deliberately still uses the banner: there is no panel to draw for a
  // check that could not run, and the server's retry sentence IS actionable.
  // Pinning that keeps a later cleanup from routing it here too, where the
  // professional would find an empty panel reading as a clean bill of health.
  assert.doesNotMatch(editor, /ownership_unavailable[\s\S]{0,300}?router\.push/,
    "an unavailable CHECK now routes to a panel that has nothing to show");
});

test("THE REASON IS READ AT PREVIEW, not merely written by the editor", () => {
  const page = codeOf(PAGE);
  assert.match(page, /sp\.resolve === "photos"/,
    "Preview does not read the reason the editor sends, so the handover is inert");
  assert.match(page, /resolveOwnership=\{/, "the share step is never told");
});

test("ARRIVING THAT WAY SHOWS THE FINDINGS, ALREADY ACTIONABLE", async () => {
  const { calls, text, buttons } = await arrive(true);
  assert.ok(calls.some((u) => u.endsWith("/packets/p1/ownership")),
    "Preview never asked what was blocking the publish");
  // Presented as BLOCKING, not as "worth a look" — the panel picks its wording
  // from the finding's code, so a fixture drift would show up right here.
  assert.match(text, /Check this photo before publishing/,
    "the finding is shown, but not as the thing that stopped the publish");
  assert.ok(buttons.some((b) => /^Move to /.test(b)) && buttons.includes("Keep here"),
    `no way out of the block; buttons were ${JSON.stringify(buttons)}`);
});

test("...AND ARRIVING ANY OTHER WAY IS UNCHANGED", async () => {
  const { calls, text } = await arrive(false);
  assert.deepEqual(calls, [],
    "every visit to Preview now runs a photo check nobody asked for");
  assert.doesNotMatch(text, /before publishing/,
    "the resolution panel appears without the reason that justifies it");
  // A positive control: the same mount DOES render the share step, so the
  // absence above is a real absence and not a component that failed to mount.
  assert.match(text, /Publish/, "the share step did not render at all");
});
