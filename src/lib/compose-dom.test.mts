// THE COMPOSITION SURFACE, MOUNTED.
//
// Two panes: the Library on the left, the FlowGuide being assembled on the
// right. What is worth proving here is not the pointer — jsdom has no geometry
// and a faked drag proves the fake — but everything around it: that the
// non-drag path works, that adding does not disturb the Library, that the
// Library's own MOVE handles cannot appear here, and that what Create finally
// sends is the tray in its order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Workspace: typeof import("../components/library/library-workspace.tsx").default;
let AppRouterContext: React.Context<unknown>;

const ITEMS = [
  { id: "i-1", title: "Alpha House", address: "1 A St", labels: ["Preferred"], isFavorite: true,
    updatedAt: "2026-08-28 12:00:03.000000+00", sectionId: "sec-1", groupId: null, sortOrder: 0 },
  { id: "i-2", title: "Bravo Manor", address: "2 B St", labels: [], isFavorite: false,
    updatedAt: "2026-08-28 12:00:02.000000+00", sectionId: "sec-1", groupId: null, sortOrder: 1 },
  { id: "i-3", title: "Cedar Lodge", address: "3 C St", labels: [], isFavorite: false,
    updatedAt: "2026-08-28 12:00:01.000000+00", sectionId: null, groupId: null, sortOrder: 0 },
];
/** Every write the page makes. Composing must add NOTHING to this until Create. */
const writes: Array<{ path: string; method: string; body: unknown }> = [];
let created: { libraryItemIds?: string[] } | null = null;

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url, "https://flowguide.test");
  const method = init?.method ?? "GET";
  const json = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => b } as unknown as Response);
  if (method !== "GET") writes.push({ path: u.pathname, method, body: JSON.parse(init?.body ?? "{}") });

  if (u.pathname === "/api/packets/from-library") {
    created = JSON.parse(init?.body ?? "{}");
    return json({ packetId: "pkt-new", count: created?.libraryItemIds?.length ?? 0 });
  }
  if (u.pathname === "/api/library" && method === "GET") {
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const items = q ? ITEMS.filter((i) => i.title.toLowerCase().includes(q)) : ITEMS;
    return json({ items, hasMore: false, nextCursor: null,
      vocabulary: { labels: ["Preferred"], hasFavorites: true },
      structure: { sections: [{ id: "sec-1", name: "Communities", sortOrder: 0 }], groups: [] } });
  }
  if (u.pathname === "/api/library/browse") {
    return json({
      structure: { sections: [{ id: "sec-1", name: "Communities", sortOrder: 0 }], groups: [] },
      containers: [{ sectionId: "sec-1", groupId: null, items: ITEMS.slice(0, 2), total: 2, cursor: null, hasMore: false }],
      unorganized: { sectionId: null, groupId: null, items: ITEMS.slice(2), total: 1, cursor: null, hasMore: false },
      vocabulary: { labels: ["Preferred"], hasFavorites: true },
    });
  }
  if (u.pathname.startsWith("/api/library/")) return json({ item: {}, usedIn: 0 });
  return json({});
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/library", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.confirm = () => true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => fakeFetch(url, init)) as typeof fetch;

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as
    { AppRouterContext: React.Context<unknown> });
  Workspace = (await import("../components/library/library-workspace.tsx")).default;
});
after(() => dom.window.close());

const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {},
  forward: () => {}, prefetch: async () => {} };

async function mount() {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  writes.length = 0; created = null;
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER },
      React.createElement(Workspace)));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return host;
}
const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
};
const byText = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()));
const byLabel = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].filter((b) => re.test(b.getAttribute("aria-label") ?? ""));
const addFor = (host: Element, title: string) =>
  byLabel(host, new RegExp(`^Add ${title} to this FlowGuide$`))[0];
/** The tray's entries, in order, read off the numbered list. */
const trayOrder = (host: Element) =>
  [...host.querySelectorAll("ol li")].map((li) =>
    (li.textContent ?? "").replace(/^\d+/, "").replace(/[↑↓×]/g, "").trim());

const openCompose = async (host: Element) => {
  await click(byText(host, /^Create a FlowGuide$/)!);
  // Sections open closed. Composing from inside one is the ordinary case, so
  // the tests work there rather than only among the unfiled remainder.
  const heading = [...host.querySelectorAll("button")]
    .find((b) => /Communities/.test(b.textContent ?? ""));
  if (heading) await click(heading);
};

// ---------------------------------------------------------------------------

test("composing opens a tray with an empty state that says what to do", async () => {
  const host = await mount();
  await openCompose(host);
  const text = host.textContent ?? "";
  assert.match(text, /This FlowGuide/, "the assembly pane is not shown");
  assert.match(text, /Nothing in it yet/, "there is no empty state");
  assert.match(text, /Drag something over from your Library/, "the empty state does not say how");
  assert.match(text, /press Add on any item/, "the non-drag path is not offered");
});

test("ADD WITHOUT DRAGGING puts the item in the tray", async () => {
  const host = await mount();
  await openCompose(host);
  const add = addFor(host, "Alpha House");
  assert.ok(add, "no Add control on a Library row");
  await click(add!);
  assert.deepEqual(trayOrder(host), ["Alpha House"]);
  // …and the row says so, without disappearing from the Library.
  assert.match(host.textContent ?? "", /✓ Added/, "the added state is not shown");
  assert.match(host.textContent ?? "", /Alpha House/, "the item vanished from the Library list");
});

test("ADDING WRITES NOTHING — the Library is untouched until Create", async () => {
  const host = await mount();
  await openCompose(host);
  await click(addFor(host, "Alpha House")!);
  await click(addFor(host, "Bravo Manor")!);
  assert.deepEqual(writes, [], `composing wrote to the server: ${JSON.stringify(writes)}`);
});

test("the tray REORDERS and REMOVES without a pointer", async () => {
  const host = await mount();
  await openCompose(host);
  await click(addFor(host, "Alpha House")!);
  await click(addFor(host, "Bravo Manor")!);
  assert.deepEqual(trayOrder(host), ["Alpha House", "Bravo Manor"]);

  await click(byLabel(host, /^Move Bravo Manor up$/)[0]!);
  assert.deepEqual(trayOrder(host), ["Bravo Manor", "Alpha House"], "Move up did not reorder");
  await click(byLabel(host, /^Move Bravo Manor down$/)[0]!);
  assert.deepEqual(trayOrder(host), ["Alpha House", "Bravo Manor"], "Move down did not reorder");

  await click(byLabel(host, /^Remove Alpha House from this FlowGuide$/)[0]!);
  assert.deepEqual(trayOrder(host), ["Bravo Manor"], "Remove did not take it out");
  // Removing from the tray must not remove it from the Library, or write.
  assert.match(host.textContent ?? "", /Alpha House/, "removing from the tray removed the Library item");
  assert.deepEqual(writes, [], "removing from the tray wrote to the server");
});

test("CREATE SENDS THE TRAY, IN ITS ORDER", async () => {
  const host = await mount();
  await openCompose(host);
  await click(addFor(host, "Bravo Manor")!);
  await click(addFor(host, "Alpha House")!);
  assert.deepEqual(trayOrder(host), ["Bravo Manor", "Alpha House"]);
  await click(byText(host, /^Create FlowGuide$/)!);
  assert.deepEqual(created?.libraryItemIds, ["i-2", "i-1"],
    "the order the professional arranged is not what was sent");
  // ONE payload key. No section, no group, no label, no favourite travels.
  assert.deepEqual(Object.keys(created ?? {}), ["libraryItemIds"],
    `Library organization leaked into the create payload: ${JSON.stringify(created)}`);
});

test("A SEARCH RESULT can be added, and adding it reorganizes nothing", async () => {
  // Search flattens the Library, so the row above is not the row above in
  // storage — which is why REORDER is refused under a filter. COPY has no such
  // problem: it does not care where the item sits.
  const host = await mount();
  await openCompose(host);
  const box = host.querySelector('input[type="search"], input[type="text"]') as HTMLInputElement | null;
  assert.ok(box, "there is no search box while composing");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(box, "Cedar");
    box!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  // The list debounces a non-empty query by 200ms.
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const add = addFor(host, "Cedar Lodge");
  assert.ok(add, "a searched item offers no way to add it");
  await click(add!);
  assert.deepEqual(trayOrder(host), ["Cedar Lodge"]);
  assert.deepEqual(writes, [], "adding a search result wrote to the Library");
});

test("NO LIBRARY MOVE HANDLES appear while composing", async () => {
  // The gesture that means MOVE must be absent where the gesture means COPY,
  // or the same grip would mean two opposite things three inches apart.
  const host = await mount();
  await openCompose(host);
  // The tray has its own reorder grips; those are fine and are inside <ol>.
  // Anything OUTSIDE the tray that reorders is the Library, and must be gone.
  const libraryGrips = byLabel(host, /^Drag to reorder /).filter((b) => !b.closest("ol"));
  assert.deepEqual(libraryGrips.map((b) => b.getAttribute("aria-label")), [],
    "a Library reorder handle is rendered on the composition surface");
  // …and so must the step controls and rename, which live on the HEADINGS and
  // were still there when this test first ran.
  assert.deepEqual(byLabel(host, /^Move section /).map((b) => b.getAttribute("aria-label")), [],
    "Library sections can still be reordered while composing");
  assert.deepEqual(byLabel(host, /^Move group /).map((b) => b.getAttribute("aria-label")), [],
    "Library groups can still be reordered while composing");
  assert.deepEqual(byLabel(host, /^Actions for /).map((b) => b.getAttribute("aria-label")), [],
    "the rename menu is offered while composing");
  assert.equal(byLabel(host, /^Move .* somewhere else$/).length, 0, "Move… is offered while composing");
});

test("CANCEL abandons the whole staged composition", async () => {
  const host = await mount();
  await openCompose(host);
  await click(addFor(host, "Alpha House")!);
  await click(byText(host, /^Cancel$/)!);
  assert.deepEqual(writes, [], "cancelling wrote something");
  assert.ok(!/This FlowGuide/.test(host.textContent ?? ""), "the tray outlived the composition");
  // And starting again begins empty.
  await openCompose(host);
  assert.match(host.textContent ?? "", /Nothing in it yet/, "a cancelled selection came back");
});

// ---------------------------------------------------------------------------
// THE COPY ITSELF — enforced in the database, asserted where it lives
// ---------------------------------------------------------------------------

test("the copy is a SNAPSHOT: independent, ordered, and free of Library filing", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/0023_create_packet_from_library.sql", import.meta.url), "utf8");
  // ORDER. The array the tray sends is the order the items get.
  assert.match(sql, /unnest\(p_library_item_ids\) with ordinality as k\(id, ord\)/,
    "the copy does not preserve the order it was given");
  assert.match(sql, /order by k\.ord/, "the copy loop does not run in the given order");
  // CONTENT ONLY. Library filing has no column here to land in.
  const loop = sql.slice(sql.indexOf("for src in"), sql.indexOf("end loop"));
  for (const filing of ["section_id", "group_id", "labels", "is_favorite", "sort_order = src"])
    assert.ok(!new RegExp(`src\\.${filing.split(" ")[0]}`).test(loop),
      `the copy reads the Library item's ${filing}`);
  // INDEPENDENT. The new row records where it came from, and nothing reads
  // that back to keep them in step.
  assert.match(loop, /library_item_id, library_item_revision/,
    "the copy keeps no lineage at all, so a save-back could not tell them apart");
});

test("the create payload has no room for Library organization", () => {
  const route = readFileSync(
    new URL("../app/api/packets/from-library/route.ts", import.meta.url), "utf8");
  assert.match(route, /\{ libraryItemIds\?: string\[\]; title\?: string; clientName\?: string \}/,
    "the route accepts something other than ids and a name");
  // WHAT IT ACCEPTS, which is the request — not what it returns. The response
  // legitimately names the section it created, and that is the FlowGuide's own
  // section, nothing to do with the Library's.
  const accepts = route.slice(route.indexOf("await request.json()"), route.indexOf("createServerClient()"));
  for (const forbidden of ["sectionId", "groupId", "labels", "favorite"])
    assert.ok(!accepts.includes(forbidden), `the create route accepts ${forbidden}`);
});
