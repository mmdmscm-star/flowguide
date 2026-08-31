import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// KEEPING A NOTE AS PRIVATE MUST SHOW UP WITHOUT A RELOAD.
//
// The card disappearing and the note appearing are two different things, and
// only the first was happening. `resolveUnit` re-read the RUN, so the review
// panel updated — but the editor below holds its own copy of the packet, and
// nothing told it an item's `notes` had just changed underneath it. The new
// private note stayed invisible until the browser was refreshed.
//
// This mounts the REAL editor, so what is asserted is the whole path:
//   click → POST → run re-read → onItemsChanged → loadPacket → field re-rendered
// A fake host would have proven the hook fires a callback and nothing about
// whether the field the professional is looking at actually changes.

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Editor: typeof import("../components/editor/legacy-packet-editor.tsx").LegacyPacketEditor;
let AppRouterContext: React.Context<unknown>;
let PathnameContext: React.Context<unknown>;
let SearchParamsContext: React.Context<unknown>;
let PathParamsContext: React.Context<unknown>;

const PACKET = "pkt-1";
const RUN = "run-1";
const REDFERN = "INTERNAL ONLY — Luis said he can hold the November slot.";
const COASTLINE = "Same Maya Chen who appears at Marin Cabinet Studio.";

/** The server's items. `kept_private` appends to notes here, exactly as the RPC
 *  does, so the test reads the server's answer rather than one it invented. */
let items: Array<{ id: string; title: string; notes: string; description: string }>;
let units: Array<{ id: string; code: string; title: string; text: string; itemIds: string[]; status?: string }>;
const posted: Array<{ path: string; body: unknown }> = [];
let packetFetches = 0;

function reset() {
  items = [
    { id: "it-red", title: "Redfern Renovation", notes: "", description: "Construction-focused firm." },
    { id: "it-coast", title: "Coastline Craft Construction", notes: "", description: "Finish carpentry." },
  ];
  units = [
    { id: "u-red", code: "privacy_rejected", title: "Redfern Renovation", text: REDFERN, itemIds: ["it-red"] },
    { id: "u-coast", code: "privacy_rejected", title: "Coastline Craft Construction", text: COASTLINE, itemIds: ["it-coast"] },
  ];
  posted.length = 0;
  packetFetches = 0;
}

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  const u = new URL(url, "https://flowguide.test");
  const json = (b: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: async () => b } as unknown as Response);

  if (u.pathname === `/api/packets/${PACKET}` && (init?.method ?? "GET") === "GET") {
    packetFetches++;
    // The FLAT shape /api/packets/:id actually returns — packet, sections,
    // items, and the child tables beside them, not nested inside.
    return json({
      packet: { id: PACKET, slug: "s", title: "T", client_name: "C", status: "draft",
                composition_mode: "legacy", identity_mode: "default", show_quick_nav: true,
                custom_identity: null },
      sections: [{ id: "sec-1", title: "Options", description: "", sort_order: 0 }],
      items: items.map((i, n) => ({
        id: i.id, section_id: "sec-1", title: i.title, address: "", description: i.description,
        notes: i.notes, highlight: "", sort_order: n, library_item_id: null,
      })),
      photos: [], links: [], details: [], contacts: [], profile: null,
    });
  }
  if (u.pathname === `/api/ingest/${RUN}` ) {
    const open = units.filter((x) => !x.status);
    return json({ run: {
      id: RUN, status: open.length ? "needs_review" : "finalized", totalChunks: 1, completedChunks: 1,
      review: { summary: `${open.length} pieces of information need a decision before publishing.`,
                exit: "", failures: units.map((x) => ({ ...x, status: x.status ?? "unresolved" })) },
    } });
  }
  if (u.pathname.startsWith(`/api/ingest/${RUN}/review/`)) {
    const unitId = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const status = (JSON.parse(init?.body ?? "{}") as { status: string }).status;
    posted.push({ path: u.pathname, body: { unitId, status } });
    const unit = units.find((x) => x.id === unitId);
    if (!unit) return json({ ok: false, message: "not found" }, 404);
    // ONLY kept_private writes. The other two settle and touch no item — which
    // is what makes "they must not fabricate a note" testable.
    if (status === "kept_private") {
      const it = items.find((x) => x.id === unit.itemIds[0]);
      if (it) it.notes = it.notes ? `${it.notes}\n\n${unit.text}` : unit.text;
    }
    unit.status = status;
    return json({ ok: true });
  }
  // Everything else the editor asks for on mount. These are shape-only: the
  // panels they feed render nothing, which keeps the test about the note.
  if (u.pathname === `/api/packets/${PACKET}/ownership`) return json({ kept: [], findings: [] });
  if (u.pathname === `/api/packets/${PACKET}/ingest`) return json({ activeRun: { runId: RUN } });
  if (u.pathname === "/api/profile") return json({ profile: null });
  if (u.pathname === "/api/library") return json({ items: [], hasMore: false, nextCursor: null });
  return json({});
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: `https://flowguide.test/edit/${PACKET}`, pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  g.self = dom.window; g.location = dom.window.location;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.confirm = () => true;
  g.fetch = ((url: string, init?: { method?: string; body?: string }) => fakeFetch(url, init)) as typeof fetch;

  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  const routerMod = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as Record<string, React.Context<unknown>>;
  const hooksMod = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js") as unknown as Record<string, React.Context<unknown>>;
  AppRouterContext = routerMod.AppRouterContext;
  PathnameContext = hooksMod.PathnameContext;
  SearchParamsContext = hooksMod.SearchParamsContext;
  PathParamsContext = hooksMod.PathParamsContext;
  for (const [n, c] of Object.entries({ AppRouterContext, PathnameContext, SearchParamsContext, PathParamsContext }))
    assert.ok(c, `${n} is not exported where this test expects it`);
  // A NAMED export that takes no props — it reads the packet id from useParams.
  Editor = (await import("../components/editor/legacy-packet-editor.tsx")).LegacyPacketEditor;
});

after(() => dom.window.close());

const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {},
  forward: () => {}, prefetch: async () => {} };

async function mount() {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  const tree = React.createElement(AppRouterContext.Provider, { value: ROUTER },
    React.createElement(PathnameContext.Provider, { value: `/edit/${PACKET}` },
      React.createElement(SearchParamsContext.Provider, { value: new dom.window.URLSearchParams(`import=${RUN}`) },
        React.createElement(PathParamsContext.Provider, { value: { id: PACKET } },
          React.createElement(Editor)))));
  await act(async () => { root.render(tree); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return host;
}

const text = (host: Element) => host.textContent ?? "";
const notesFields = (host: Element) =>
  [...host.querySelectorAll("textarea")].map((t) => (t as HTMLTextAreaElement).value);
const byText = (host: Element, re: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").trim()));
const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};

// ---------------------------------------------------------------------------

test("the editor mounts with both review cards and no private notes yet", async () => {
  reset();
  const host = await mount();
  assert.ok(text(host).includes("Redfern Renovation"), "the Redfern card is missing");
  assert.ok(text(host).includes("Coastline Craft Construction"), "the Coastline card is missing");
  assert.ok(!notesFields(host).some((v) => v.includes("INTERNAL ONLY")),
    "a private note is showing before anything was kept");
});

test("KEEP AS PRIVATE NOTE updates the field on the same page — no reload", async () => {
  reset();
  const host = await mount();
  const before = packetFetches;

  const keep = byText(host, /^Keep as private note$/);
  assert.ok(keep, "the panel offers no way to keep it");
  await click(keep!);

  // 3. the card is gone
  const cards = text(host);
  assert.ok(!/Keep as private note[\s\S]*Redfern Renovation/.test(cards) ||
            !cards.includes(REDFERN), "the Redfern card did not disappear");

  // 4. ...and the note is visible WITHOUT a reload
  assert.ok(packetFetches > before,
    "the packet was never re-read, so the editor is still showing stale notes");
  assert.ok(notesFields(host).some((v) => v.includes("INTERNAL ONLY — Luis said")),
    `the private note did not appear in any notes field: ${JSON.stringify(notesFields(host))}`);

  // 5. the other item is untouched
  assert.equal(items.find((i) => i.id === "it-coast")!.notes, "",
    "an unrelated item was written to");
  assert.ok(!notesFields(host).some((v) => v.includes("Same Maya Chen")),
    "the other item's field shows a note nobody kept");
});

test("the server is the authority — the field shows what IT stored", async () => {
  reset();
  items.find((i) => i.id === "it-red")!.notes = "My own earlier note.";
  const host = await mount();
  await click(byText(host, /^Keep as private note$/)!);
  const field = notesFields(host).find((v) => v.includes("INTERNAL ONLY"));
  assert.ok(field, "the appended note never appeared");
  assert.ok(field!.startsWith("My own earlier note."),
    `the existing note was replaced rather than appended: ${JSON.stringify(field)}`);
  assert.ok(field!.includes(REDFERN), "the kept text is missing from the field");
});

test("I ADDED IT ELSEWHERE settles the card and fabricates no note", async () => {
  reset();
  const host = await mount();
  const before = packetFetches;
  await click(byText(host, /^I added it elsewhere$/)!);
  assert.deepEqual(posted.at(-1)?.body, { unitId: "u-red", status: "resolved" });
  assert.equal(items.find((i) => i.id === "it-red")!.notes, "", "the server wrote a note it should not have");
  assert.ok(!notesFields(host).some((v) => v.includes("INTERNAL ONLY")),
    "a note appeared in the editor although nothing was written");
  assert.equal(packetFetches, before,
    "the packet was re-read after a disposition that changes no item");
});

test("LEAVE IT OUT settles the card and fabricates no note", async () => {
  reset();
  const host = await mount();
  const before = packetFetches;
  await click(byText(host, /^Leave it out$/)!);
  assert.deepEqual(posted.at(-1)?.body, { unitId: "u-red", status: "ignored" });
  assert.equal(items.find((i) => i.id === "it-red")!.notes, "");
  assert.ok(!notesFields(host).some((v) => v.includes("INTERNAL ONLY")));
  assert.equal(packetFetches, before,
    "the packet was re-read after a disposition that changes no item");
});
