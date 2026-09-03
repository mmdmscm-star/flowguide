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
let SearchParamsContext: React.Context<unknown>;

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
  // The workspace reads `?compose=1` to know it was sent here to compose, so
  // the tests supply the same context the App Router always does.
  ({ SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js") as unknown as
    { SearchParamsContext: React.Context<unknown> });
  Workspace = (await import("../components/library/library-workspace.tsx")).default;
});
after(() => dom.window.close());

/** Where the page asked to go. Cancel's destination depends on how the
 *  professional arrived, so it has to be observable. */
const pushed: string[] = [];
const ROUTER = { push: (to: string) => { pushed.push(to); }, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: async () => {} };

async function mount(query = "") {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  writes.length = 0; created = null; pushed.length = 0;
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER },
      React.createElement(SearchParamsContext.Provider, { value: new dom.window.URLSearchParams(query) },
        React.createElement(Workspace))));
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
  byLabel(host, new RegExp(`^Add ${title} to this Sendset$`))[0];
/** The tray's entries, in order, read off the numbered list. */
const trayOrder = (host: Element) =>
  [...host.querySelectorAll("ol li")].map((li) =>
    (li.textContent ?? "").replace(/^\d+/, "").replace(/[↑↓×]/g, "").trim());

const openCompose = async (host: Element) => {
  await click(byText(host, /^Create a Sendset$/)!);
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
  assert.match(text, /This Sendset/, "the assembly pane is not shown");
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

  await click(byLabel(host, /^Remove Alpha House from this Sendset$/)[0]!);
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
  await click(byText(host, /^Create Sendset$/)!);
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
  assert.ok(!/This Sendset/.test(host.textContent ?? ""), "the tray outlived the composition");
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

// ---------------------------------------------------------------------------
// WHAT THE FIRST HANDS-ON RUN FOUND
//
// Three presentation faults, none of them in the copy semantics: two panes
// crushed into a 32rem reading column, a drag nobody could see because its
// handle was a button labelled Add, and the old picker's checkboxes and
// "0 items selected" still sitting on top of an assembly surface.
// ---------------------------------------------------------------------------

const shellOf = (host: Element) =>
  [...host.querySelectorAll("div")].map((d) => d.className)
    .filter((c) => /max-w-\S+ mx-auto/.test(c));

test("COMPOSING WIDENS THE WORKSPACE; the ordinary Library keeps its column", async () => {
  const host = await mount();
  // Browsing: one reading column, unchanged.
  const browsing = shellOf(host);
  assert.ok(browsing.length >= 2, "the page shell was not found");
  for (const c of browsing)
    assert.match(c, /max-w-lg\b/, `the ordinary Library is no longer a column: ${c}`);

  await openCompose(host);
  const composingShell = shellOf(host);
  for (const c of composingShell)
    assert.ok(!/max-w-lg\b/.test(c), `the composition surface is still a 32rem column: ${c}`);
  // The nav bar widens WITH the body — a narrow header over a wide page reads
  // as broken rather than roomy.
  assert.equal(composingShell.length, browsing.length,
    "the header and the body no longer share a width");
  for (const c of composingShell) assert.match(c, /max-w-6xl/, c);
});

test("the two panes are a real split, and collapse rather than crush", async () => {
  const host = await mount();
  await openCompose(host);
  const grid = [...host.querySelectorAll("div")].map((d) => d.className)
    .find((c) => c.includes("lg:grid-cols-"));
  assert.ok(grid, "the composition surface is not two panes");
  // 55/45, and only at lg and above: below it this is one column.
  assert.match(grid!, /lg:grid-cols-\[minmax\(0,55fr\)_minmax\(0,45fr\)\]/,
    `the panes are not a readable split: ${grid}`);
  assert.ok(!/^grid-cols-|(?<!lg:)grid-cols-\[/.test(grid!),
    "two columns are forced at every width");
  // minmax(0,…) is what keeps a long name from pushing the page sideways.
  assert.ok(grid!.includes("minmax(0,"), "a long title can widen a column into horizontal scroll");
});

test("A VISIBLE GRIP, separate from Add — the drag is discoverable", async () => {
  const host = await mount();
  await openCompose(host);
  const grips = byLabel(host, /^Drag .* into this Sendset$/);
  assert.ok(grips.length > 0, "there is no visible way to drag an item into the Sendset");
  // Named per item, and not hidden until hover.
  assert.match(grips[0].getAttribute("aria-label") ?? "", /^Drag \S.* into this Sendset$/);
  for (const g of grips)
    assert.ok(!/opacity-0|invisible|hidden/.test(g.className), `a grip is hidden until hover: ${g.className}`);
  // The button survives beside it, as the click/keyboard/touch path.
  assert.ok(addFor(host, "Alpha House"), "Add is gone");
  // They are two controls, not one wearing two hats.
  assert.notEqual(grips[0], addFor(host, "Alpha House"));
  // And the grip is NOT the Library's move handle, which stays absent.
  assert.equal(byLabel(host, /^Drag to reorder /).filter((b) => !b.closest("ol")).length, 0,
    "a Library reorder handle came back with the compose grip");
});

test("BOTH AFFORDANCES PRODUCE THE SAME PENDING COPY", async () => {
  // The grip drags and the button clicks; what they mean is identical, and the
  // planner is what says so — the button calls the same add, at the end.
  const host = await mount();
  await openCompose(host);
  await click(addFor(host, "Alpha House")!);
  assert.deepEqual(trayOrder(host), ["Alpha House"]);
  // Once added, the row offers neither a grip nor an Add — it says ✓ Added.
  assert.equal(byLabel(host, /^Drag Alpha House into this Sendset$/).length, 0,
    "an item already in the tray can still be dragged in again");
  assert.equal(addFor(host, "Alpha House"), undefined, "Add survives on an added item");
  assert.match(host.textContent ?? "", /✓ Added/);
});

test("NO SELECTION LANGUAGE while composing — it says ADDED", async () => {
  const host = await mount();
  await openCompose(host);
  const text = host.textContent ?? "";
  assert.match(text, /0 items added/, "the composition summary still counts selections");
  assert.ok(!/items selected|item selected/.test(text),
    "the old picker's selection language is still on the composition surface");
  assert.equal([...host.querySelectorAll('input[type="checkbox"]')].length, 0,
    "checkboxes survive on the composition surface");

  // Singular and plural both.
  await click(addFor(host, "Alpha House")!);
  assert.match(host.textContent ?? "", /1 item added/, "the singular is wrong");
  await click(addFor(host, "Bravo Manor")!);
  assert.match(host.textContent ?? "", /2 items added/, "the plural is wrong");
});

test("SELECT & ORGANIZE KEEPS ITS CHECKBOXES AND ITS WORDS", async () => {
  // The redundancy was only in composition. Choosing several records to act on
  // together is exactly what a checkbox is for, and that mode still says so.
  const host = await mount();
  await click(byText(host, /^Select & Organize$/)!);
  const heading = [...host.querySelectorAll("button")].find((b) => /Communities/.test(b.textContent ?? ""));
  if (heading) await click(heading);
  assert.ok([...host.querySelectorAll('input[type="checkbox"]')].length > 0,
    "Select & Organize lost its checkboxes");
  assert.match(host.textContent ?? "", /0 items selected/,
    "Select & Organize no longer counts what is selected");
  // And it is not a composition surface: no grips, no Add, no tray.
  assert.equal(byLabel(host, /into this Sendset$/).length, 0, "compose controls leaked into Select & Organize");
  assert.ok(!/This Sendset/.test(host.textContent ?? ""), "the tray leaked into Select & Organize");
});

// ---------------------------------------------------------------------------
// TWO DOORS, ONE COMPOSER
//
// "Use my Library" on the New FlowGuide menu used to open a modal picker: a
// second implementation of this job, with its own selection state and its own
// Create. Which experience a professional got depended on which door they came
// through. It now lands here, with `?compose=1`.
// ---------------------------------------------------------------------------

test("ARRIVING TO COMPOSE opens the workspace immediately", async () => {
  const host = await mount("compose=1");
  const text = host.textContent ?? "";
  assert.match(text, /This Sendset/, "arriving to compose did not open the tray");
  assert.match(text, /0 items added/, "the composition summary is not shown");
  // The same surface, not a lookalike: wide shell, grips, Add, no checkboxes.
  for (const c of shellOf(host)) assert.match(c, /max-w-6xl/, `not the wide workspace: ${c}`);
  const heading = [...host.querySelectorAll("button")].find((b) => /Communities/.test(b.textContent ?? ""));
  if (heading) await click(heading);
  assert.ok(byLabel(host, /^Drag .* into this Sendset$/).length > 0, "no drag grips on the arrival path");
  assert.ok(addFor(host, "Alpha House"), "no Add on the arrival path");
  assert.equal([...host.querySelectorAll('input[type="checkbox"]')].length, 0,
    "the arrival path shows selection checkboxes");
});

test("the two doors reach the SAME surface", async () => {
  // Arrived-to-compose, and opened-from-the-Library, rendered the same way.
  const arrived = await mount("compose=1");
  const a = (arrived.textContent ?? "").includes("This Sendset");
  const opened = await mount();
  await openCompose(opened);
  const b = (opened.textContent ?? "").includes("This Sendset");
  assert.ok(a && b, "one of the two doors does not reach the composer");
  for (const c of shellOf(opened)) assert.match(c, /max-w-6xl/);
});

test("CANCEL GOES BACK THE WAY THEY CAME", async () => {
  // From My FlowGuides: back to My FlowGuides. Being left standing in the
  // Library is not a cancellation of anything they asked for.
  const fromDash = await mount("compose=1");
  await click(byText(fromDash, /^Cancel$/)!);
  assert.deepEqual(pushed, ["/dashboard"], "cancelling from the menu did not return to My Sendsets");

  // From the Library: the Library comes back, and nothing navigates.
  const fromLib = await mount();
  await openCompose(fromLib);
  await click(byText(fromLib, /^Cancel$/)!);
  assert.deepEqual(pushed, [], "cancelling inside the Library navigated away from it");
  assert.ok(!/This Sendset/.test(fromLib.textContent ?? ""), "the tray outlived Cancel");
  assert.ok(byText(fromLib, /^Create a Sendset$/), "the ordinary Library did not come back");
});

test("SELECTIONS ACCUMULATE ACROSS SEARCHES, and Create submits the whole set", async () => {
  // Carried over from the modal's session tests, because it is a property of
  // the JOB and not of the old presentation: what was added stays added while
  // the professional narrows the list to find the next thing.
  const host = await mount("compose=1");
  const heading = [...host.querySelectorAll("button")].find((b) => /Communities/.test(b.textContent ?? ""));
  if (heading) await click(heading);
  await click(addFor(host, "Alpha House")!);

  const box = host.querySelector('input[type="search"]') as HTMLInputElement;
  const type = async (v: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(box, v);
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  };
  await type("Cedar");
  // The first one is off screen now, and still in the tray with its name.
  assert.deepEqual(trayOrder(host), ["Alpha House"], "a selection was lost when the list was filtered");
  await click(addFor(host, "Cedar Lodge")!);
  assert.deepEqual(trayOrder(host), ["Alpha House", "Cedar Lodge"]);

  await type("");
  assert.deepEqual(trayOrder(host), ["Alpha House", "Cedar Lodge"], "clearing the search lost the tray");
  await click(byText(host, /^Create Sendset$/)!);
  assert.deepEqual(created?.libraryItemIds, ["i-1", "i-3"],
    "Create did not submit the accumulated set in its order");
});
