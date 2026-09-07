// BLOCK-COMPOSED SENDSETS, ON PAPER.
//
// `/p/[slug]/print` used to answer a block-composed packet with a 404. Not a
// message, not a degraded page — the route said it did not exist. Converting a
// Sendset to block composition therefore cost its printed copy silently, and
// the professional was told the wrong thing about why.
//
// These are RENDER tests, not source gates. The sibling file print-render.test
// says the renderer "cannot be rendered here" because node's type stripping
// does not compile JSX — that is stale: this suite runs under tsx, and
// PrintPacket renders fine. Where a claim can be made about OUTPUT it is made
// about output here.
//
// The load-bearing one is "AN ITEM IS THE SAME ITEM": a legacy item and a
// block item carrying identical content must produce byte-identical markup. It
// is what makes a second item renderer impossible to introduce by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { PrintPacket } from "../components/print/print-packet.tsx";
import { TREATMENTS, printVars, treatmentByName } from "./style/treatment.ts";
import type { Packet, PacketBlock, Item } from "./types.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const RENDERER = "src/components/print/print-packet.tsx";
const CSS = "src/app/p/[slug]/print/print.css";
const ROUTE = "src/app/p/[slug]/print/page.tsx";

const LIVE = "https://sendset.io/p/abc";
const PRIVATE = "PRIVATE-NOTE-must-never-be-printed-9f2a";

// One item carrying every field paper renders, so "the item still prints" is a
// claim about all of it rather than about a title.
const ITEM: Item = {
  id: "i1",
  title: "The Foundry at Mill Street",
  address: "41 Mill Street, Harlow Bend",
  description: "A converted textile works with exposed brick.",
  highlight: "They will hold March 12-13 for you until the 28th.",
  notes: PRIVATE,
  photos: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
  details: [{ label: "Capacity", value: "120 seated" }, { label: "Day rate", value: "$4,200" }],
  links: [{ url: "https://foundrymill.example.com", label: "Venue website" }],
  contacts: [{ name: "Dana Reyes", role: "Events Manager", phone: "(206) 555-0118" }],
};

const BLOCKS: PacketBlock[] = [
  { id: "b1", kind: "heading", text: "Recommended", subtext: "In the order I'd rank them." },
  { id: "b2", kind: "label", text: "Best fit" },
  { id: "b3", kind: "item", item: ITEM },
  { id: "b4", kind: "subheading", text: "Worth a look", subtext: "If the budget moves." },
  { id: "b5", kind: "item", item: { ...ITEM, id: "i2", title: "Harborlight Loft" } },
];

const base = {
  slug: "abc", title: "INTERNAL", clientTitle: "Venue Options",
  clientName: "the Northbeam team", personalNote: "Here are the three I'd start with.",
  mapUrl: "https://www.google.com/maps/d/edit?mid=BLOCKPRINT",
  professional: { name: "Dana Whitfield", email: "d@example.com" },
};

const blockPacket = (over: Record<string, unknown> = {}) => ({
  ...base, compositionMode: "blocks", sections: [], blocks: BLOCKS, ...over,
}) as unknown as Packet;

const legacyPacket = (items: Item[]) => ({
  ...base, compositionMode: "legacy",
  sections: [{ id: "s1", title: "Recommended", description: "In the order I'd rank them.", items }],
}) as unknown as Packet;

const render = (packet: Packet) =>
  renderToStaticMarkup(React.createElement(PrintPacket, { packet, liveUrl: LIVE } as never));

const BLOCK = render(blockPacket());

// ---------------------------------------------------------------------------
// 1. ALL FOUR KINDS, IN ORDER
// ---------------------------------------------------------------------------

test("ALL FOUR BLOCK KINDS REACH PAPER", () => {
  // The set is closed by a database CHECK constraint, so four is all of them.
  assert.ok(BLOCK.includes("Recommended"), "a heading did not print");
  assert.ok(BLOCK.includes("In the order I&#x27;d rank them."), "a heading's subtext did not print");
  assert.ok(BLOCK.includes("Best fit"), "a label did not print");
  assert.ok(BLOCK.includes("Worth a look"), "a subheading did not print");
  assert.ok(BLOCK.includes("If the budget moves."), "a subheading's subtext did not print");
  assert.ok(BLOCK.includes("The Foundry at Mill Street"), "an item did not print");

  // Each in its own idiom, not all as body text.
  assert.match(BLOCK, /class="pg-section-title"[^>]*>Recommended</);
  assert.match(BLOCK, /class="pg-block-label">Best fit</);
  assert.match(BLOCK, /class="pg-block-sub-title">Worth a look</);
});

test("BLOCK ORDER IS PRESERVED EXACTLY", () => {
  const order = ["Recommended", "Best fit", "The Foundry at Mill Street",
                 "Worth a look", "Harborlight Loft"];
  let cursor = -1;
  for (const text of order) {
    const at = BLOCK.indexOf(text);
    assert.ok(at > cursor, `"${text}" printed out of order`);
    cursor = at;
  }
  // And reversing the input reverses the output — proving order comes from the
  // data rather than from the shape of the renderer.
  const reversed = render(blockPacket({ blocks: [...BLOCKS].reverse() }));
  assert.ok(reversed.indexOf("Harborlight Loft") < reversed.indexOf("Recommended"),
    "the renderer imposes its own order");
});

test("AN EMPTY BLOCK BODY PRINTS THE DOCUMENT, NOT AN ERROR", () => {
  const out = render(blockPacket({ blocks: [] }));
  assert.ok(out.includes("Venue Options"), "the document header vanished with the body");
  assert.ok(out.includes("Dana Whitfield"), "the footer vanished with the body");
  assert.ok(!out.includes("pg-item"), "an empty body produced an item");
});

test("A TEXT BLOCK WITH NO TEXT PRINTS NOTHING", () => {
  // Blank heading text is reachable — the editor lets a heading be emptied.
  const out = render(blockPacket({
    blocks: [{ id: "x", kind: "heading", text: "" },
             { id: "y", kind: "label", text: "   " }] as PacketBlock[],
  }));
  assert.ok(!/pg-section-title/.test(out), "an empty heading printed a rule and a gap");
  assert.ok(!/pg-block-label/.test(out), "a blank label printed an empty eyebrow");
});

// ---------------------------------------------------------------------------
// 2. THE ITEM IS THE SAME ITEM
// ---------------------------------------------------------------------------

test("AN IDENTICAL ITEM PRODUCES IDENTICAL PRINT MARKUP IN BOTH MODES", () => {
  // Depth-balanced, because a legacy item is wrapped in .pg-section and a block
  // item is not — slicing to the next landmark would compare an item against an
  // item plus somebody else's closing tag, which is a difference in the TEST.
  const grab = (html: string) => {
    const at = html.indexOf('<div class="pg-item"');
    assert.ok(at >= 0, "no printed item found");
    let depth = 0;
    for (const m of html.slice(at).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) return html.slice(at, at + m.index! + "</div>".length);
    }
    throw new Error("unbalanced item markup");
  };
  const fromLegacy = grab(render(legacyPacket([ITEM])));
  const fromBlocks = grab(render(blockPacket({ blocks: [{ id: "b", kind: "item", item: ITEM }] })));

  // THE CLAIM OF THE WHOLE SLICE. If these ever differ, a second item renderer
  // exists — whether or not anyone meant to write one.
  assert.equal(fromBlocks, fromLegacy,
    "a block item and a legacy item print differently from identical content");
  assert.ok(fromLegacy.length > 400, "the compared fragment is too small to mean anything");
});

test("PrintBlockBody DELEGATES ITEM RENDERING RATHER THAN DUPLICATING IT", () => {
  const src = codeOf(RENDERER);
  const start = src.indexOf("function PrintBlockBody");
  const end = src.indexOf("export function PrintPacket");
  assert.ok(start >= 0 && end > start, "PrintBlockBody is not where it was");
  const body = src.slice(start, end);

  assert.match(body, /<ItemBlock key=\{b\.id\} item=\{b\.item\} \/>/,
    "the block body does not delegate to ItemBlock");
  // None of the item's own furniture may be built here.
  for (const owned of ["pg-item-title", "pg-address", "pg-desc", "pg-details",
                       "pg-photos", "pg-hero", "pg-contact", "pg-links", "pg-highlight"]) {
    assert.ok(!body.includes(owned), `PrintBlockBody builds ${owned} itself`);
  }
  // And there is exactly one place that lays out photos, in the whole renderer.
  assert.equal((src.match(/className="pg-hero"/g) ?? []).length, 1,
    "a second photo layout appeared");
});

// ---------------------------------------------------------------------------
// 3. CONTENT AND SAFETY
// ---------------------------------------------------------------------------

test("PRIVATE NOTES CANNOT BE PRINTED FROM A BLOCK BODY EITHER", () => {
  // Two layers, both asserted. The renderer never reads the field...
  const src = codeOf(RENDERER);
  assert.ok(!/\bitem\.notes\b|\.notes\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")),
    "the paper renderer reads item.notes");
  // ...and a packet carrying one anyway prints nothing of it.
  assert.ok(!BLOCK.includes(PRIVATE), "a private note reached block paper");
});

test("EVERY ITEM FIELD PAPER RENDERS STILL RENDERS IN BLOCK MODE", () => {
  assert.ok(BLOCK.includes("41 Mill Street, Harlow Bend"), "address");
  assert.ok(BLOCK.includes("A converted textile works with exposed brick."), "description");
  assert.ok(BLOCK.includes("They will hold March 12-13"), "highlight (written FOR the reader)");
  assert.ok(BLOCK.includes("Capacity") && BLOCK.includes("120 seated"), "details");
  assert.ok(BLOCK.includes("foundrymill.example.com"), "links");
  assert.ok(BLOCK.includes("Dana Reyes"), "contacts");
  assert.equal((BLOCK.match(/class="pg-hero"/g) ?? []).length, 2, "one hero per item");
  assert.ok(/class="pg-photo"/.test(BLOCK), "the remaining photos were dropped");
});

test("THE PACKET SHELL PRINTS THE SAME FOR A BLOCK PACKET", () => {
  assert.ok(BLOCK.includes("Venue Options"), "client title");
  assert.ok(BLOCK.includes("the Northbeam team"), "client name");
  assert.ok(BLOCK.includes("Here are the three I&#x27;d start with."), "personal note");
  assert.ok(BLOCK.includes("google.com/maps/d/edit?mid=BLOCKPRINT"), "the map link");
  assert.ok(BLOCK.includes("Dana Whitfield"), "the professional footer");
  assert.ok(!BLOCK.includes("INTERNAL"), "the internal title leaked onto paper");
});

// ---------------------------------------------------------------------------
// 4. TREATMENTS, SPACING AND FRAGMENTATION
// ---------------------------------------------------------------------------

test("DEFAULT, WARM AND EDITORIAL ALL REACH BLOCK PAPER", () => {
  const css = codeOf(CSS);
  // The block text blocks read these two, and nothing emitted them before.
  assert.match(css, /--pg-subtle/, "the subheading's supporting line has no colour");
  assert.match(css, /--pg-eyebrow-weight/, "the label has no weight");

  for (const t of TREATMENTS) {
    const vars = printVars(t);
    assert.match(vars, /--pg-subtle:[^;}]+/, `${t.name} emits no --pg-subtle`);
    assert.match(vars, /--pg-eyebrow-weight:[^;}]+/, `${t.name} emits no --pg-eyebrow-weight`);
    // A block packet renders under each without losing its body.
    const out = render(blockPacket({ styleTreatment: t.name }));
    assert.ok(out.includes("Best fit") && out.includes("The Foundry at Mill Street"),
      `${t.name} lost the block body`);
  }
  // The three do not all resolve to the same ink — otherwise this test would
  // pass against a treatment layer that had stopped distinguishing them.
  const subtle = TREATMENTS.map((t) => treatmentByName(t.name).colors.subtle.print);
  assert.equal(new Set(subtle).size, 3, "the treatments no longer differ on paper");
});

test("THE FIRST HEADING DOES NOT DOUBLE THE DOCUMENT'S RULE", () => {
  // .pg-section-title carries a top rule and a section gap so a heading
  // separates itself from what precedes it. The first block has only the
  // document's own <hr> above it, so both must be suppressed.
  assert.match(BLOCK, /class="pg-block-head pg-block-head--first"/,
    "the first heading is not marked as first");
  assert.equal((BLOCK.match(/pg-block-head--first/g) ?? []).length, 1,
    "more than one heading claims to be first");
  const css = codeOf(CSS);
  const rule = css.slice(css.indexOf(".pg-block-head--first .pg-section-title"));
  const decl = rule.slice(0, rule.indexOf("}"));
  assert.match(decl, /border-top-width:\s*0/, "the doubled rule is not removed");
  assert.match(decl, /padding-top:\s*0/, "the rule's padding survives without the rule");
  // AND THE GAP SURVIVES. Legacy gives its first section title the full section
  // gap; a converted packet must not print tighter at the top than the packet
  // it came from. Removing the margin here was a real first-draft mistake,
  // caught by printing both and putting page 1 beside page 1.
  assert.ok(!/margin-top/.test(decl),
    "the first heading also drops its section gap, so a converted packet prints tighter than its legacy form");

  // A body that does NOT open with a heading must not mark anything first.
  const labelFirst = render(blockPacket({
    blocks: [{ id: "l", kind: "label", text: "Best fit" }, ...BLOCKS] as PacketBlock[],
  }));
  assert.ok(!labelFirst.includes("pg-block-head--first"),
    "a heading that is not first was treated as first");
});

test("FLAT SEQUENCES STILL PAGINATE SENSIBLY", () => {
  const css = codeOf(CSS);
  // A heading orphaned at the foot of a page is the classic flat-sequence
  // failure: nothing wraps it, so nothing keeps it with what follows.
  const head = css.slice(css.indexOf(".pg-block-head,"));
  assert.match(head.slice(0, 220), /break-after:\s*avoid/, "a block heading may be orphaned");
  assert.match(head.slice(0, 220), /break-inside:\s*avoid/, "a heading may split from its subtext");
  assert.match(css, /\.pg-block-label\s*\{\s*break-after:\s*avoid/,
    "a label may end a page with nothing under it");
  // Items keep the rules they already had — blocks changed nothing about them.
  assert.match(css, /\.pg-item \{ break-inside: auto; \}/, "item fragmentation was altered");
  assert.match(css, /\.pg-details \{ break-inside: avoid; \}/, "the price table lost its rule");
});

// ---------------------------------------------------------------------------
// 5. THE ROUTE
// ---------------------------------------------------------------------------

test("THE ROUTE NO LONGER 404s FOR COMPOSITION MODE ALONE", () => {
  const src = codeOf(ROUTE);
  assert.ok(!/compositionMode === "blocks"\)\s*notFound\(\)/.test(src),
    "the block 404 is still there");
  assert.ok(!/composition_mode/.test(src), "the route inspects the raw column");
  // A MISSING OR UNPUBLISHED PACKET STILL 404s — that path is untouched, and
  // it is the only remaining reason this route can say no.
  assert.match(src, /if \(!packet\) notFound\(\);/, "a missing packet no longer 404s");
  assert.equal((src.match(/notFound\(\)/g) ?? []).length, 1,
    "the route has more than one way to refuse");
  // Still the published-only loader, so an unpublished packet resolves to null.
  assert.match(src, /getPublishedPacket\(slug\)/, "the route stopped loading published packets");
});

test("THE LEGACY PATH IS UNCHANGED", () => {
  // Same component, same call shape, same output for a section packet.
  const src = codeOf(RENDERER);
  assert.match(src, /packet\.sections\.map\(\(section\) => <SectionBlock key=\{section\.id\} section=\{section\} \/>\)/,
    "the legacy body no longer renders through SectionBlock");
  const legacy = render(legacyPacket([ITEM]));
  assert.ok(legacy.includes("Recommended") && legacy.includes("The Foundry at Mill Street"));
  assert.ok(!legacy.includes("pg-block-"), "block markup leaked into a legacy packet");
  assert.ok(!legacy.includes(PRIVATE), "a private note reached legacy paper");
});
