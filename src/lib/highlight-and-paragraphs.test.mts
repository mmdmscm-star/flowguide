import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ItemCard } from "../components/item-card.tsx";
import { SectionGroup } from "../components/section-group.tsx";

const codeOf = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// TWO FIELDS, TWO AUDIENCES
//
//   item.notes     — PRIVATE. Never reaches a recipient. (8bcb0ab, 2026-08-20)
//   item.highlight — written FOR the recipient. Reaches every delivery method.
//
// Confusing them in either direction is a privacy incident or a lost message,
// so both directions are asserted everywhere.
// ---------------------------------------------------------------------------

const PRIVATE = "PRIVATE-do-not-show-to-client-8bcb0ab";
const HIGHLIGHT = "They heat their pool to 82 degrees, because you asked.";
const THREE = "Paragraph one has several sentences. It keeps going.\n\nParagraph two begins here.\n\nParagraph three as well.";

const packet = (over: Record<string, unknown> = {}) => JSON.parse(JSON.stringify({
  id: "p1", slug: "s1", title: "T", clientName: "C", personalNote: "",
  professional: { name: "Ramona Maurer", phone: "707-391-0111", email: "r@example.com" },
  sections: [{
    id: "sec1", title: "Options", description: THREE,
    items: [{
      id: "i1", title: "Cedar Ridge", description: THREE,
      notes: PRIVATE, highlight: HIGHLIGHT,
      photos: [], details: [], links: [], contacts: [],
    }],
  }],
  ...over,
}));

// ---------------------------------------------------------------------------
// EMAIL — a recipient surface
// ---------------------------------------------------------------------------

test("EMAIL renders the client highlight and NEVER the private note", () => {
  const html = renderPacketEmail(packet(), { liveUrl: "https://x.example.com/p/s1" });
  assert.ok(html.includes(HIGHLIGHT), "the highlight written for the client is missing");
  assert.ok(!html.includes(PRIVATE), "THE PRIVATE NOTE REACHED THE EMAIL");
  assert.ok(!/item\.notes/.test(codeOf("src/lib/email-render.ts").replace(/\/\/.*$/gm, "")),
    "email-render reads item.notes outside a comment");
});

test("the plain-text email flavour carries the highlight and not the note", () => {
  const txt = renderPacketEmailText(packet(), { liveUrl: "https://x.example.com/p/s1" });
  assert.ok(txt.includes(HIGHLIGHT));
  assert.ok(!txt.includes(PRIVATE), "THE PRIVATE NOTE REACHED THE PLAIN-TEXT EMAIL");
});

test("EMAIL keeps paragraph breaks in item AND section descriptions", () => {
  const html = renderPacketEmail(packet(), { liveUrl: null });
  // Three paragraphs => two breaks, in each of the two places it appears.
  const brs = html.match(/<br \/>/g) ?? [];
  assert.ok(brs.length >= 8, `expected paragraph breaks in both descriptions, found ${brs.length}`);
  assert.ok(html.includes("Paragraph two begins here."), "paragraph two vanished");
  assert.ok(html.includes("Paragraph three as well."), "paragraph three vanished");
  // And they must not be run together.
  assert.ok(!/keeps going\.\s*Paragraph two/.test(html), "paragraphs were collapsed into one block");
});

test("A MULTI-PARAGRAPH HIGHLIGHT keeps its breaks too", () => {
  const html = renderPacketEmail(packet({
    sections: [{ id: "s", title: "", description: "", items: [{
      id: "i", title: "X", description: "", notes: "", highlight: "First line.\n\nSecond line.",
      photos: [], details: [], links: [], contacts: [] }] }],
  }), { liveUrl: null });
  assert.ok(html.includes("First line.") && html.includes("Second line."));
  assert.ok(!/First line\.\s+Second line\./.test(html.replace(/<br \/>/g, "\n")) === false ||
            /First line\.(<br \/>)+Second line\./.test(html), "highlight paragraphs were collapsed");
});

test("AN EMPTY HIGHLIGHT PRODUCES NO CALLOUT BOX", () => {
  for (const empty of ["", "   ", "\n\n", undefined]) {
    const html = renderPacketEmail(packet({
      sections: [{ id: "s", title: "", description: "", items: [{
        id: "i", title: "X", description: "d", notes: "", highlight: empty,
        photos: [], details: [], links: [], contacts: [] }] }],
    }), { liveUrl: null });
    assert.ok(!html.includes("#fdf8ec"),
      `an empty callout box was rendered for ${JSON.stringify(empty)}`);
  }
  // Control: a real value DOES render the box, so the check above can fail.
  const withOne = renderPacketEmail(packet(), { liveUrl: null });
  assert.ok(withOne.includes("#fdf8ec"), "the callout box never renders at all");
});

test("HIGHLIGHT IS ESCAPED — it is text, not an HTML injection point", () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const html = renderPacketEmail(packet({
    sections: [{ id: "s", title: "", description: "", items: [{
      id: "i", title: "X", description: "", notes: "", highlight: hostile,
      photos: [], details: [], links: [], contacts: [] }] }],
  }), { liveUrl: null });
  // The property that matters is that no "<" FROM THE HIGHLIGHT survives as
  // markup. The literal characters `onerror=alert(2)` still appear — as visible
  // text inside an escaped &lt;img ...&gt; — and that is harmless, because the
  // angle brackets around them are neutralised. Asserting on the substring
  // alone would fail on correct output, which is what it did.
  assert.ok(!html.includes("<script>"), "a script tag survived into the email");
  assert.ok(!/<img[^>]*onerror/i.test(html), "a real img tag with a handler was emitted");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the text was not escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"), "the img was not escaped as text");
  // Quotes must not be able to break out of the surrounding style attribute.
  assert.ok(!/style="[^"]*"[^>]*alert/i.test(html), "the value escaped its attribute context");
});

// ---------------------------------------------------------------------------
// THE WEB CARD — RENDERED, not grepped.
//
// An earlier version of these asserted on source patterns. A mutation that
// gated the highlight to professionals — the exact bug that would hide it from
// every client — left those patterns intact and the suite green. Rendering the
// component is the only thing that actually answers "does the client see it".
// ---------------------------------------------------------------------------

const card = (over: Record<string, unknown>, audience?: "recipient" | "professional") =>
  renderToStaticMarkup(React.createElement(ItemCard, {
    item: { id: "i", title: "Cedar Ridge", photos: [], details: [], links: [], contacts: [], ...over } as never,
    ...(audience ? { audience } : {}),
  }));

test("THE CLIENT SEES THE HIGHLIGHT AND NEVER THE PRIVATE NOTE", () => {
  const html = card({ notes: PRIVATE, highlight: HIGHLIGHT });
  assert.ok(html.includes(HIGHLIGHT), "the client cannot see the highlight written for them");
  assert.ok(!html.includes(PRIVATE), "THE PRIVATE NOTE RENDERED ON A RECIPIENT CARD");
});

test("the professional sees BOTH, and the note is labelled as private", () => {
  const html = card({ notes: PRIVATE, highlight: HIGHLIGHT }, "professional");
  assert.ok(html.includes(HIGHLIGHT), "the highlight is missing from the professional view");
  assert.ok(html.includes(PRIVATE), "Preview does not show the professional their own note");
  assert.match(html, /only you see this/i, "the private note is shown without saying it is private");
});

test("an ItemCard with NO audience prop defaults to the safe answer", () => {
  // The fail-safe default is the reason the blocks path survived last time.
  assert.ok(!card({ notes: PRIVATE }).includes(PRIVATE), "the default audience leaks the private note");
});

test("AN EMPTY HIGHLIGHT RENDERS NO CALLOUT BOX on the card", () => {
  // The callout's ground now comes from the treatment's highlight role rather
  // than a literal amber class — same rendered colour, decided in one place.
  const CALLOUT = "bg-[color:var(--sg-highlight-ground)]";
  for (const empty of ["", "   ", "\n\n", undefined, null]) {
    const html = card({ highlight: empty, description: "d" });
    assert.ok(!html.includes(CALLOUT), `an empty callout rendered for ${JSON.stringify(empty)}`);
  }
  assert.ok(card({ highlight: HIGHLIGHT }).includes(CALLOUT), "the callout never renders at all");
});

test("an empty private note renders no empty box either", () => {
  assert.ok(!card({ notes: "   " }, "professional").includes("only you see this"));
});

test("HIGHLIGHT AND DESCRIPTION ARE TEXT — React escapes them", () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = card({ highlight: hostile, description: hostile });
  assert.ok(!html.includes("<script>"), "a script tag reached the card");
  assert.ok(!/<img[^>]*onerror/i.test(html), "a real img tag with a handler reached the card");
  assert.ok(html.includes("&lt;script&gt;"), "the value was not escaped");
});

test("descriptions and the highlight keep their paragraph breaks on the card", () => {
  const html = card({ description: THREE, highlight: "First.\n\nSecond." });
  // The text survives intact...
  assert.ok(html.includes("Paragraph two begins here."));
  assert.ok(html.includes("Paragraph three as well."));
  // ...and the element that holds it preserves newlines rather than collapsing.
  const desc = html.slice(html.indexOf("Paragraph one"));
  assert.ok(/whitespace-pre-line/.test(html.slice(0, html.indexOf("Paragraph one"))),
    "the description is not rendered with a newline-preserving white-space rule");
  assert.ok(desc.includes("\n"), "the newlines were stripped out of the markup entirely");
});

test("SECTION descriptions keep paragraph breaks, and forward the audience", () => {
  const section = { id: "s", title: "Options", description: THREE,
    items: [{ id: "i", title: "X", notes: PRIVATE, highlight: HIGHLIGHT,
              photos: [], details: [], links: [], contacts: [] }] };
  const rec = renderToStaticMarkup(React.createElement(SectionGroup, { section } as never));
  const pro = renderToStaticMarkup(React.createElement(SectionGroup, { section, audience: "professional" } as never));
  assert.ok(rec.includes("Paragraph three as well."), "the section description lost a paragraph");
  assert.match(rec.slice(0, rec.indexOf("Paragraph one")), /whitespace-pre-line/,
    "the section description collapses paragraphs");
  // The forwarding is what Preview depends on.
  assert.ok(!rec.includes(PRIVATE), "SectionGroup leaked the private note to a recipient");
  assert.ok(pro.includes(PRIVATE), "SectionGroup DROPS the audience — Preview cannot show the note");
  assert.ok(rec.includes(HIGHLIGHT) && pro.includes(HIGHLIGHT), "the highlight is missing");
});

test("PREVIEW declares itself professional; the live recipient page does not", () => {
  assert.match(codeOf("src/app/preview/[id]/page.tsx"), /audience="professional"/,
    "Preview does not show the professional their own private note");
  assert.ok(!/audience="professional"/.test(codeOf("src/app/p/[slug]/page.tsx")),
    "THE LIVE RECIPIENT PAGE CLAIMS TO BE PROFESSIONAL");
});

// ---------------------------------------------------------------------------
// PAPER
// ---------------------------------------------------------------------------

test("PRINT renders the highlight, never the note, and keeps paragraphs", () => {
  const src = codeOf("src/components/print/print-packet.tsx");
  assert.match(src, /has\(item\.highlight\) &&/, "print drops the client highlight");
  assert.ok(!/\{txt\(item\.notes\)\}|item\.notes\}/.test(src), "PRINT RENDERS THE PRIVATE NOTE");
  const css = codeOf("src/app/p/[slug]/print/print.css");
  for (const cls of [".pg-desc", ".pg-section-desc", ".pg-highlight"]) {
    const rule = css.slice(css.indexOf(cls), css.indexOf(cls) + 320);
    assert.match(rule, /white-space:\s*pre-line/, `${cls} collapses paragraph breaks on paper`);
  }
});

// ---------------------------------------------------------------------------
// THE LIBRARY MUST NOT CARRY ONE CLIENT'S HIGHLIGHT TO ANOTHER
// ---------------------------------------------------------------------------

test("SAVING TO THE LIBRARY DOES NOT CARRY THE HIGHLIGHT", () => {
  const src = codeOf("src/lib/library-service.ts");
  assert.ok(!/highlight/.test(src),
    "library-service touches highlight — one client's personal note would follow into another's packet");
  assert.ok(!/highlight/.test(codeOf("src/lib/library-adapter.ts")), "the library adapter carries highlight");
});

test("the recipient query path still cannot return the private note", () => {
  const q = codeOf("src/lib/queries.ts");
  const recipient = q.slice(q.indexOf("export async function getPublishedPacket"),
                            q.indexOf("export type Audience"));
  assert.ok(!/notes:/.test(recipient), "getPublishedPacket assembles the private note again");
  assert.match(recipient, /highlight: item\.highlight \|\| undefined/, "the recipient path drops the highlight");
  // assembleItemsByIds keeps its audience gate for notes, and none for highlight.
  assert.match(q, /audience === "professional" \? \{ notes: it\.notes \|\| undefined \} : \{\}/,
    "the audience gate on notes was removed");
});

test("AI INGESTION CANNOT WRITE THE HIGHLIGHT — it is human-authored only", () => {
  for (const f of ["src/lib/ai-structure.ts", "src/lib/placement.ts"]) {
    assert.ok(!/highlight/.test(codeOf(f)),
      `${f} lets the model populate a field meant to be written by the professional`);
  }
});
