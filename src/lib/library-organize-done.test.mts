import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// DONE MEANS DONE — asserted by mounting the real workspace.
//
// The mode is entered through "Select & Organize" now. It was called "Organize"
// until the Library itself became draggable, at which point the name pointed at
// the one place the drag handles are hidden — and then "Select items", which was
// true but never said what the selecting was for.
//
// The panel's actions write immediately. A button labelled "Cancel" therefore
// said something false: by the time it was reachable, the placing and labelling
// and starring had already happened, and nothing about pressing it could take
// them back. A source-shape guard can prove the word changed; only a mounted
// run can prove that leaving does not quietly undo the work, and that the mode
// and its temporary selection are actually gone afterwards.

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Workspace: typeof import("../components/library/library-workspace.tsx").default;
let AppRouterContext: React.Context<unknown>;
let SearchParamsContext: React.Context<unknown>;

const ITEMS = [
  { id: "a-1", title: "Alpha House", address: "1 A St", labels: [] as string[], isFavorite: false,
    updatedAt: "2026-08-28 12:00:02.000000+00", sectionId: null, groupId: null, sortOrder: 0 },
  { id: "b-2", title: "Bravo Manor", address: "2 B St", labels: [] as string[], isFavorite: false,
    updatedAt: "2026-08-28 12:00:01.000000+00", sectionId: null, groupId: null, sortOrder: 0 },
];

/** Every write the panel makes. The point of the test is that pressing Done
 *  adds nothing to this list — no undo, no revert, no delete. */
const writes: Array<{ path: string; method: string; body: unknown }> = [];

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url, "https://flowguide.test");
  const method = init?.method ?? "GET";
  const json = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => b } as unknown as Response);
  if (method !== "GET") writes.push({ path: u.pathname, method, body: JSON.parse(init?.body ?? "{}") });

  if (u.pathname === "/api/library" && method === "GET") {
    return json({ items: ITEMS, hasMore: false, nextCursor: null,
      vocabulary: { labels: [], hasFavorites: false },
      structure: { sections: [], groups: [] } });
  }
  if (u.pathname === "/api/library/bulk") {
    // The server saved it. Reflect that in the fixture, the way the real one would.
    const b = JSON.parse(init?.body ?? "{}") as { ids?: string[]; addLabels?: string[]; favorite?: boolean };
    for (const id of b.ids ?? []) {
      const row = ITEMS.find((r) => r.id === id);
      if (!row) continue;
      if (b.addLabels) row.labels = [...new Set([...row.labels, ...b.addLabels])];
      if (typeof b.favorite === "boolean") row.isFavorite = b.favorite;
    }
    return json({ updated: (b.ids ?? []).length, vocabulary: { labels: ["Preferred"], hasFavorites: true },
      structure: { sections: [], groups: [] } });
  }
  if (u.pathname === "/api/library/browse") {
    return json({ structure: { sections: [], groups: [] }, containers: [],
      unorganized: { sectionId: null, groupId: null, items: ITEMS, total: ITEMS.length, cursor: null, hasMore: false },
      vocabulary: { labels: [], hasFavorites: false } });
  }
  if (u.pathname.startsWith("/api/library/")) return json({ item: {}, usedIn: 0 });
  throw new Error(`unexpected fetch ${url}`);
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/library", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  // Next's client runtime reaches for `self`, and the workspace pulls in
  // next/link through CreatorNav.
  g.self = dom.window;
  g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => fakeFetch(url, init)) as typeof fetch;
  g.confirm = () => true;

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as
    { AppRouterContext: React.Context<unknown> });
  // The workspace reads `?compose=1` to know it was sent here to compose, so
  // the tests supply the same context the App Router always does.
  ({ SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js") as unknown as
    { SearchParamsContext: React.Context<unknown> });
  Workspace = (await import("../components/library/library-workspace.tsx")).default;
});

after(() => dom.window.close());

const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {},
  forward: () => {}, prefetch: async () => {} };

async function mount() {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER },
      React.createElement(SearchParamsContext.Provider, { value: new dom.window.URLSearchParams("") },
        React.createElement(Workspace))));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return host;
}

const byText = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()));
const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

// ---------------------------------------------------------------------------

test("the Select & Organize panel offers DONE, and no Cancel", async () => {
  const host = await mount();
  await click(byText(host, /^Select & Organize$/)!);
  assert.ok(byText(host, /^Done$/), "the organize panel has no Done");
  assert.equal(byText(host, /^Cancel$/), undefined,
    "the organize panel still offers to cancel work it has already saved");
});

test("organization SURVIVES Done — and Done writes nothing at all", async () => {
  writes.length = 0;
  const host = await mount();
  await click(byText(host, /^Select & Organize$/)!);

  // Choose an item and star it. That save happens immediately.
  const box = [...host.querySelectorAll('input[type="checkbox"]')][0] as HTMLInputElement;
  await act(async () => { box.click(); });
  assert.ok((host.textContent ?? "").includes("1 item selected"), "the selection did not register");

  await click(byText(host, /★ Favorite/)!);
  const saved = writes.filter((w) => w.path === "/api/library/bulk");
  assert.equal(saved.length, 1, "the star was not saved");
  assert.deepEqual((saved[0].body as { favorite: boolean }).favorite, true);
  assert.ok((host.textContent ?? "").includes("Organized 1 item"), "no acknowledgement was shown");

  // THE PANEL STAYS OPEN so several things can be filed in a row.
  assert.ok(byText(host, /^Done$/), "a successful action closed the panel");
  assert.ok((host.textContent ?? "").includes("1 item selected"),
    "a successful action dropped the selection, so a second action is impossible");

  // Now leave.
  const before = writes.length;
  await click(byText(host, /^Done$/)!);
  assert.equal(writes.length, before,
    "Done performed a write — it must never undo or revert what was already saved");

  // The mode and the temporary selection are gone...
  assert.equal(byText(host, /^Done$/), undefined, "the organize panel is still open");
  assert.ok(!(host.textContent ?? "").includes("item selected"), "a stale selection survived Done");
  assert.ok(byText(host, /^Select & Organize$/), "the normal Library did not come back");

  // ...and the organization itself is still there.
  assert.equal(ITEMS[0].isFavorite, true, "leaving undid the save");
  const stars = [...host.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "★");
  assert.ok(stars.length >= 1, "the saved favorite is not reflected in the Library");
});

test("Done clears the notice, so it does not linger over the normal Library", async () => {
  const host = await mount();
  await click(byText(host, /^Select & Organize$/)!);
  const box = [...host.querySelectorAll('input[type="checkbox"]')][0] as HTMLInputElement;
  await act(async () => { box.click(); });
  await click(byText(host, /★ Favorite/)!);
  assert.ok((host.textContent ?? "").includes("Organized"), "no acknowledgement to clear");
  await click(byText(host, /^Done$/)!);
  assert.ok(!(host.textContent ?? "").includes("Organized 1 item"),
    "the acknowledgement outlived the panel it belonged to");
});

test("the CREATE experience still says Cancel, because nothing is saved yet", async () => {
  writes.length = 0;
  const host = await mount();
  await click(byText(host, /Create a FlowGuide/)!);
  assert.ok(byText(host, /^Cancel$/), "the create panel lost its Cancel");
  assert.equal(byText(host, /^Done$/), undefined, "the create panel says Done, but nothing is saved yet");

  // THE CHECKBOX IS GONE FROM HERE, and its going is the point: it was a second
  // way to toggle the same pending list, and it made an assembly surface read
  // as the old record picker. Add adds; the tray's × removes.
  assert.equal([...host.querySelectorAll('input[type="checkbox"]')].length, 0,
    "the composition surface still offers selection checkboxes");
  const add = [...host.querySelectorAll("button")]
    .find((b) => /^Add .* to this FlowGuide$/.test(b.getAttribute("aria-label") ?? ""));
  assert.ok(add, "there is no way to add an item without a checkbox");
  await click(add!);
  assert.equal(writes.length, 0, "adding something in the create flow wrote to the server");

  await click(byText(host, /^Cancel$/)!);
  assert.equal(writes.length, 0, "cancelling wrote to the server");
  assert.ok(!(host.textContent ?? "").includes("item added"), "a stale composition survived Cancel");
});
