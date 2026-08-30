import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// THE STRUCTURED LIBRARY, ACTUALLY MOUNTED.
//
// Source-shape guards prove a control exists in the file. They cannot prove
// that collapsing hides the right rows, that Show more reaches item 40 of 40,
// or that pressing Move down on the LAST VISIBLE row of a page sends something
// the server can act on correctly. Those are lifecycle facts, so this mounts
// the real component against a fake server and dispatches real events.
//
// It also cannot be run against the product database: the Library UI is behind
// a magic-link session, and minting one would mean creating a credential. So
// the server is faked here and the contract it fakes — the shape /api/library
// and /api/library/browse actually return — is asserted in the service tests.

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let View: typeof import("../components/library/library-structure-view.tsx").LibraryStructureView;

const SECTION = "sec-1", GROUP = "grp-1";
// 40 items loose in the section, so a 6-per-container first page leaves 34
// behind — the shape that made "Show more" and paged reordering necessary.
const LOOSE = Array.from({ length: 40 }, (_, i) => ({
  id: `loose-${String(i + 1).padStart(2, "0")}`,
  title: `Loose ${String(i + 1).padStart(2, "0")}`,
  address: `${i + 1} Example Ave`, sortOrder: i, labels: [] as string[],
}));
const GROUPED = [
  { id: "g-1", title: "Grouped One", address: "1 Group St", sortOrder: 0, labels: [] },
  { id: "g-2", title: "Grouped Two", address: "2 Group St", sortOrder: 1, labels: [] },
];
const UNORG = [{ id: "u-1", title: "Unfiled One", address: "9 Loose Rd", labels: [] }];

let hasStructure = true;
const orderCalls: Array<Record<string, unknown>> = [];
const listCalls: string[] = [];
const renameCalls: Array<Record<string, unknown>> = [];
let renameFails = false;

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url, "https://flowguide.test");
  const json = (body: unknown) => Promise.resolve({
    ok: true, status: 200, json: async () => body,
  } as unknown as Response);

  if (u.pathname === "/api/library/browse") {
    if (!hasStructure) {
      return json({ structure: { sections: [], groups: [] }, containers: [],
        unorganized: { sectionId: null, groupId: null, items: UNORG, total: 1, cursor: null, hasMore: false },
        vocabulary: { categories: [], labels: [], hasFavorites: false } });
    }
    return json({
      structure: {
        sections: [{ id: SECTION, name: "Communities", sortOrder: 0 }],
        groups: [{ id: GROUP, sectionId: SECTION, name: "Santa Rosa", sortOrder: 0 }],
      },
      containers: [
        { sectionId: SECTION, groupId: GROUP, items: GROUPED, total: 2, cursor: null, hasMore: false },
        { sectionId: SECTION, groupId: null, items: LOOSE.slice(0, 6), total: 40,
          cursor: { sortOrder: 5, id: LOOSE[5].id }, hasMore: true },
      ],
      unorganized: { sectionId: null, groupId: null, items: UNORG, total: 1, cursor: null, hasMore: false },
      vocabulary: { categories: [], labels: [], hasFavorites: false },
    });
  }

  if (u.pathname === "/api/library") {
    listCalls.push(u.search);
    const after = Number(u.searchParams.get("cursorSortOrder"));
    const next = LOOSE.filter((r) => r.sortOrder > after).slice(0, 6);
    const last = next[next.length - 1];
    const more = last ? last.sortOrder < LOOSE[LOOSE.length - 1].sortOrder : false;
    return json({ items: next, hasMore: more,
      nextContainerCursor: more && last ? { sortOrder: last.sortOrder, id: last.id } : null });
  }

  if (u.pathname === "/api/library/order") {
    orderCalls.push(JSON.parse(init?.body ?? "{}"));
    return json({ moved: true });
  }

  if (u.pathname === "/api/library/structure") {
    renameCalls.push(JSON.parse(init?.body ?? "{}"));
    if (renameFails) {
      return Promise.resolve({ ok: false, status: 409,
        json: async () => ({ error: "duplicate_name", message: "You already have a section with that name." }),
      } as unknown as Response);
    }
    return json({ structure: {} });
  }
  throw new Error(`unexpected fetch ${url}`);
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  // Node 25 exposes navigator as a getter-only global.
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => fakeFetch(url, init)) as typeof fetch;

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ LibraryStructureView: View } = await import("../components/library/library-structure-view.tsx"));
});

after(() => dom.window.close());

async function mount(props: Record<string, unknown> = {}) {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(View, props)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return { host, root };
}

const textOf = (host: Element) => host.textContent ?? "";
const buttons = (host: Element, label: string) =>
  [...host.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const byText = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

// ---------------------------------------------------------------------------

test("the hierarchy renders: section, its group, then what sits loose in it", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: true });
  const t = textOf(host);
  assert.ok(t.includes("Communities"), "the section heading is missing");
  assert.ok(t.includes("Santa Rosa"), "the group heading is missing");
  assert.ok(t.includes("Grouped One"), "a grouped item is missing");
  assert.ok(t.includes("Loose 01"), "a loose item is missing");
  // Organized first, remainder last — the group's items precede the loose ones.
  assert.ok(t.indexOf("Grouped One") < t.indexOf("Loose 01"),
    "the loose items come before the group, so the remainder is not last");
  assert.ok(t.includes("Everything else"), "the unorganized remainder is not shown");
  assert.ok(t.indexOf("Communities") < t.indexOf("Everything else"),
    "the unfiled material is not after the structure");
});

test("a row shows NO section badge, because the heading above it already says so", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: true });
  const rows = [...host.querySelectorAll("li")];
  const looseRow = rows.find((r) => (r.textContent ?? "").includes("Loose 01"))!;
  assert.ok(!(looseRow.textContent ?? "").includes("Communities"),
    "the row repeats its section, which the hierarchy already communicates");
});

test("collapsing a section hides its items and keeps its heading", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: true });
  assert.ok(textOf(host).includes("Loose 01"));
  const toggle = [...host.querySelectorAll("button")]
    .find((b) => b.getAttribute("aria-expanded") === "true" && (b.textContent ?? "").includes("Communities"))!;
  await click(toggle);
  assert.ok(!textOf(host).includes("Loose 01"), "collapsing did not hide the items");
  assert.ok(textOf(host).includes("Communities"), "collapsing hid the heading too");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("SHOW MORE reaches the end: all 40 items are actually reachable", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: true });
  assert.ok(!textOf(host).includes("Loose 40"), "the container did not start paged");

  let guard = 0;
  for (;;) {
    const more = byText(host, /Show more/);
    if (!more || guard++ > 20) break;
    await click(more);
  }
  for (const item of LOOSE) {
    assert.ok(textOf(host).includes(item.title), `${item.title} is unreachable`);
  }
  assert.equal(byText(host, /Show more/), undefined, "Show more remains after the last page");
  assert.ok(listCalls.every((s) => s.includes("sectionId=")), "a page was fetched without its container");
});

test("MOVE DOWN on the last visible row sends an intent, not the loaded page", async () => {
  hasStructure = true;
  orderCalls.length = 0;
  const { host } = await mount({ reorder: true });

  // The last row the first page shows. Under a page-local reorder this is where
  // the tail of the container would get silently rewritten.
  const rows = [...host.querySelectorAll("li")];
  const lastVisible = rows.find((r) => (r.textContent ?? "").includes("Loose 06"))!;
  const down = [...lastVisible.querySelectorAll("button")]
    .find((b) => b.getAttribute("aria-label") === "Move down")!;
  assert.ok(down, "the last visible row has no Move down");
  assert.ok(!down.hasAttribute("disabled"),
    "Move down is disabled on the last LOADED row, so the rest of the container is unreachable");

  await click(down);
  assert.equal(orderCalls.length, 1);
  assert.deepEqual(orderCalls[0], { kind: "item", id: "loose-06", direction: "down" });
  const sent = JSON.stringify(orderCalls[0]);
  assert.ok(!/loose-01|loose-05|\[/.test(sent),
    "the request carried the loaded rows, which the server would treat as the whole order");
});

test("the FIRST row of a container cannot move up, and the LAST cannot move down", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: true });
  const grouped = [...host.querySelectorAll("li")]
    .filter((r) => /Grouped (One|Two)/.test(r.textContent ?? ""));
  const up = grouped[0].querySelector('button[aria-label="Move up"]')!;
  const down = grouped[1].querySelector('button[aria-label="Move down"]')!;
  assert.ok(up.hasAttribute("disabled"), "the first row offers a move that cannot happen");
  assert.ok(down.hasAttribute("disabled"), "the last row of a complete container offers a move down");
});

test("REORDER CONTROLS DISAPPEAR when a filter is narrowing the list", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: false });
  assert.equal(buttons(host, "Move up").length, 0, "Move up survives a filtered view");
  assert.equal(buttons(host, "Move down").length, 0, "Move down survives a filtered view");
  assert.ok(textOf(host).includes("Loose 01"), "the items themselves vanished too");
});

test("a picker browses the structure and offers no way to change it", async () => {
  hasStructure = true;
  const { host } = await mount({ selectable: true, selected: [], onToggle: () => {} });
  assert.ok(textOf(host).includes("Communities"), "the picker cannot see the structure");
  assert.equal(buttons(host, "Move up").length, 0, "a picker offers reordering");
  assert.equal(host.querySelectorAll('input[type="checkbox"]').length > 0, true,
    "a picker cannot select");
  assert.ok(!textOf(host).includes("Move…"), "a picker offers Move…");
});

test("SELECTION SURVIVES expanding a container and paging through it", async () => {
  hasStructure = true;
  let selected: string[] = [];
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(View, {
        selectable: true, selected,
        onToggle: (id: string) => {
          selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
        },
      }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  };
  await render();

  const box = [...host.querySelectorAll("li")]
    .find((r) => (r.textContent ?? "").includes("Grouped One"))!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
  // HTMLElement.click() toggles the box and fires the events React listens
  // for; a hand-built Event with .checked pre-set does not drive onChange.
  await act(async () => { box.click(); });
  assert.deepEqual(selected, ["g-1"], "the checkbox did not register");

  // Collapse, expand, and page — none of which is a decision about selection.
  const toggle = [...host.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes("Santa Rosa"))!;
  await click(toggle);
  await click(toggle);
  const more = byText(host, /Show more/);
  if (more) await click(more);
  await render();

  assert.deepEqual(selected, ["g-1"],
    "browsing the structure cleared the selection out from under the professional");
  const still = [...host.querySelectorAll("li")]
    .find((r) => (r.textContent ?? "").includes("Grouped One"))!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
  assert.equal(still.checked, true, "the selection is not reflected after browsing");
});

test("a Library with NO sections reports itself empty, so the flat list stays", async () => {
  hasStructure = false;
  let reportedEmpty: boolean | null = null;
  const { host } = await mount({ reorder: true, onEmpty: (e: boolean) => { reportedEmpty = e; } });
  assert.equal(reportedEmpty, true,
    "an unorganized Library does not fall back to the calm flat list");
  assert.ok(!textOf(host).includes("Uncategorized"),
    "an unorganized Library was wrapped in a hierarchy it did not ask for");
});

// ---------------------------------------------------------------------------
// RENAME, IN PLACE
// ---------------------------------------------------------------------------
const renameButton = (host: Element, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `Rename ${name}`);

// React tracks a controlled input's value on the node, so assigning `.value`
// directly is invisible to it and onChange never fires. The native setter is
// what a real keystroke goes through.
const typeInto = async (field: HTMLInputElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
};
const press = async (field: Element, key: string) => {
  await act(async () => {
    field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

test("a heading becomes a FIELD in place — no dialog, no settings screen", async () => {
  hasStructure = true; renameCalls.length = 0; renameFails = false;
  const { host } = await mount({ reorder: true });
  const btn = renameButton(host, "Communities")!;
  assert.ok(btn, "the section heading offers no way to correct it");
  await click(btn);
  const field = host.querySelector('input[aria-label="Rename Communities"]') as HTMLInputElement;
  assert.ok(field, "the heading did not become a field");
  assert.equal(field.value, "Communities", "the field does not start from the current name");
  assert.equal(host.querySelectorAll('[role="dialog"]').length, 0, "rename opened a dialog");
});

test("Enter sends the rename — the name only, for the right thing", async () => {
  // orderCalls is reset too: it is shared, and an earlier test fills it, which
  // would make "renaming reordered something" fire on somebody else's move.
  hasStructure = true; renameCalls.length = 0; orderCalls.length = 0; renameFails = false;
  const { host } = await mount({ reorder: true });
  await click(renameButton(host, "Santa Rosa")!);
  const field = host.querySelector('input[aria-label="Rename Santa Rosa"]') as HTMLInputElement;
  await typeInto(field, "  Santa   Rosa County  ");
  await press(field, "Enter");

  assert.equal(renameCalls.length, 1, "Enter did not commit the rename");
  assert.deepEqual(renameCalls[0], { kind: "group", id: GROUP, name: "Santa Rosa County" },
    "the request names the wrong thing, or does not tidy whitespace");
  assert.equal(orderCalls.length, 0, "renaming reordered something");
});

test("Escape abandons it, and nothing is sent", async () => {
  hasStructure = true; renameCalls.length = 0; renameFails = false;
  const { host } = await mount({ reorder: true });
  await click(renameButton(host, "Communities")!);
  const field = host.querySelector('input[aria-label="Rename Communities"]') as HTMLInputElement;
  await typeInto(field, "Something Else");
  await press(field, "Escape");
  assert.equal(renameCalls.length, 0, "Escape still sent the rename");
  assert.ok(textOf(host).includes("Communities"), "the original heading did not come back");
});

test("an UNCHANGED name is not sent at all", async () => {
  hasStructure = true; renameCalls.length = 0; renameFails = false;
  const { host } = await mount({ reorder: true });
  await click(renameButton(host, "Communities")!);
  const field = host.querySelector('input[aria-label="Rename Communities"]') as HTMLInputElement;
  await press(field, "Enter");
  assert.equal(renameCalls.length, 0, "a no-op rename was sent to the server");
});

test("a REFUSED rename says so and keeps the field open to fix", async () => {
  hasStructure = true; renameCalls.length = 0; renameFails = true;
  const { host } = await mount({ reorder: true });
  await click(renameButton(host, "Communities")!);
  const field = host.querySelector('input[aria-label="Rename Communities"]') as HTMLInputElement;
  await typeInto(field, "Services");
  await press(field, "Enter");
  assert.equal(renameCalls.length, 1);
  assert.ok(textOf(host).includes("You already have a section with that name"),
    "the refusal is silent");
  renameFails = false;
});

test("a PICKER offers no rename at all", async () => {
  hasStructure = true;
  const { host } = await mount({ selectable: true, selected: [], onToggle: () => {} });
  assert.equal(renameButton(host, "Communities"), undefined, "a picker can rename the structure");
  assert.equal(renameButton(host, "Santa Rosa"), undefined, "a picker can rename a group");
});

test("a FILTERED view offers no rename either", async () => {
  hasStructure = true;
  const { host } = await mount({ reorder: false });
  assert.equal(renameButton(host, "Communities"), undefined,
    "rename survives into a filtered view, where the structure is only partly shown");
});
