import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A REAL SELECTION SESSION, not a source-shape assertion.
//
// The reported failure was that the picker itself vanished mid-assembly and
// took every selection with it, intermittently. Nothing about the checkbox
// state was wrong, so a test that only pokes at state would have stayed green
// through the whole thing. This mounts the actual component, runs several
// searches with selections in between, and dispatches REAL mouse events —
// including the press-inside/release-outside sequence that was closing it.

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let UseLibraryPicker: typeof import("../components/library/use-library-picker.tsx").UseLibraryPicker;
// The picker calls useRouter to go straight into the new FlowGuide, so the
// router context has to exist. Recorded rather than stubbed away: "Create sent
// me to the right place" is part of what the session is supposed to do.
let AppRouterContext: React.Context<unknown>;
const pushed: string[] = [];
const ROUTER = {
  push: (href: string) => { pushed.push(href); }, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: async () => {},
};

// The Library the fake server holds. Search filters it, exactly as the API does.
const LIBRARY = [
  { id: "brookdale-windsor", title: "Brookdale Windsor", address: "907 Adele Dr. Windsor, CA" },
  { id: "brookdale-paulin", title: "Brookdale Paulin Creek", address: "2375 Range Ave, Santa Rosa, CA" },
  { id: "brookdale-chanate", title: "Brookdale Chanate", address: "3250 Chanate Rd. Santa Rosa, CA" },
  { id: "varenna", title: "Varenna at Fountaingrove", address: "1401 Fountaingrove Pkwy" },
  { id: "oakmont", title: "Oakmont Gardens", address: "301 White Oak Dr" },
];
let failNextLoad = false;
const createdWith: string[][] = [];

before(async () => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://flowguide.test/", pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  // node 25 exposes a real `navigator`, and it is getter-only.
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.MouseEvent = dom.window.MouseEvent; g.Event = dom.window.Event;
  g.KeyboardEvent = dom.window.KeyboardEvent; g.Node = dom.window.Node;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);

  // The Library API, and the creation endpoint, without a network.
  g.fetch = async (url: unknown, init?: { method?: string; body?: string }) => {
    const href = String(url);
    if (href.startsWith("/api/library")) {
      if (failNextLoad) { failNextLoad = false; return { ok: false, json: async () => ({ message: "Could not load your Library." }) }; }
      const q = decodeURIComponent(new URL(href, "https://flowguide.test").searchParams.get("q") ?? "").toLowerCase();
      const items = LIBRARY.filter((i) => !q || i.title.toLowerCase().includes(q));
      return { ok: true, json: async () => ({ items }) };
    }
    if (href.startsWith("/api/packets/from-library")) {
      createdWith.push(JSON.parse(init?.body ?? "{}").libraryItemIds);
      return { ok: true, status: 201, json: async () => ({ packetId: "new-packet" }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as
    { AppRouterContext: React.Context<unknown> });
  ({ UseLibraryPicker } = await import("../components/library/use-library-picker.tsx"));
});

after(() => { dom?.window?.close(); });

// ---------------------------------------------------------------------------
const flush = async (ms = 260) => {
  await act(async () => { await new Promise((r) => dom.window.setTimeout(r, ms)); });
};
const $ = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...dom.window.document.querySelectorAll(sel)] as HTMLElement[];
const backdrop = () => $(".fixed.inset-0")!;
const isOpen = () => !!$(".fixed.inset-0");
const rows = () => $$("li label");
const checkboxes = () => $$("li input[type=checkbox]") as unknown as HTMLInputElement[];
const createButton = () => $$("button").find((b) => /Create FlowGuide/.test(b.textContent ?? ""))!;
const cancelButton = () => $$("button").find((b) => /Cancel/.test(b.textContent ?? ""))!;

async function search(text: string) {
  const input = $("input[placeholder='Search your Library…']") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush();
}

async function selectRowContaining(title: string) {
  const idx = rows().findIndex((r) => (r.textContent ?? "").includes(title));
  assert.ok(idx >= 0, `row "${title}" is not on screen`);
  await act(async () => { checkboxes()[idx].click(); });
}

/** The interaction that was dismissing it: press inside, release on the backdrop.
 *  A click is dispatched on the nearest common ancestor of the two targets, so
 *  the panel's stopPropagation never runs — the backdrop sees the click. */
async function pressInsideReleaseOutside(from: HTMLElement) {
  await act(async () => {
    const opts = { bubbles: true, cancelable: true, view: dom.window };
    from.dispatchEvent(new dom.window.PointerEvent("pointerdown", opts));
    from.dispatchEvent(new dom.window.MouseEvent("mousedown", opts));
    backdrop().dispatchEvent(new dom.window.MouseEvent("mouseup", opts));
    // The browser dispatches click on the nearest common ancestor of the press
    // and the release, which is the backdrop.
    backdrop().dispatchEvent(new dom.window.MouseEvent("click", opts));
  });
}

/** A real click on the backdrop: it begins AND ends there. */
async function clickBackdrop() {
  await act(async () => {
    const opts = { bubbles: true, cancelable: true, view: dom.window };
    backdrop().dispatchEvent(new dom.window.PointerEvent("pointerdown", opts));
    backdrop().dispatchEvent(new dom.window.MouseEvent("mousedown", opts));
    backdrop().dispatchEvent(new dom.window.MouseEvent("mouseup", opts));
    backdrop().dispatchEvent(new dom.window.MouseEvent("click", opts));
  });
}

let closed = 0;
async function mount() {
  closed = 0;
  createdWith.length = 0;
  pushed.length = 0;
  const root = createRoot($("#root")!);
  await act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER },
      React.createElement(UseLibraryPicker, { onClose: () => { closed++; } })));
  });
  await flush();
  return root;
}

// ---------------------------------------------------------------------------
test("A LONG SESSION: several searches, selections accumulating, picker stays open", async () => {
  const root = await mount();
  assert.ok(isOpen(), "the picker did not open");

  await search("brookdale");
  await selectRowContaining("Brookdale Paulin Creek");
  assert.ok(isOpen(), "selecting closed the picker");

  await search("varenna");
  assert.ok(isOpen(), "changing the search closed the picker");
  assert.equal(rows().length, 1, "the search did not filter");
  await selectRowContaining("Varenna at Fountaingrove");

  await search("oakmont");
  await selectRowContaining("Oakmont Gardens");

  await search("brookdale");
  await selectRowContaining("Brookdale Chanate");

  assert.ok(isOpen(), "the picker closed during the session");
  assert.match(createButton().textContent ?? "", /Create FlowGuide with 4/,
    "the count does not reflect the whole accumulated set");

  // The two Brookdales chosen are still ticked; the untouched one is not.
  const ticked = rows().filter((_, i) => checkboxes()[i].checked).map((r) => r.textContent ?? "");
  assert.equal(ticked.length, 2, JSON.stringify(ticked));
  assert.ok(ticked.some((t) => t.includes("Paulin Creek")) && ticked.some((t) => t.includes("Chanate")));

  await act(async () => { root.unmount(); });
});

test("CLEARING the search keeps every selection, including rows off screen", async () => {
  const root = await mount();
  await search("varenna");
  await selectRowContaining("Varenna at Fountaingrove");
  await search("oakmont");
  await selectRowContaining("Oakmont Gardens");

  await search("");
  assert.ok(isOpen(), "clearing the search closed the picker");
  assert.equal(rows().length, LIBRARY.length, "clearing did not restore the full list");
  assert.match(createButton().textContent ?? "", /Create FlowGuide with 2/);
  const ticked = rows().filter((_, i) => checkboxes()[i].checked).map((r) => r.textContent ?? "");
  assert.equal(ticked.length, 2, JSON.stringify(ticked));
  await act(async () => { root.unmount(); });
});

test("THE REPORTED DISMISSAL: a press inside that ends on the backdrop must not close it", async () => {
  const root = await mount();
  await search("brookdale");
  await selectRowContaining("Brookdale Paulin Creek");
  await selectRowContaining("Brookdale Chanate");
  assert.match(createButton().textContent ?? "", /with 2/);

  // Dragging to select text in the search box, releasing past the panel edge.
  await pressInsideReleaseOutside($("input[placeholder='Search your Library…']")!);
  assert.equal(closed, 0, "a drag that began inside the panel dismissed the picker");
  assert.ok(isOpen(), "the picker was unmounted mid-session");
  assert.match(createButton().textContent ?? "", /with 2/, "the selection was lost");

  // ...and the same thing beginning on a row, which is what a re-render under
  // the cursor produces: the row goes away, the release lands on the backdrop.
  await pressInsideReleaseOutside(rows()[0]);
  assert.equal(closed, 0, "a press on a row that released outside dismissed the picker");
  assert.match(createButton().textContent ?? "", /with 2/);
  await act(async () => { root.unmount(); });
});

test("a load ERROR is shown inside the picker, and does not dump the professional out", async () => {
  const root = await mount();
  await search("brookdale");
  await selectRowContaining("Brookdale Windsor");

  failNextLoad = true;
  await search("varenna");
  assert.ok(isOpen(), "a failed search closed the picker");
  assert.equal(closed, 0);
  assert.match(dom.window.document.body.textContent ?? "", /Could not load your Library/,
    "the error is not shown in place");
  assert.match(createButton().textContent ?? "", /with 1/, "the failed search discarded the selection");

  // ...and the session recovers when the next search works.
  await search("oakmont");
  await selectRowContaining("Oakmont Gardens");
  assert.match(createButton().textContent ?? "", /with 2/);
  await act(async () => { root.unmount(); });
});

test("A DELIBERATE click on the backdrop still closes it", async () => {
  const root = await mount();
  await search("brookdale");
  await selectRowContaining("Brookdale Windsor");
  await clickBackdrop();
  assert.equal(closed, 1, "clicking the backdrop no longer closes the picker");
  await act(async () => { root.unmount(); });
});

test("CANCEL still ends the session", async () => {
  const root = await mount();
  await search("brookdale");
  await selectRowContaining("Brookdale Windsor");
  await act(async () => { cancelButton().click(); });
  assert.equal(closed, 1, "Cancel no longer ends the session");
  await act(async () => { root.unmount(); });
});

test("CREATE submits the whole accumulated set, across searches", async () => {
  const root = await mount();
  await search("brookdale");
  await selectRowContaining("Brookdale Paulin Creek");
  await search("varenna");
  await selectRowContaining("Varenna at Fountaingrove");
  await search("oakmont");
  await selectRowContaining("Oakmont Gardens");

  await act(async () => { createButton().click(); });
  await flush();
  assert.equal(createdWith.length, 1, "create did not submit");
  assert.deepEqual([...createdWith[0]].sort(),
    ["brookdale-paulin", "oakmont", "varenna"].sort(),
    "create submitted something other than the accumulated set");
  assert.deepEqual(pushed, ["/edit/new-packet"], "create did not land the professional in the new FlowGuide");
  assert.equal(closed, 0, "create closed the picker instead of navigating");
  await act(async () => { root.unmount(); });
});
