// THE SHARE STEP IS IN THE CREATOR'S DESIGN SYSTEM, AND ON THE CREATOR'S PLANE.
//
// Publishing now lands here, so this is the moment a professional finishes.
// It was still wearing what it was built in: a full-bleed green band, a blue
// fill for every primary action, 39 hand-written type sizes and not one from
// the responsive scale, and three delivery methods ranked as one panel plus
// two underlined links.
//
// The load-bearing finding is structural and is the first test below. The
// creator chrome rendered INSIDE `main.sg-packet`, which sets
// `font-family: var(--sg-font-body)`. Choosing Editorial for the client put the
// professional's own share step into Source Serif. You cannot convert a surface
// into one design system while it inherits another's font, so the planes are
// separated — and that is a thing that would be quietly undone by anyone
// tidying the JSX back into one wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PreviewSurface } from "../components/preview-surface.tsx";
import { TREATMENTS } from "./style/treatment.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

/** Every file that draws creator chrome on this surface. The Sendset body is
 *  NOT here: it is the recipient's, it has its own design system, and this
 *  pass deliberately did not touch it. */
const CHROME = [
  "src/components/preview-actions.tsx",
  "src/components/client-message-panel.tsx",
  "src/components/email-version-panel.tsx",
  "src/components/preview-surface.tsx",
  "src/components/OwnershipResolution.tsx",
];

function surfaceDoc() {
  const html = renderToStaticMarkup(React.createElement(
    PreviewSurface,
    { packetId: "p1", persisted: "editorial",
      banner: React.createElement("div", { id: "chrome" }, "BANNER") },
    React.createElement("p", { id: "sendset" }, "SENDSET"),
  ));
  return new JSDOM(`<!doctype html><body>${html}`).window.document;
}

test("THE CREATOR CHROME IS NOT INSIDE THE RECIPIENT'S STYLE CONTEXT", () => {
  const doc = surfaceDoc();
  const packet = doc.querySelector("main.sg-packet");
  const chrome = doc.querySelector("#chrome");
  const sendset = doc.querySelector("#sendset");
  assert.ok(packet && chrome && sendset, "the surface stopped rendering one of its parts");

  // `.sg-packet` sets font-family and colour from the chosen treatment, so
  // anything inside it wears the recipient's typeface.
  assert.ok(!packet.contains(chrome),
    "the share step is inside .sg-packet again — it will render in the client's font");
  assert.ok(packet.contains(sendset),
    "the Sendset left .sg-packet, so the preview is no longer the client's view");

  // The treatment variables belong to the packet element and to nothing above it.
  assert.match(packet.getAttribute("style") ?? "", /--sg-font-body/,
    "the Sendset lost its treatment variables");
  const chromeRoot = doc.querySelector("body > div");
  assert.doesNotMatch(chromeRoot?.getAttribute("style") ?? "", /--sg-/,
    "treatment variables were hoisted onto the creator plane");

  // And the order a professional reads is unchanged: chrome first.
  assert.ok(chrome.compareDocumentPosition(sendset) & 4 /* FOLLOWING */,
    "the Sendset now comes before the controls");
});

test("...WHICHEVER TREATMENT IS CHOSEN", () => {
  // A positive control for the test above: the packet element really does
  // carry a different face per treatment, so "the chrome is outside it" is a
  // claim about something that would otherwise have had an effect.
  const faces = new Set<string>();
  for (const t of TREATMENTS) {
    const doc = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(React.createElement(
      PreviewSurface,
      { packetId: "p1", persisted: t.name, banner: React.createElement("div", null, "B") },
      React.createElement("p", null, "S"),
    ))}`).window.document;
    const style = doc.querySelector("main.sg-packet")!.getAttribute("style")!;
    faces.add(style.match(/--sg-font-body:\s*([^;]+)/)![1]);
  }
  assert.equal(faces.size, TREATMENTS.length,
    "the treatments no longer differ in body face, so the separation proves nothing");
});

test("THE TYPE SCALE IS THE RESPONSIVE ONE, not a hand-written size", () => {
  // `text-xs` is a flat 12px that no breakpoint moves. On the surfaces already
  // converted, ordinary text is ~15-16px on a phone; this one had 39 raw sizes
  // and none from the scale, which is the standing mobile-readability rule
  // being missed on the last unconverted creator surface.
  for (const f of CHROME) {
    const raw = codeOf(f).match(/text-(?:xs|sm|base|lg|xl|2xl)\b/g) ?? [];
    assert.deepEqual(raw, [], `${f} writes its own type sizes: ${raw.join(", ")}`);
  }
  // Not merely absent — actually using the scale.
  const used = new Set(CHROME.flatMap((f) =>
    codeOf(f).match(/text-(?:micro|meta|body|title|page)\b/g) ?? []));
  for (const step of ["text-meta", "text-body", "text-page"])
    assert.ok(used.has(step), `nothing on the share step uses ${step}`);
});

test("THE CONTROLS ARE THE SHARED ONES", () => {
  for (const f of CHROME) {
    const src = codeOf(f);
    // The blue fill was the creator system's single most-cited "default
    // dashboard" signal; primary is ink.
    assert.doesNotMatch(src, /bg-accent/, `${f} still fills a button with the old blue`);
    // A hand-rolled button is how seventeen signatures happened the first time.
    assert.doesNotMatch(src, /<button[^>]*className="[^"]*px-\d/s,
      `${f} hand-rolls a button's padding instead of using Button`);
  }
  const share = codeOf("src/components/preview-actions.tsx");
  assert.match(share, /import \{ Button, buttonClass \}/, "the share step does not use the shared button");
  // Print is a route, so it is an anchor — and must still wear the same class.
  assert.match(share, /href=\{`\/p\/\$\{slug\}\/print`\}[\s\S]{0,200}buttonClass\(/,
    "Print / Save as PDF is not wearing the shared button treatment");
});

test("THE MOMENT OF SUCCESS IS NOT AN ALERT", () => {
  const share = codeOf("src/components/preview-actions.tsx");
  // The band was `bg-green-50 border-green-200` wrapping the entire step, with
  // every word inside it green on green.
  assert.doesNotMatch(share, /bg-green-|border-green-|text-green-/,
    "the share step is a green system-message band again");
  // The state still gets ONE mark, and it is the same one the Dashboard uses,
  // so the two surfaces agree about what published looks like.
  const dash = codeOf("src/components/dashboard/dashboard-workspace.tsx");
  const pill = /bg-emerald-50 text-emerald-800/;
  assert.match(dash, pill, "the Dashboard's published pill changed; this test's premise is stale");
  assert.match(share.replace(/\s+/g, " "),
    /bg-emerald-50[^"]*text-emerald-800|text-emerald-800[^"]*bg-emerald-50/,
    "the share step no longer marks the published state the way the Dashboard does");
});

test("THE THREE DELIVERY METHODS ARE PEERS", () => {
  // One Sendset, many renderers — the architecture's own words. Two of the
  // three were underlined links at two different sizes hanging below the panel
  // that held the third.
  const share = codeOf("src/components/preview-actions.tsx");
  for (const [what, re] of [
    ["the client message", /<ClientMessagePanel/],
    ["the email version", /<EmailVersionPanel/],
    ["print", /\/p\/\$\{slug\}\/print/],
  ] as Array<[string, RegExp]>)
    assert.match(share, re, `${what} left the share step`);
  assert.match(share, /Other ways to send it/,
    "the secondary renderers are no longer grouped as what they are");
  // No underlined text link survives as a primary way to reach a renderer.
  assert.doesNotMatch(share, /underline/,
    "a delivery method is still an underlined link rather than a control");
});
