// GETTING OUT OF /responses/[id].
//
// The bug this pins: CreatorNav renders the CURRENT tab as plain text rather
// than a link — right on the Dashboard, where the link would go nowhere — and
// the Responses page claimed `current="packets"` without being My Sendsets. So
// the tab that says "My Sendsets" did nothing, and the only way back to the
// list was the browser's Back button, which a reader arriving from a direct
// link does not have.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const raw = (p: string) => readFileSync(p, "utf8");
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const PAGE = "src/app/responses/[id]/page.tsx";

// ---------------------------------------------------------------------------
// THE RULE THE BUG BROKE
// ---------------------------------------------------------------------------

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let CreatorNav: typeof import("../components/nav/creator-nav.tsx").CreatorNav;
let AppRouterContext: React.Context<unknown>;
/** next/link needs a router in context, as the other DOM tests provide. */
const ROUTER = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: async () => {} };

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://sendset.io/responses/x", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ CreatorNav } = await import("../components/nav/creator-nav.tsx"));
  ({ AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js") as unknown as { AppRouterContext: React.Context<unknown> });
});
after(() => dom.window.close());

async function nav(current?: "packets" | "library" | "new" | "settings") {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: ROUTER },
      React.createElement(CreatorNav, current ? { current } : {})));
  });
  // The tab itself, not the wrapper that holds it and the separator.
  const tab = (label: string) =>
    [...host.querySelectorAll("a, span")].find((el) => el.textContent === label && el.children.length === 0);
  const linkTo = (href: string) => host.querySelector(`a[href="${href}"]`);
  return { host, root, tab, linkTo };
}

test("the CURRENT tab is deliberately not a link — which is why a page must not claim one it is not", async () => {
  const { root, tab, linkTo } = await nav("packets");
  const here = tab("My Sendsets")!;
  assert.equal(here.tagName, "SPAN", "the current tab became a link; this test's premise moved");
  assert.equal(here.getAttribute("aria-current"), "page");
  // Which is the whole bug: from a page that CLAIMS this tab, there is no link
  // to the list at all.
  assert.equal(linkTo("/dashboard"), null);
  await act(async () => root.unmount());
});

test("with no tab claimed, every destination is a real link", async () => {
  const { root, tab, linkTo } = await nav();
  for (const [label, href] of [
    ["My Sendsets", "/dashboard"], ["Library", "/library"], ["New Sendset", "/new"], ["Your Details", "/settings"],
  ] as const) {
    const el = tab(label)!;
    assert.equal(el.tagName, "A", `${label} is not a link`);
    assert.equal(el.getAttribute("href"), href);
    assert.ok(linkTo(href), `nothing navigates to ${href}`);
  }
  await act(async () => root.unmount());
});

// ---------------------------------------------------------------------------
// THE RESPONSES PAGE
// ---------------------------------------------------------------------------

test("Responses claims no tab, so My Sendsets always navigates from it", () => {
  const page = codeOf(PAGE);
  assert.match(page, /<CreatorNav \/>/, "the Responses page claims a tab again");
  assert.doesNotMatch(page, /<CreatorNav\s+current=/, "a claimed tab is the bug: that tab stops being a link");
});

test("and it states the way back, as a link to the canonical list", () => {
  const page = codeOf(PAGE);
  assert.match(page, /href="\/dashboard"[\s\S]{0,320}Back to My Sendsets/, "no Back to My Sendsets link");
  // NOT history: somebody can arrive here from a direct link, a bookmark or an
  // email, where "back" is wherever they came from — or nowhere.
  assert.doesNotMatch(page, /history\.back|router\.back|window\.history/, "the way back is the browser's, not the page's");
  // It sits immediately above the Sendset's name.
  assert.ok(page.indexOf("Back to My Sendsets") < page.indexOf("{title}"), "the back link is below the name");
  assert.ok(page.indexOf("{title}") < page.indexOf("Responses</h1>"), "the name is not above the heading");
});

test("the Sendset's own name is not a link — back and open are different intentions", () => {
  const page = codeOf(PAGE);
  const nameLine = page.slice(page.indexOf("{title}") - 200, page.indexOf("{title}") + 20);
  assert.doesNotMatch(nameLine, /<Link|href=/, "the name navigates somewhere again");
  // The only link out of the page body is the way back.
  const body = page.slice(page.indexOf("<main"));
  assert.deepEqual([...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["/dashboard"]);
});

test("every creator page that is NOT a tab leaves the tabs alone", () => {
  // The editors and Preview already did this; the Responses page was the one
  // page that did not, which is exactly why it had no way back.
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx$/.test(p)) files.push(p); } };
  walk("src/app"); walk("src/components");
  const claims = files.filter((f) => /<CreatorNav\s+current=/.test(codeOf(f))).sort();
  assert.deepEqual(claims, [
    // Each of these IS the page its tab names.
    "src/app/settings/page.tsx",
    "src/components/library/library-workspace.tsx",
    "src/components/dashboard/dashboard-workspace.tsx",
    "src/components/new/new-packet-workspace.tsx",
  ].sort(), "a page claims a tab it is not");
});
