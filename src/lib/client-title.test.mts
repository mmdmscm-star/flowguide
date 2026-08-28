import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import { buildClientMessage } from "./client-message.ts";
import type { Packet } from "./types.ts";

// THE NAME A PROFESSIONAL FILES IT UNDER IS NOT THE TITLE A CLIENT READS.
//
// Both cases the founder named, carried through every surface that used to
// print packets.title at a recipient:
//
//   1. internal "Options for Bonnie Smith", NO client title  -> no heading
//   2. internal "Options for Bonnie Smith", client title
//      "Senior Living Communities"                           -> that heading
//
// In both, the internal name must appear nowhere a client can see. That is the
// assertion that matters: a renderer left on the old field would still show a
// heading and still look right, and only this catches it.

const INTERNAL = "Options for Bonnie Smith";
const CLIENT = "Senior Living Communities";
const LIVE = "https://flowguide.example.com/p/abc";

const base = {
  slug: "abc",
  title: INTERNAL,
  clientName: "the Smith family",
  compositionMode: "legacy",
  professional: { name: "Dana Whitfield", businessName: "Whitfield Senior Advisors" },
  sections: [{ id: "s1", title: "Communities", items: [{ id: "i1", title: "Vine Ridge" }] }],
};
const NO_CLIENT_TITLE = { ...base } as unknown as Packet;
const WITH_CLIENT_TITLE = { ...base, clientTitle: CLIENT } as unknown as Packet;

const codeOf = (p: string) => readFileSync(p, "utf8");
const bodyOf = (p: string) => codeOf(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// EMAIL — HTML and plain text
// ---------------------------------------------------------------------------
test("EMAIL, no client title: no heading, and the internal name does not appear", () => {
  const html = renderPacketEmail(NO_CLIENT_TITLE, { liveUrl: LIVE });
  assert.ok(!html.includes(INTERNAL), "the internal FlowGuide name reached the client's email");
  assert.doesNotMatch(html, /<h1[^>]*>\s*<\/h1>/, "an empty heading was emitted instead of none");
  assert.doesNotMatch(html, /<h1/, "a heading was rendered when none was chosen");
  // ...and the rest of the email is intact.
  assert.ok(html.includes("WHITFIELD SENIOR ADVISORS") && html.includes("Vine Ridge"));
});

test("EMAIL, with a client title: that heading, and only that", () => {
  const html = renderPacketEmail(WITH_CLIENT_TITLE, { liveUrl: LIVE });
  assert.ok(html.includes(CLIENT), "the chosen client title is missing");
  assert.ok(!html.includes(INTERNAL), "the internal name reached the client's email");
  assert.match(html, /<h1[^>]*>Senior Living Communities<\/h1>/);
});

test("EMAIL plain text follows the same rule", () => {
  const without = renderPacketEmailText(NO_CLIENT_TITLE, { liveUrl: LIVE });
  assert.ok(!without.includes(INTERNAL), "the internal name reached the plain-text email");
  // No blank heading line: the business name is followed straight by the rest.
  assert.doesNotMatch(without, /WHITFIELD SENIOR ADVISORS\n\s*\n\s*\n/, "a hole was left where the heading was");
  const withIt = renderPacketEmailText(WITH_CLIENT_TITLE, { liveUrl: LIVE });
  assert.ok(withIt.includes(CLIENT) && !withIt.includes(INTERNAL));
});

// ---------------------------------------------------------------------------
// CLIENT MESSAGE — the copy-and-send text
// ---------------------------------------------------------------------------
test("CLIENT MESSAGE uses the client title, and reads naturally without one", () => {
  const withIt = buildClientMessage({ clientName: "Bonnie", title: CLIENT, professionalName: "Dana", url: LIVE });
  assert.ok(withIt.includes(CLIENT) && !withIt.includes(INTERNAL));
  const without = buildClientMessage({ clientName: "Bonnie", title: "", professionalName: "Dana", url: LIVE });
  assert.ok(!without.includes(INTERNAL), "the internal name reached the message");
  assert.match(without, /I've put this together for you/, "the blank-title wording is not the natural one");
  assert.doesNotMatch(without, /put together\s+for you/, "a gap was left where the title would be");
});

test("PREVIEW hands the SHARE PANEL the client title, not the internal name", () => {
  const preview = bodyOf("src/app/preview/[id]/page.tsx");
  assert.ok(!/title=\{packet\.title\}/.test(preview),
    "preview still passes the internal name to a recipient-facing surface");
  assert.equal((preview.match(/title=\{packet\.clientTitle\}/g) ?? []).length, 2,
    "both the header and the share panel must take the client title");
});

// ---------------------------------------------------------------------------
// WEB — the real PacketHeader, rendered
// ---------------------------------------------------------------------------
let dom: JSDOM;
let React: typeof import("react");
let renderToStaticMarkup: (n: unknown) => string;
let PacketHeader: typeof import("../components/packet-header.tsx").PacketHeader;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  React = await import("react");
  ({ renderToStaticMarkup } = await import("react-dom/server") as unknown as
    { renderToStaticMarkup: (n: unknown) => string });
  ({ PacketHeader } = await import("../components/packet-header.tsx"));
});
after(() => { dom?.window?.close(); });

const header = (title?: string) => renderToStaticMarkup(React.createElement(PacketHeader, {
  title, clientName: "the Smith family",
  professional: { name: "Dana Whitfield", businessName: "Whitfield Senior Advisors" } as never,
}));

test("WEB, no client title: the heading element is absent, not empty", () => {
  const html = header(undefined);
  assert.doesNotMatch(html, /<h1/, "an empty heading was rendered");
  assert.ok(html.includes("Whitfield Senior Advisors"), "the professional's identity was lost with it");
  assert.ok(html.includes("Prepared for the Smith family"), "the rest of the header was lost");
  assert.ok(!html.includes(INTERNAL));
});

test("WEB, blank string behaves the same as absent", () => {
  assert.doesNotMatch(header("   "), /<h1/, "whitespace was treated as a title");
});

test("WEB, with a client title: it is the heading", () => {
  const html = header(CLIENT);
  assert.match(html, /<h1[^>]*>Senior Living Communities<\/h1>/);
  assert.ok(!html.includes(INTERNAL));
});

test("WEB: the recipient page passes the CLIENT title", () => {
  const page = bodyOf("src/app/p/[slug]/page.tsx");
  assert.match(page, /title=\{packet\.clientTitle\}/,
    "the live recipient page still renders the internal name");
  assert.ok(!/title=\{packet\.title\}/.test(page));
});

// ---------------------------------------------------------------------------
// PRINT — source gate, since the renderer is a .tsx server component
// ---------------------------------------------------------------------------
test("PRINT renders the client title, and omits the heading when blank", () => {
  const print = bodyOf("src/components/print/print-packet.tsx");
  assert.match(print, /has\(packet\.clientTitle\)\s*&&\s*<h1 className="pg-title">/,
    "print does not gate its heading on the client title");
  assert.ok(!/pg-title">\{packet\.title\}/.test(print),
    "print still puts the internal name on paper");
});

// ---------------------------------------------------------------------------
// BACKSTAGE — unchanged, and still the internal name
// ---------------------------------------------------------------------------
test("PUBLISHING requires the internal name and never the client title", () => {
  const publish = bodyOf("src/app/api/packets/[id]/publish/route.ts");
  assert.match(publish, /if \(!packet\.title\?\.trim\(\)\)/, "publish no longer requires an internal name");
  assert.ok(!/client_title/.test(publish), "publish now demands a client-facing title");
});

test("THE DASHBOARD AND SEARCH still use the internal name", () => {
  const filter = bodyOf("src/lib/packet-filter.ts");
  assert.match(filter, /\[p\.title, p\.client_name, p\.slug\]/, "search stopped matching the internal name");
  assert.ok(!/client_title/.test(filter), "search leaked the client-facing title into backstage matching");
  const dash = bodyOf("src/components/dashboard/dashboard-workspace.tsx");
  assert.match(dash, /packet\.title \|\| "Untitled Packet"/, "the list stopped showing the internal name");
});

test("DUPLICATION marks only the internal name with (Copy)", () => {
  const dup = bodyOf("src/app/api/packets/[id]/duplicate/route.ts");
  assert.match(dup, /title: original\.title \? `\$\{original\.title\} \(Copy\)` : ""/);
  assert.match(dup, /client_title: original\.client_title \|\| ""/,
    "the client title is not copied, or is copied with (Copy) appended");
  assert.ok(!/client_title:[^\n]*\(Copy\)/.test(dup),
    "(Copy) would be published to the recipient as part of their heading");
});

test("THE EDITOR CAN SET BOTH, and says which is which", () => {
  const editor = codeOf("src/components/editor/legacy-packet-editor.tsx");
  assert.match(editor, /FlowGuide name/, "the internal field is not labelled");
  assert.match(editor, /Title your client sees/, "the client-facing field is not labelled");
  assert.match(editor, /updatePacketField\("clientTitle"/, "the client title cannot be edited");
  assert.match(editor, /Only you see this/, "nothing tells the professional the name stays backstage");
  assert.match(editor, /Leave blank and your client sees no title at all/,
    "blank is not explained as a choice");
  // ...and it reaches the API, which must accept it.
  const route = bodyOf("src/app/api/packets/[id]/route.ts");
  assert.match(route, /clientTitle: "client_title"/, "PATCH will not persist the client title");
});

test("THE MIGRATION KEEPS client_title OUT of the ingestion revision tuple", () => {
  const mig = readFileSync("supabase/migrations/0037_packet_client_title.sql", "utf8");
  const sql = mig.replace(/^--.*$/gm, "");
  assert.ok(!/ingest_bump_packet_self/.test(sql),
    "the migration alters the revision trigger, which would make a heading edit abort an import");
  assert.match(sql, /add column client_title text not null default ''/);
  // Existing FlowGuides keep the heading they already show.
  assert.match(sql, /set client_title = title/);
  // ...without every dashboard reordering.
  assert.match(sql, /disable trigger update_packets_updated_at/);
  assert.match(sql, /enable trigger update_packets_updated_at/);
});

test("EXISTING FLOWGUIDES render exactly as before, because the backfill copied the title", () => {
  // What the backfill produces: client_title === title. Both surfaces then show
  // what they showed before this change existed.
  const migrated = { ...base, clientTitle: INTERNAL } as unknown as Packet;
  assert.ok(renderPacketEmail(migrated, { liveUrl: LIVE }).includes(INTERNAL),
    "a pre-existing FlowGuide lost its heading in email");
  assert.match(header(INTERNAL), /<h1[^>]*>Options for Bonnie Smith<\/h1>/,
    "a pre-existing FlowGuide lost its heading on the web");
});

// ---------------------------------------------------------------------------
// BLOCK COMPOSITION — the same distinction, in the other supported mode.
//
// Block mode showed the internal name as a read-only heading and had no
// packet-level field at all, so "Title your client sees" was reachable in
// legacy mode only. These prove the one field that was missing, including the
// case that is easy to get wrong: CLEARING it back to blank, where an empty
// string must survive the PATCH rather than being dropped as falsy.
// ---------------------------------------------------------------------------
test("BLOCK MODE: the client title is loaded, editable, and clearable", () => {
  const editor = codeOf("src/components/editor/block-packet-editor.tsx");
  assert.match(editor, /clientTitle: string;/, "the block editor does not accept a client title");
  assert.match(editor, /Title your client sees/, "the field is not labelled");
  assert.match(editor, /useState\(initialClientTitle\)/, "an existing client title is not loaded into the field");
  assert.match(editor, /body: JSON\.stringify\(\{ clientTitle: next \}\)/,
    "it does not save through the shared clientTitle -> client_title PATCH");
  // Clearing must send the empty string. `next || undefined`, or any falsy
  // guard around the send, would leave a heading the professional deleted.
  assert.ok(!/clientTitle: next \|\|/.test(editor),
    "an emptied client title would be dropped instead of clearing the heading");
  assert.ok(!/if \(!next\)/.test(editor.slice(editor.indexOf("function updateClientTitle"))),
    "clearing is guarded away rather than saved");
});

test("BLOCK MODE: the internal name stays backstage and is not repurposed", () => {
  const editor = codeOf("src/components/editor/block-packet-editor.tsx");
  // The internal name is still displayed as the editor's own heading...
  assert.match(editor, /\{title \|\| "Untitled Packet"\}/, "the block editor stopped showing the internal name");
  assert.match(editor, /Only you see this name/, "nothing says the name is backstage");
  // ...and is NOT wired to the client-facing field.
  assert.ok(!/value=\{title\}/.test(editor), "the internal name became an editable client-facing field");
});

test("BLOCK MODE: the loader and the page carry the client title through", () => {
  const loader = bodyOf("src/lib/block-editor.ts");
  assert.match(loader, /select\("id, title, client_title, status/, "the loader does not read client_title");
  assert.match(loader, /clientTitle: \(packet as \{ client_title\?: string \}\)\.client_title \|\| ""/);
  const page = bodyOf("src/app/edit/[id]/page.tsx");
  assert.match(page, /clientTitle=\{data\.clientTitle\}/, "the page does not pass it to the editor");
});

test("BLOCK MODE frontstage: a block packet with no client title shows no heading", () => {
  // The recipient renderer is shared, so what a block packet renders is decided
  // by the same PacketHeader and the same field.
  const blockNoTitle = { ...base, compositionMode: "blocks", blocks: [] } as unknown as Packet;
  assert.ok(!renderPacketEmail(blockNoTitle, { liveUrl: LIVE }).includes(INTERNAL),
    "a block packet leaked its internal name");
  assert.doesNotMatch(header(undefined), /<h1/);

  const blockWithTitle = { ...base, compositionMode: "blocks", blocks: [], clientTitle: CLIENT } as unknown as Packet;
  const html = renderPacketEmail(blockWithTitle, { liveUrl: LIVE });
  assert.ok(html.includes(CLIENT) && !html.includes(INTERNAL));
  assert.match(header(CLIENT), /<h1[^>]*>Senior Living Communities<\/h1>/);
});
