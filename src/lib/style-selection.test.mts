// CHOOSING A LOOK — the behaviour, not the markup.
//
// The rule under test is one sentence: PREVIEW MUST NEVER INTENTIONALLY SHOW A
// TREATMENT THAT IS NOT THE STORED ONE. Everything below is a way that could
// stop being true — a save that fails, a reply that arrives late, two clicks
// that overlap — and a check that it does not.
//
// The copy is tested too, and negatively: this component knows which treatment
// is stored and nothing else. It must not imply the packet is published, and it
// must not diagnose why a save failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  initialSelection, chooseTreatment, saveSucceeded, saveFailed, isBusy,
} from "./style/treatment-selection.ts";
import { TREATMENTS, webVars, treatmentByName } from "./style/treatment.ts";
import { PreviewSurface } from "../components/preview-surface.tsx";

const raw = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// THE STATE MACHINE
// ---------------------------------------------------------------------------

test("a packet with no stored treatment starts on Default, agreeing with the row", () => {
  for (const seed of [undefined, null, "", "  ", "nope"]) {
    const s = initialSelection(seed);
    assert.equal(s.persisted, "default");
    assert.equal(s.shown, "default");
    assert.equal(s.saving, null);
    assert.equal(s.error, null);
  }
  assert.equal(initialSelection("warm").shown, "warm");
  assert.equal(initialSelection("editorial").persisted, "editorial");
});

test("A CLICK CHANGES PREVIEW IMMEDIATELY, and asks to save exactly once", () => {
  const start = initialSelection("default");
  const { state, request } = chooseTreatment(start, "warm");
  // The look moves now — not after a round trip.
  assert.equal(state.shown, "warm");
  assert.equal(state.saving, "warm");
  // …but the link has not moved, and the state says so.
  assert.equal(state.persisted, "default");
  assert.deepEqual(request, { seq: 1, name: "warm" });
  assert.ok(isBusy(state));
});

test("A SUCCESSFUL SAVE MAKES THE NEW LOOK THE BASELINE", () => {
  const { state: pending, request } = chooseTreatment(initialSelection("default"), "editorial");
  const done = saveSucceeded(pending, request!.seq);
  assert.equal(done.persisted, "editorial");
  assert.equal(done.shown, "editorial");
  assert.equal(done.saving, null);
  assert.equal(done.error, null);
  assert.ok(!isBusy(done));
  // And the new baseline is what a later failure rolls BACK to.
  const { state: next, request: r2 } = chooseTreatment(done, "warm");
  const failed = saveFailed(next, r2!.seq);
  assert.equal(failed.shown, "editorial");
  assert.equal(failed.persisted, "editorial");
});

test("A FAILED SAVE ROLLS PREVIEW BACK, and says only what is certain", () => {
  const { state: pending, request } = chooseTreatment(initialSelection("default"), "warm");
  const failed = saveFailed(pending, request!.seq);
  // THE WHOLE POINT: Preview goes back to what the packet actually stores.
  assert.equal(failed.shown, "default");
  assert.equal(failed.persisted, "default");
  assert.equal(failed.saving, null);
  assert.equal(failed.error, "Couldn't save Warm. Preview is back to Default.");
});

test("THE COPY NEVER CLAIMS MORE THAN IT KNOWS", () => {
  // Two things this module cannot know, and therefore must never say: whether
  // the packet is published, and why a request failed.
  const { state: pending, request } = chooseTreatment(initialSelection("editorial"), "warm");
  const messages = [saveFailed(pending, request!.seq).error!];
  const src = raw("src/components/preview-surface.tsx")
    + raw("src/lib/style/treatment-selection.ts");
  // Every user-facing string the component can show.
  messages.push("Saving…", `${treatmentByName("editorial").label} saved`);
  for (const m of messages) {
    assert.doesNotMatch(m, /client|recipient|published|link|anyone/i,
      `copy implies publication: ${m}`);
    assert.doesNotMatch(m, /connection|network|offline|server|timed? ?out|500|400/i,
      `copy diagnoses a cause it cannot know: ${m}`);
  }
  // And the strings are not merely absent from the machine — they are absent
  // from the component too, where a second copy could have been written.
  for (const banned of ["your client sees", "connection dropped", "the server said"])
    assert.ok(!src.toLowerCase().includes(banned), `"${banned}" is still in the selector`);
  // The failure path takes no diagnosis argument at all any more.
  assert.match(raw("src/lib/style/treatment-selection.ts"),
    /export function saveFailed\(state: SelectionState, seq: number\): SelectionState/);
  assert.match(raw("src/components/preview-surface.tsx"), /saveFailed\(s, request\.seq\)/);
});

test("PREVIEW AND THE STORED TREATMENT NEVER SETTLE ON DIFFERENT VALUES", () => {
  // Every terminal state — after any sequence of clicks and replies — has
  // shown === persisted. Only an in-flight save may differ, and it is labelled.
  const outcomes = [
    (s: ReturnType<typeof initialSelection>, q: number) => saveSucceeded(s, q),
    (s: ReturnType<typeof initialSelection>, q: number) => saveFailed(s, q),
  ];
  let checked = 0;
  for (const first of TREATMENTS) for (const second of TREATMENTS)
    for (const a of outcomes) for (const b of outcomes) {
      let s = initialSelection("default");
      const r1 = chooseTreatment(s, first.name); s = r1.state;
      if (r1.request) s = a(s, r1.request.seq);
      const r2 = chooseTreatment(s, second.name); s = r2.state;
      if (r2.request) s = b(s, r2.request.seq);
      assert.equal(s.saving, null);
      assert.equal(s.shown, s.persisted,
        `settled with Preview on ${s.shown} and the packet on ${s.persisted}`);
      checked++;
    }
  assert.equal(checked, 36);
});

test("COMPETING SAVES CANNOT RACE OUT OF ORDER", () => {
  // A second click is refused while one save is in flight — the disabled cards
  // are a picture of this rule, not the rule itself.
  const { state: pending } = chooseTreatment(initialSelection("default"), "warm");
  const second = chooseTreatment(pending, "editorial");
  assert.equal(second.request, null, "a second save was started while one was in flight");
  assert.equal(second.state.shown, "warm", "the refused click still changed Preview");

  // And a reply belonging to an abandoned request changes nothing, in either
  // direction. This is the case a disabled button cannot prevent.
  const stale = 99;
  assert.equal(saveSucceeded(pending, stale), pending);
  assert.equal(saveFailed(pending, stale), pending);
  // A reply arriving after the state has already settled is inert too.
  const settled = saveSucceeded(pending, pending.seq);
  assert.equal(saveSucceeded(settled, settled.seq), settled);
  assert.equal(saveFailed(settled, settled.seq), settled);
});

test("A NAME THAT IS NOT A TREATMENT NEVER BECOMES ONE", () => {
  const s = initialSelection("default");
  for (const bad of ["", "Warm ", "nope", "../x", "DEFAULT"]) {
    const r = chooseTreatment(s, bad);
    assert.equal(r.request, null, `${bad} produced a save`);
    assert.equal(r.state.shown, "default");
  }
  // Re-choosing what is already saved is not a save; it only clears an error.
  const withError = saveFailed(chooseTreatment(s, "warm").state, 1);
  const again = chooseTreatment(withError, "default");
  assert.equal(again.request, null);
  assert.equal(again.state.error, null);
});

// ---------------------------------------------------------------------------
// THE SELECTOR
// ---------------------------------------------------------------------------

const surface = (persisted?: string | null) =>
  renderToStaticMarkup(React.createElement(
    PreviewSurface,
    { packetId: "p1", persisted, banner: React.createElement("div", null, "BANNER") },
    React.createElement("p", null, "SENDSET"),
  ));

test("THREE CARDS, DEFAULT FIRST, EACH WEARING ITS OWN TREATMENT", () => {
  const html = surface("default");
  const order = TREATMENTS.map((t) => html.indexOf(`>${t.label}<`));
  assert.ok(order.every((i) => i > 0), "a treatment card is missing");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the cards are out of order");
  assert.equal(TREATMENTS[0].name, "default", "Default is not first in the registry");

  // Each card is built from its OWN resolved variables, so it cannot advertise
  // a look it does not have.
  for (const t of TREATMENTS) {
    const vars = webVars(t);
    // The FACE, by the next/font variable it names — the stack around it
    // carries quotes that React escapes in an attribute, which is why the whole
    // string is not the landmark.
    const face = vars["--sg-font-display"].match(/--font-[a-z-]+/)![0];
    assert.ok(html.includes(face), `${t.name}'s face (${face}) is not on its card`);
    assert.ok(html.includes(vars["--sg-accent"]), `${t.name}'s accent is not on its card`);
    assert.ok(html.includes(vars["--sg-card-ground"]), `${t.name}'s ground is not on its card`);
  }
  // The three faces are genuinely different, or the cards all look the same.
  const faces = new Set(TREATMENTS.map((t) => webVars(t)["--sg-font-display"].match(/--font-[a-z-]+/)![0]));
  assert.equal(faces.size, 3, "two treatments advertise the same face");
  // …and it is a real control, not a swatch.
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.ok(html.includes('aria-pressed="true"'), "nothing is marked as chosen");
  assert.ok(html.includes("BANNER") && html.includes("SENDSET"),
    "the banner or the Sendset stopped rendering");
});

test("THE SURFACE RENDERS THE STORED TREATMENT, AND NAMES IT WITHOUT CLAIMING MORE", () => {
  for (const name of ["default", "warm", "editorial"]) {
    const html = surface(name);
    const t = treatmentByName(name);
    // The Sendset wrapper wears it…
    assert.ok(html.includes(`--sg-card-radius:${webVars(t)["--sg-card-radius"]}`)
      || html.includes(webVars(t)["--sg-ink"]), `${name} is not published on the surface`);
    // …and the professional is told, in words, which one is stored. True of a
    // draft and of a published Sendset alike.
    assert.ok(html.includes(`${t.label} saved`), `${name} is not named in the status line`);
    assert.ok(!html.includes("Saving…"), "a freshly rendered surface claims to be saving");
  }
  // An unrecognised stored value renders Default rather than nothing.
  assert.ok(surface("withdrawn-treatment").includes("Default saved"));
});

test("THE SELECTOR SAVES THROUGH THE PACKET ROUTE, AND NOWHERE ELSE", () => {
  const src = raw("src/components/preview-surface.tsx");
  assert.match(src, /fetch\(`\/api\/packets\/\$\{packetId\}`, \{\s*method: "PATCH"/,
    "the selector does not save through the packet PATCH route");
  assert.match(src, /styleTreatment: request\.name/);
  assert.ok(!/supabase|from\("packets"\)/.test(src), "the selector talks to the database directly");
  // The state machine is not reimplemented in the component.
  for (const fn of ["chooseTreatment", "saveSucceeded", "saveFailed", "isBusy"])
    assert.ok(src.includes(fn), `${fn} is not used by the selector`);
  assert.match(src, /disabled=\{busy\}/, "the cards accept clicks while a save is in flight");
  assert.match(src, /aria-live="polite"/, "the saving state is not announced");
});
