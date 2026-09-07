// THE MAP LINK IS PACKET CONTENT, AND CONTENT REACHES EVERY RENDERER.
//
// `packets.map_url` has existed since the first schema and has always rendered
// on the recipient's web page. Print, HTML email and plain-text email dropped
// it silently — not with an error, not with a placeholder, just absent — and
// the field was reachable only from the legacy editor, so a block packet could
// carry a map link its owner had no way to remove.
//
// Both of those are the same defect: ONE canonical packet, presented by
// renderers that disagree about what is in it. What is pinned here is that all
// five renderers carry the same fact, that both editors can write it, and that
// the per-item address link is built in exactly one place.
//
// WHAT IS DELIBERATELY NOT HERE: geocoding, coordinates, a provider account, a
// key, an embedded map, or any derived multi-address control. The last test in
// this file fails if any of them appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import { addressMapUrl, packetMapUrl } from "./maps-url.ts";
import { ItemCard } from "../components/item-card.tsx";
import { PrintPacket } from "../components/print/print-packet.tsx";
import type { Packet } from "./types.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");

// A distinctive value, so a renderer that emits SOMETHING map-shaped by
// coincidence cannot pass. An empty-string fixture would let every assertion
// succeed against a renderer that dropped the field entirely.
const MAP = "https://www.google.com/maps/d/edit?mid=SLICE1-DISTINCTIVE-MID";
const ADDRESS = "41 Mill Street & Wharf, Harlow Bend";
const LIVE = "https://sendset.io/p/abc123";

const PACKET = {
  slug: "abc123",
  title: "INTERNAL name",
  clientTitle: "Venue Options",
  clientName: "the Northbeam team",
  personalNote: "Here are the three I'd start with.",
  mapUrl: MAP,
  compositionMode: "legacy",
  professional: { name: "Dana Whitfield", email: "d@example.com", phone: "(206) 555-0100" },
  sections: [{
    id: "s1", title: "Recommended", description: "",
    items: [{ id: "i1", title: "The Foundry", address: ADDRESS, description: "A converted works." }],
  }],
} as unknown as Packet;

const html = renderPacketEmail(PACKET, { liveUrl: LIVE });
const text = renderPacketEmailText(PACKET, { liveUrl: LIVE });
const print = renderToStaticMarkup(
  React.createElement(PrintPacket, { packet: PACKET, liveUrl: LIVE } as never),
);

// ---------------------------------------------------------------------------
// 1. NO RENDERER SILENTLY DROPS IT
// ---------------------------------------------------------------------------

test("EVERY RENDERER CARRIES THE PACKET'S MAP LINK", () => {
  // The two that always did. These are server components that load their own
  // data, so the source is the honest witness — and it is the same source the
  // production page runs.
  for (const path of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"]) {
    const src = codeOf(path);
    assert.match(src, /packetMapUrl\(packet\??\.mapUrl\)/, `${path} no longer reads the map link`);
    assert.match(src, /\{packetMap && \(/, `${path} no longer guards on it`);
    assert.match(src, /href=\{packetMap\}/, `${path} no longer links the map`);
  }

  // The three that dropped it. Rendered output, not source: the point is that
  // the VALUE arrives, not that the field is mentioned.
  assert.ok(html.includes(MAP), "HTML email dropped the map link");
  assert.ok(text.includes(MAP), "plain-text email dropped the map link");
  assert.ok(print.includes("SLICE1-DISTINCTIVE-MID"), "print dropped the map link");
});

test("AND A PACKET WITHOUT ONE GAINS NOTHING", () => {
  // The other half of "no silent drop": no placeholder, no empty label, no
  // link to nowhere. A missing map is missing, not blank.
  const bare = { ...PACKET, mapUrl: "" } as unknown as Packet;
  const h = renderPacketEmail(bare, { liveUrl: LIVE });
  const t = renderPacketEmailText(bare, { liveUrl: LIVE });
  const p = renderToStaticMarkup(
    React.createElement(PrintPacket, { packet: bare, liveUrl: LIVE } as never),
  );
  assert.ok(!h.includes("View the map"), "HTML email emitted an empty map row");
  assert.ok(!/\bMap:/.test(t), "plain-text email emitted an empty map line");
  assert.ok(!/>Map:</.test(p) && !/Map: <b>/.test(p), "print emitted an empty map line");
});


// ---------------------------------------------------------------------------
// 2. THE VALUE IS NOT REWRITTEN ON THE WAY
// ---------------------------------------------------------------------------

test("THE PROFESSIONAL'S LINK ARRIVES AS THEY WROTE IT", () => {
  // No normalising, no prefixing, no tracking parameter, no shortening. The
  // href is the stored string. Print shows a READABLE form — scheme and www
  // stripped, because paper is read by a person — but the identifying part
  // survives, which is what a reader has to type.
  assert.ok(html.includes(`href="${MAP}"`), "the HTML href is not the stored value");
  assert.ok(text.includes(`Map: ${MAP}`), "the plain-text URL is not the stored value");
  assert.ok(print.includes("google.com/maps/d/edit?mid=SLICE1-DISTINCTIVE-MID"),
    "print mangled the URL past recognition");
});

test("PRINT LABELS THE LINK WITHOUT DESCRIBING WHAT IS BEHIND IT", () => {
  // Paper cannot open a link, so a bare URL needs a label. But the label may
  // not claim the map shows the items — no renderer has seen what the
  // professional linked to.
  assert.match(print, /Map: <b>/, "print printed the URL with no label at all");
  assert.ok(!/Map of (the|these)/i.test(print),
    "print asserts what the map contains, which it cannot know");
});

// ---------------------------------------------------------------------------
// 3. ONE HELPER FOR THE PER-ITEM ADDRESS LINK
// ---------------------------------------------------------------------------

test("WEB AND EMAIL BUILD THE ITEM ADDRESS LINK IDENTICALLY", () => {
  const card = renderToStaticMarkup(
    React.createElement(ItemCard, { item: PACKET.sections[0].items[0] } as never),
  );
  const grab = (s: string) => {
    const m = s.match(/https:\/\/www\.google\.com\/maps\/search\/[^"]*/);
    return m ? m[0].replace(/&amp;/g, "&") : null;
  };
  const fromCard = grab(card);
  const fromEmail = grab(html);
  assert.ok(fromCard, "the web card no longer links the address");
  assert.ok(fromEmail, "the email no longer links the address");
  // THE POINT OF THE SLICE. These were two hand-built strings in two files,
  // with nothing making them agree; now one helper decides, and this fails the
  // moment either surface starts building its own again.
  assert.equal(fromCard, fromEmail, "web and email disagree about the same address");
  assert.equal(fromCard, addressMapUrl(ADDRESS), "neither matches the shared helper");
});

test("AND NEITHER FILE KNOWS HOW TO BUILD ONE", () => {
  // The divergence is only really closed if the old code is gone, not merely
  // unused. Exactly one file in src/ may name the provider's search URL.
  const owners = ["src/components/item-card.tsx", "src/lib/email-render.ts"];
  for (const f of owners) {
    const src = codeOf(f);
    assert.ok(!src.includes("google.com/maps"), `${f} still builds its own map URL`);
    assert.match(src, /addressMapUrl/, `${f} does not use the shared helper`);
  }
});

test("THE HELPER ESCAPES WHAT AN ADDRESS ACTUALLY CONTAINS", () => {
  // "&" is the one that silently truncates a query, and real addresses have
  // it. This is why the encode is not hand-rolled.
  const url = addressMapUrl("Smith & Sons, Apt #3, A+B Court")!;
  assert.ok(url.includes("%26") && url.includes("%23") && url.includes("%2B"),
    "an address with &, # or + would reach the provider corrupted");
  assert.equal(addressMapUrl(""), null, "a blank address produced a link to nothing");
  assert.equal(addressMapUrl("   "), null, "a whitespace address produced a link to nothing");
  assert.equal(addressMapUrl(undefined), null);
});

test("THE SOURCE ADDRESS TEXT IS SHOWN AS AUTHORED", () => {
  // The link is derived; the address is the fact. Both renderers show the
  // professional's own words, not a normalised or re-cased version.
  const card = renderToStaticMarkup(
    React.createElement(ItemCard, { item: PACKET.sections[0].items[0] } as never),
  );
  const shown = ADDRESS.replace(/&/g, "&amp;");
  assert.ok(card.includes(shown), "the web card rewrote the address text");
  assert.ok(html.includes(shown), "the email rewrote the address text");
  assert.ok(text.includes(ADDRESS), "the plain-text email rewrote the address text");
  assert.ok(print.includes(shown), "print rewrote the address text");
});

// ---------------------------------------------------------------------------
// 4. BOTH EDITORS CAN WRITE IT
// ---------------------------------------------------------------------------

test("THE BLOCK EDITOR CAN ROUND-TRIP THE MAP LINK", () => {
  // Read: the loader selects the column and returns it, and the route hands it
  // to the editor. Without any one of these the field renders permanently
  // blank and "clearing" it would wipe a link the owner never saw.
  const loader = codeOf("src/lib/block-editor.ts");
  assert.match(loader, /select\("[^"]*map_url/, "the loader does not read the column");
  assert.match(loader, /mapUrl: \(packet as \{ map_url\?: string \}\)\.map_url \|\| ""/,
    "the loader does not return the value");
  assert.match(codeOf("src/app/edit/[id]/page.tsx"), /mapUrl=\{data\.mapUrl\}/,
    "the route does not pass the value to the editor");

  // Write: bound input, and the same PATCH field the legacy editor sends.
  const ed = codeOf("src/components/editor/block-packet-editor.tsx");
  assert.match(ed, /value=\{mapUrl\}/, "the input is not bound to the loaded value");
  assert.match(ed, /onChange=\{\(e\) => updateMapUrl\(e\.target\.value\)\}/);
  assert.match(ed, /JSON\.stringify\(\{ mapUrl: next \}\)/,
    "the block editor does not PATCH the same field name");
  // REMOVE, not just add and edit: `next` is sent whatever it is, so an
  // emptied box clears the column instead of being dropped as falsy.
  assert.ok(!/mapUrl: next \|\|/.test(ed) && !/if \(next\) .*mapUrl/.test(ed),
    "an emptied map field would not clear the stored value");
});

test("THE LEGACY FIELD IS PRESERVED", () => {
  // The field, its label and its placeholder stay exactly where they were —
  // this slice was never allowed to move or remove them. What changed is the
  // WRITER: it now applies the shared rule before sending, like the block
  // editor, so a half-typed URL is held rather than answered with a failure.
  const ed = codeOf("src/components/editor/legacy-packet-editor.tsx");
  assert.match(ed, /Map Link \(optional\)/, "the legacy field lost its label");
  assert.match(ed, /placeholder="Paste a Google My Maps or any map link"/,
    "the legacy field lost its placeholder");
  assert.match(ed, /value=\{packet\.mapUrl\}/, "the legacy field lost its binding");
  assert.match(ed, /onChange=\{\(e\) => updateMapUrl\(e\.target\.value\)\}/,
    "the legacy field lost its writer");
  assert.match(ed, /JSON\.stringify\(\{ mapUrl: value \}\)/,
    "the legacy editor does not PATCH the same field name");
  assert.match(ed, /mapUrl: p\.map_url \|\| ""/, "the legacy editor stopped loading the column");
});

test("BOTH EDITORS WRITE THE SAME COLUMN THROUGH THE SAME ROUTE", () => {
  // Two editors, one field. If this ever became two API keys or two columns it
  // would be a second source of truth for where the places are.
  const api = codeOf("src/app/api/packets/[id]/route.ts");
  assert.match(api, /mapUrl: "map_url"/, "the PATCH route stopped mapping the field");
  assert.equal((api.match(/"map_url"/g) ?? []).length, 1, "map_url is written in more than one way");
});

// ---------------------------------------------------------------------------
// 5. WHAT THIS SLICE PROMISED NOT TO DO
// ---------------------------------------------------------------------------

test("NO GEOCODING, NO COORDINATES, NO PROVIDER ACCOUNT, NO EMBEDDED MAP", () => {
  const touched = [
    "src/lib/maps-url.ts",
    "src/components/item-card.tsx",
    "src/lib/email-render.ts",
    "src/components/print/print-packet.tsx",
    "src/components/editor/block-packet-editor.tsx",
    "src/lib/block-editor.ts",
  ].map(codeOf).join("\n");

  // Code, not prose: the comments in these files discuss geocoding precisely to
  // rule it out, so the ban is on the machinery.
  const code = touched.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const banned of [/geocod/i, /\blatitude\b/i, /\blongitude\b/i, /\bAPI_KEY\b/,
                        /process\.env\.[A-Z_]*MAP/, /<iframe/i, /staticmap/i,
                        /maps\.googleapis\.com/i, /mapbox/i, /leaflet/i]) {
    assert.ok(!banned.test(code), `the maps slice introduced ${banned}`);
  }

  // No dependency was added for any of it.
  const pkg = JSON.parse(codeOf("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(!deps.some((d) => /map|leaflet|mapbox|geo|tile/i.test(d)),
    `a map/geo dependency appeared: ${deps.join(", ")}`);
});

test("NO SCHEMA MIGRATION WAS INTRODUCED", () => {
  // The field already existed. A migration here would mean the slice changed
  // what a packet IS, which it does not.
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  const highest = migrations[migrations.length - 1];
  assert.equal(highest, "0049_packet_style_treatment.sql",
    `a migration was added: ${highest}`);
});

test("THE DERIVED MULTI-ADDRESS CONTROL WAS NOT BUILT", () => {
  // Banked for Slice 2, behind provider-semantics questions this slice has not
  // answered — in particular whether a multi-stop directions URL can honestly
  // be labelled a map of all the locations.
  const surfaces = ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx",
                    "src/lib/email-render.ts", "src/components/print/print-packet.tsx"]
    .map(codeOf).join("\n");
  assert.ok(!/See all locations/i.test(surfaces), "the Slice 2 control appeared early");
  assert.ok(!/maps\/dir|waypoints=/i.test(surfaces),
    "a multi-stop directions URL was introduced without choosing route semantics");
});

// ---------------------------------------------------------------------------
// 6. ONE SAFETY RULE, NOT FIVE
//
// `map_url` is free text reaching five renderers. Before this, web and Preview
// put the raw column value in an href while email and print each applied their
// own local http(s) check — so the same stored value could be a live link on
// one surface and absent on another. The rule now lives in one function, and
// the same function guards the write.
// ---------------------------------------------------------------------------

/** Every value a renderer must agree about, and what the shared rule says. */
const CASES: Array<[label: string, stored: string, renderable: boolean]> = [
  ["ordinary https", "https://maps.example.com/x?a=1&b=2", true],
  ["plain http", "http://maps.example.com/x", true],
  ["a My Maps link with a query", MAP, true],
  ["an unusual but real host", "https://kort.kommune.no/plan/site-42", true],
  ["a deep path and fragment", "https://osm.org/#map=17/51.5/-0.1", true],
  ["blank", "", false],
  ["whitespace only", "   ", false],
  ["javascript:", "javascript:alert(1)", false],
  ["data:", "data:text/html;base64,PHNjcmlwdD4=", false],
  ["a bare domain with no scheme", "maps.example.com/x", false],
  ["a scheme with no host", "https://", false],
  ["free text a professional might paste", "see the map I emailed you", false],
  ["a file path", "file:///Users/me/map.png", false],
  // A NON-HTTP SCHEME WITH A REAL HOST. javascript:, data: and file: all parse
  // with an empty hostname, so a host check alone appears to refuse everything
  // — until a scheme like this one, which has a perfectly good host and is
  // still not something a recipient's browser will open as a map. Found by
  // mutating the protocol check away and watching nothing fail.
  ["another scheme with a real host", "ftp://maps.example.com/plan.pdf", false],
  ["a mail link", "mailto:someone@example.com", false],
];

test("ALL FIVE RENDERERS AGREE ABOUT EVERY VALUE", () => {
  // The strongest form of the claim: not "each renderer is safe" but "no two
  // renderers disagree". A per-file check could pass while the five still
  // differed; this cannot.
  for (const [label, stored, renderable] of CASES) {
    const pk = { ...PACKET, mapUrl: stored } as unknown as Packet;
    const h = renderPacketEmail(pk, { liveUrl: LIVE });
    const t = renderPacketEmailText(pk, { liveUrl: LIVE });
    const pr = renderToStaticMarkup(
      React.createElement(PrintPacket, { packet: pk, liveUrl: LIVE } as never),
    );

    const inHtml = h.includes("View the map");
    const inText = /^Map: /m.test(t);
    const inPrint = /Map: <b>/.test(pr);

    assert.equal(inHtml, renderable, `HTML email disagrees on ${label}`);
    assert.equal(inText, renderable, `plain-text email disagrees on ${label}`);
    assert.equal(inPrint, renderable, `print disagrees on ${label}`);
    assert.equal(Boolean(packetMapUrl(stored)), renderable, `the shared rule disagrees on ${label}`);

    // And nothing dangerous survives anywhere, whatever the shape.
    const distinctive = stored.trim().length > 12 && !/^https?:\/\/$/.test(stored.trim());
    if (!renderable && distinctive) {
      for (const [name, out] of [["html", h], ["text", t], ["print", pr]] as const) {
        assert.ok(!out.includes(stored.trim()), `${name} emitted the refused value for ${label}`);
      }
    }
  }
});

test("WEB AND PREVIEW APPLY THE SHARED RULE TOO", () => {
  // These two load their own data, so their source is the witness — but the
  // witness is specific: they must render the CHECKED value, not the column.
  for (const path of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"]) {
    const src = codeOf(path);
    assert.match(src, /packetMapUrl\(packet\??\.mapUrl\)/, `${path} does not apply the shared rule`);
    assert.match(src, /href=\{packetMap\}/, `${path} does not render the checked value`);
    assert.ok(!/href=\{packet\.mapUrl\}/.test(src),
      `${path} still puts the raw stored value in an href`);
  }
});

test("A VALID LINK IS RENDERED UNCHANGED — NOT NORMALIZED", () => {
  // new URL().href would append a trailing slash, lowercase the host and
  // re-encode the query. The professional's link is the fact; the rule decides
  // whether to show it, never what it should look like.
  const fussy = "https://Maps.Example.COM/a%20b?q=1&r=2#frag";
  assert.equal(packetMapUrl(fussy), fussy, "the shared rule rewrote the URL");
  const pk = { ...PACKET, mapUrl: fussy } as unknown as Packet;
  assert.ok(renderPacketEmail(pk, { liveUrl: LIVE }).includes(`href="${fussy.replace(/&/g, "&amp;")}"`),
    "HTML email rewrote the URL");
  assert.ok(renderPacketEmailText(pk, { liveUrl: LIVE }).includes(`Map: ${fussy}`),
    "plain-text email rewrote the URL");
  // Surrounding whitespace is dropped for rendering; the stored row is not
  // touched by anything here.
  assert.equal(packetMapUrl("  https://example.com/m  "), "https://example.com/m");
});

test("THE RULE IS NOT PROVIDER OR DOMAIN SPECIFIC", () => {
  const helper = codeOf("src/lib/maps-url.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const fn = helper.slice(helper.indexOf("export function packetMapUrl"));
  for (const provider of [/google/i, /apple/i, /openstreetmap/i, /osm/i, /mapbox/i, /bing/i]) {
    assert.ok(!provider.test(fn), `packetMapUrl hard-codes ${provider}`);
  }
  // Any host passes, including ones nobody thought of.
  assert.ok(packetMapUrl("https://kartta.example.fi/kohde/9"));
  assert.ok(packetMapUrl("https://192.0.2.10:8443/site-plan.pdf"));
});

// ---------------------------------------------------------------------------
// 7. THE WRITE PATH USES THE SAME RULE
// ---------------------------------------------------------------------------

test("THE PATCH ROUTE VALIDATES mapUrl WITH THE SHARED HELPER", () => {
  const api = codeOf("src/app/api/packets/[id]/route.ts");
  assert.match(api, /import \{ packetMapUrl \} from "@\/lib\/maps-url"/,
    "the route wrote its own rule instead of sharing one");
  assert.match(api, /if \("mapUrl" in body\)/, "the route does not validate mapUrl");
  assert.match(api, /invalid_map_url/, "the rejection has no machine-readable code");
  // A USEFUL 400: the message has to say what a valid value looks like, or a
  // professional is told "no" with nowhere to go.
  assert.match(api, /http:\/\/ or https:\/\//, "the 400 does not say what is accepted");
  assert.match(api, /status: 400/);
  // "" MUST STILL CLEAR IT. This is the case a naive `if (!valid) reject`
  // would break, and it is the only way to remove a map link.
  assert.match(api, /raw\.trim\(\) === ""/, "an empty string is not explicitly allowed through");
  // Still one column, one field name.
  assert.equal((api.match(/"map_url"/g) ?? []).length, 1, "map_url is written in more than one way");
});

test("THE WRITE RULE AND THE RENDER RULE CANNOT DIVERGE", () => {
  // Both call the same function, so this is really a statement about the
  // function — but it is the property that matters: anything the API accepts,
  // a renderer will show, and anything it refuses, no renderer will.
  for (const [label, stored, renderable] of CASES) {
    const acceptedByApi = stored.trim() === "" || Boolean(packetMapUrl(stored));
    if (stored.trim() === "") continue;
    assert.equal(acceptedByApi, renderable,
      `the API and the renderers would disagree about ${label}`);
  }
});

// ---------------------------------------------------------------------------
// 8. BOTH EDITORS STILL SAVE AND CLEAR
// ---------------------------------------------------------------------------

test("BOTH EDITORS CLEAR ON EMPTY AND HOLD A HALF-TYPED URL", () => {
  // Both boxes save 500ms after a keystroke, so with server validation alone a
  // professional typing "htt" would be told the save failed. The same shared
  // rule is applied client-side as GUIDANCE — held, not sent — while the API
  // keeps enforcing it.
  for (const path of ["src/components/editor/block-packet-editor.tsx",
                      "src/components/editor/legacy-packet-editor.tsx"]) {
    const ed = codeOf(path);
    assert.match(ed, /import \{ packetMapUrl \} from "@\/lib\/maps-url"/,
      `${path} does not use the shared rule`);
    // Blank is always sendable — this is the clear path, and it must not be
    // caught by the validity check.
    assert.match(ed, /(next|value)\.trim\(\) === "" \|\| Boolean\(packetMapUrl\((next|value)\)\)/,
      `${path} does not allow an empty value through to clear the field`);
    assert.match(ed, /if \(!sendable\) return;/, `${path} sends values it knows are invalid`);
    // And it says so, rather than leaving the professional to wonder.
    assert.match(ed, /Not saved — a map link needs to start with/,
      `${path} holds the value silently`);
  }
});

test("THE HINT DOES NOT CLAIM THE STORED LINK WAS LOST", () => {
  // Holding an unsaved edit is not the same as destroying what is stored, and
  // the copy must not imply it was. Nor may it mention a recipient: neither
  // editor knows whether the packet is published.
  for (const path of ["src/components/editor/block-packet-editor.tsx",
                      "src/components/editor/legacy-packet-editor.tsx"]) {
    const ed = codeOf(path);
    const hint = ed.slice(ed.indexOf("Not saved — a map link"));
    const line = hint.slice(0, 160);
    assert.ok(!/lost|deleted|removed|cleared/i.test(line), `${path} implies the stored link is gone`);
    assert.ok(!/your client sees|recipient/i.test(line), `${path} claims to know who is looking`);
  }
});
