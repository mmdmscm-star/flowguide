// RECIPIENT RESPONSES — the one switch, in both editors.
//
// response_actions is a Sendset capability, not an editor capability. These
// pin that: ONE component, mounted by BOTH editors, off by default, never locked
// by publication, nowhere on Preview, and with nothing to configure but on/off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { RESPONSE_ACTIONS, acceptsResponses, parseResponseActions } from "./response-actions.ts";

const read = (p: string) => readFileSync(p, "utf8");
const LEGACY = read("src/components/editor/legacy-packet-editor.tsx");
const BLOCK = read("src/components/editor/block-packet-editor.tsx");
const COMPONENT = read("src/components/editor/recipient-responses-settings.tsx");
const ROUTE = read("src/app/api/packets/[id]/route.ts");
const MOUNT = /<RecipientResponsesSettings\b[^>]*\/>/g;

// --- the shared list ---------------------------------------------------------

test("the only v1 action is respond, and the database CHECK lists exactly the same", () => {
  assert.deepEqual([...RESPONSE_ACTIONS], ["respond"]);
  const sql = read("supabase/migrations/0058_sendset_responses.sql");
  const check = sql.match(/check \(response_actions <@ array\[([^\]]*)\]::text\[\]\)/);
  assert.ok(check, "0058 must constrain response_actions");
  assert.deepEqual(check[1].split(",").map((s) => s.trim().replace(/'/g, "")), [...RESPONSE_ACTIONS]);
  assert.match(sql, /response_actions text\[\] not null default '\{\}'/, "default must be off");
});

test("a stored value is on only when it really contains respond", () => {
  assert.equal(acceptsResponses(["respond"]), true);
  for (const v of [[], null, undefined, "respond", "{respond}", ["Respond"], {}]) {
    assert.equal(acceptsResponses(v), false, `${JSON.stringify(v)} must read as off`);
  }
});

test("the API accepts on, off and duplicates; refuses anything else", () => {
  assert.deepEqual(parseResponseActions(["respond"]), ["respond"]);
  assert.deepEqual(parseResponseActions([]), []);
  assert.deepEqual(parseResponseActions(["respond", "respond"]), ["respond"]);
  for (const v of [null, true, "respond", ["approve"], ["respond", "approve"], [1], [null], {}]) {
    assert.equal(parseResponseActions(v), null, `${JSON.stringify(v)} must be refused`);
  }
});

test("PATCH validates with the shared parser and refuses with a sentence", () => {
  assert.match(ROUTE, /import \{ parseResponseActions \} from "@\/lib\/response-actions"/);
  const block = ROUTE.slice(ROUTE.indexOf('if ("responseActions" in body)'));
  assert.match(block, /parseResponseActions\(body\.responseActions\)/);
  assert.match(block, /error: "invalid_response_actions"/);
  assert.match(block, /status: 400/);
  assert.match(block, /updates\["response_actions"\] = parsed;/, "must store the PARSED value, not the raw body");
});

// --- one component, both editors ---------------------------------------------

test("both editors mount the SAME component exactly once, with only its two props", () => {
  for (const [name, src, id, initial] of [
    ["legacy", LEGACY, "packet.id", "packet.responsesEnabled"],
    ["block", BLOCK, "packetId", "initialResponsesEnabled"],
  ] as const) {
    assert.match(src, /import \{ RecipientResponsesSettings \} from "\.\/recipient-responses-settings";/, `${name} imports it`);
    const mounts = src.match(MOUNT) ?? [];
    assert.equal(mounts.length, 1, `${name} mounts it once`);
    assert.equal(mounts[0], `<RecipientResponsesSettings packetId={${id}} initialEnabled={${initial}} />`,
      `${name} passes nothing else — no disabled, no readOnly, no options`);
  }
  // No editor carries its own copy of the switch.
  for (const src of [LEGACY, BLOCK]) {
    assert.doesNotMatch(src, /Allow responses|responseActions|role="switch"/);
  }
});

test("placement: legacy after the Sender chooser, both directly before Delete", () => {
  const sender = LEGACY.indexOf("{/* Sender chooser");
  const legacyMount = LEGACY.search(MOUNT);
  const legacyDelete = LEGACY.indexOf("<DeletePacketAction");
  assert.ok(sender > 0 && sender < legacyMount && legacyMount < legacyDelete);
  const blockMount = BLOCK.search(MOUNT);
  const blockDelete = BLOCK.indexOf("<DeletePacketAction");
  assert.ok(blockMount > 0 && blockMount < blockDelete);
  // Nothing but comments between the panel and Delete in either editor.
  for (const [src, m, d] of [[LEGACY, legacyMount, legacyDelete], [BLOCK, blockMount, blockDelete]] as const) {
    const between = src.slice(m, d).replace(MOUNT, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim();
    assert.equal(between, "", `unexpected markup between the panel and Delete: ${between}`);
  }
});

test("the block editor's panel is not inside a readOnly or status condition", () => {
  const mount = BLOCK.search(MOUNT);
  const deleteAt = BLOCK.indexOf("<DeletePacketAction");
  // The line that opens the panel's JSX expression (if any) must not be gated.
  const lead = BLOCK.slice(Math.max(0, mount - 800), mount).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.doesNotMatch(lead.slice(-120), /readOnly|status\s*[!=]==|&&\s*\(?\s*$/);
  assert.ok(deleteAt > mount);
});

test("both editors load the stored value — the block editor's explicit select names the column", () => {
  const data = read("src/lib/block-editor.ts");
  assert.match(data, /\.select\("[^"]*\bresponse_actions\b[^"]*"\)/);
  assert.match(data, /responsesEnabled: acceptsResponses\(/);
  assert.match(read("src/app/edit/[id]/page.tsx"), /initialResponsesEnabled=\{data\.responsesEnabled\}/);
  assert.match(LEGACY, /responsesEnabled: acceptsResponses\(p\.response_actions\)/);
});

// --- not on Preview, not anywhere else ----------------------------------------

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(tsx?|mts)$/.test(f) ? [p] : [];
  });
}

test("only the two editors mount it: not Preview, not the recipient page, not settings", () => {
  const mounters = [...filesUnder("src/app"), ...filesUnder("src/components")]
    .filter((p) => !p.includes("zz-scratch"))
    .filter((p) => read(p).includes("RecipientResponsesSettings"))
    .filter((p) => !p.endsWith("recipient-responses-settings.tsx"))
    .sort();
  assert.deepEqual(mounters, [
    "src/components/editor/block-packet-editor.tsx",
    "src/components/editor/legacy-packet-editor.tsx",
  ]);
  for (const p of [...filesUnder("src/app/preview"), "src/components/preview-actions.tsx", "src/components/preview-surface.tsx"]) {
    assert.doesNotMatch(read(p), /response_actions|responseActions|Allow responses/i, `${p} must not carry the toggle`);
  }
});

test("the component offers on/off and nothing else", () => {
  assert.equal((COMPONENT.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(COMPONENT, /<input\b|<select\b|<textarea\b/);
  assert.match(COMPONENT, /body: JSON\.stringify\(\{ responseActions: next \? \["respond"\] : \[\] \}\)/);
  // Immediate: nothing in the component's code waits on, or asks for, a publish.
  assert.doesNotMatch(COMPONENT.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, ""), /publish/i);
});

// --- the component's behaviour -------------------------------------------------

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Settings: typeof import("../components/editor/recipient-responses-settings.tsx").RecipientResponsesSettings;
const patches: { url: string; body: string }[] = [];
let nextStatus = 200;
let release: (() => void) | null = null;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://example.test/edit/x", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    patches.push({ url, body: String(init?.body) });
    await new Promise<void>((r) => { release = r; });
    return { ok: nextStatus < 400, status: nextStatus, json: async () => ({}) };
  }) as unknown as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ RecipientResponsesSettings: Settings } = await import("../components/editor/recipient-responses-settings.tsx"));
});
after(() => dom.window.close());

async function mount(initialEnabled: boolean) {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Settings, { packetId: "p-1", initialEnabled })); });
  const sw = host.querySelector('[role="switch"]') as HTMLButtonElement;
  return { host, root, sw };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const settle = () => act(async () => { release?.(); release = null; await new Promise((r) => setTimeout(r, 0)); });

test("renders the approved copy, off, and says so to assistive tech", async () => {
  const { host, root, sw } = await mount(false);
  assert.equal(host.querySelector("h2")?.textContent, "Recipient responses");
  assert.equal(sw.getAttribute("aria-checked"), "false");
  assert.equal(host.querySelector(`#${CSS_escape(sw.getAttribute("aria-labelledby")!)}`)?.textContent, "Allow responses");
  assert.equal(host.querySelector(`#${CSS_escape(sw.getAttribute("aria-describedby")!)}`)?.textContent,
    "People viewing this Sendset can send you a message. You can turn this off anytime.");
  assert.equal(sw.disabled, false);
  await act(async () => root.unmount());
});

test("turning on writes immediately; turning off writes the empty list", async () => {
  patches.length = 0; nextStatus = 200;
  const { host, root, sw } = await mount(false);
  await click(sw);
  assert.equal(sw.getAttribute("aria-checked"), "true", "moves at once");
  assert.equal(sw.disabled, true, "no double submit while saving");
  assert.match(host.textContent!, /Saving…/);
  await settle();
  assert.match(host.textContent!, /Saved/);
  await click(sw);
  await settle();
  assert.equal(sw.getAttribute("aria-checked"), "false");
  assert.deepEqual(patches, [
    { url: "/api/packets/p-1", body: '{"responseActions":["respond"]}' },
    { url: "/api/packets/p-1", body: '{"responseActions":[]}' },
  ]);
  await act(async () => root.unmount());
});

test("a failed write moves the switch back and says it was not saved", async () => {
  patches.length = 0; nextStatus = 500;
  const { host, root, sw } = await mount(true);
  await click(sw);
  assert.equal(sw.getAttribute("aria-checked"), "false");
  await settle();
  assert.equal(sw.getAttribute("aria-checked"), "true", "position matches what is actually stored");
  assert.equal(host.querySelector('[role="alert"]')?.textContent?.trim(), "Not saved");
  assert.equal(sw.disabled, false, "can try again");
  await act(async () => root.unmount());
});

function CSS_escape(s: string) { return s.replace(/([^\w-])/g, "\\$1"); }
