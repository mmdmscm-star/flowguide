// THE REVIEW GATE IS THE ONE PLACE IN THE CREATION PATH THAT NEVER LET ANYONE
// THROUGH.
//
// Every run that reached needs_review in real use stayed there — seven runs,
// eighty-eight items of already-imported content, none ever published, some
// sitting for eleven days. The decisions themselves were not the obstacle: five
// of those runs were blocked by one to three clicks, and one shows somebody
// settling two of three and stopping. What was missing was any sense that the
// task was finite, under a wall of cards that repeated the same forty-five
// words of fine print on every one.
//
// These are the two properties that fix carries. Neither changes what a
// decision IS, what it writes, or what blocks publishing.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ReviewFailure } from "./review-units.ts";

let dom: JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let ImportProgress: React.ComponentType<Record<string, unknown>>;

/** One held unit.
 *
 *  `kind` is the REGISTRY key and is hyphenated (`privacy-rejected`); the
 *  persisted `code` is the underscored form. Passing the code as the kind
 *  misses the registry entirely and silently falls back to all three
 *  dispositions — which made every kind look identical here and this test
 *  claim the code was wrong when the fixture was. */
const unit = (id: string, kind: string, status = "unresolved"): ReviewFailure =>
  ({ id, kind, code: kind.replace(/-/g, "_"), title: `Item ${id}`,
     text: `Excerpt ${id}`, status } as ReviewFailure);

let failures: ReviewFailure[] = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://flowguide.test/edit/p1", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
  g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.self = dom.window; g.location = dom.window.location;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  g.fetch = (async (url: string) => {
    const u = new URL(String(url), "https://flowguide.test");
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);
    if (u.pathname.includes("/api/ingest/")) {
      return json({ run: { status: "needs_review", totalChunks: 2,
        review: { ok: false, summary: "Some of your source needs a decision.",
                  exit: "Decide what to do with each piece below.", failures } }, chunks: [] });
    }
    return json({});
  }) as typeof fetch;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ImportProgress = (await import("../components/ImportProgress.tsx")).default as never;
});

async function render(): Promise<HTMLElement> {
  const host = dom.window.document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ImportProgress, {
      packetId: "p1", runId: "r1",
      onDone: () => {}, onDiscarded: () => {}, onNeedsReview: () => {}, onItemsChanged: () => {},
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  return host as unknown as HTMLElement;
}

// EACH ALTERNATIVE MUST MATCH ONE NOTE AND NO OTHER. The private-note sentence
// ends "Sendset does not move the text for you", and the neither-answer one
// begins "Sendset does not move this for you" — a loose /Sendset does not move/
// counted a single note twice and made this test lie about the code.
const NOTE = /Adding puts each line|Only you would see a private note|Sendset does not move this for you/g;

test("THE TASK IS FINITE: the panel says how many are settled, out of how many", async () => {
  failures = [unit("a", "privacy-rejected"), unit("b", "privacy-rejected"), unit("c", "privacy-rejected")];
  let host = await render();
  assert.match(host.textContent ?? "", /0 of 3 settled/,
    "a professional cannot see how much of this is left");

  // The count is of DECIDED units, not of units removed from the list — someone
  // who settles two of three must be able to see they are one from done.
  failures = [unit("a", "privacy-rejected", "kept_private"),
              unit("b", "privacy-rejected", "resolved"),
              unit("c", "privacy-rejected")];
  host = await render();
  assert.match(host.textContent ?? "", /2 of 3 settled/,
    "progress through the review is invisible");
});

test("A SINGLE DECISION IS NOT DRESSED UP AS A LIST", async () => {
  failures = [unit("a", "privacy-rejected")];
  const host = await render();
  assert.doesNotMatch(host.textContent ?? "", /of 1 settled/,
    "one unit does not need a progress bar; it needs deciding");
});

test("THE FINE PRINT IS SAID ONCE PER ANSWER, NOT ONCE PER CARD", async () => {
  // Twenty-six units of one kind used to print the same sentence twenty-six
  // times — more words than the excerpts they explained.
  failures = Array.from({ length: 6 }, (_, i) => unit(`u${i}`, "privacy-rejected"));
  const host = await render();
  const shown = (host.textContent ?? "").match(NOTE) ?? [];
  assert.equal(shown.length, 1,
    `the consequence sentence is repeated ${shown.length} times for one kind of answer`);
});

test("...BUT IT IS NEVER SKIPPED WHEN THE ANSWER CHANGES", async () => {
  // The sentence describes what the BUTTONS do, and different kinds offer
  // different buttons. Deduping by position must not let a card appear whose
  // consequence has not been stated.
  // Three kinds whose dispositions genuinely differ: keep-private, add-to-item,
  // and neither. Each gets its own sentence, so all three must appear.
  failures = [unit("a", "privacy-rejected"),            // kept_private
              unit("b", "source-details-omitted"),      // included
              unit("c", "unbound-recipient-content")];  // neither
  const host = await render();
  const shown = (host.textContent ?? "").match(NOTE) ?? [];
  assert.equal(shown.length, 3,
    "a card's consequence went unstated because a different kind preceded it");
});

test("EVERY DECISION IS STILL OFFERED — the fix is presentation, not fewer choices", async () => {
  failures = [unit("a", "privacy-rejected")];
  const host = await render();
  const labels = [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  assert.ok(labels.some((l) => /private note/i.test(l)), "keep-as-private-note is gone");
  assert.ok(labels.some((l) => /added it/i.test(l)), "the acknowledge answer is gone");
  assert.ok(labels.some((l) => /Leave it out/i.test(l)), "the leave-it-out answer is gone");
  assert.ok(labels.some((l) => /Discard import/i.test(l)), "the exit is gone");
  // The excerpt itself must still be readable: a decision about content nobody
  // can see is not a decision.
  assert.match(host.textContent ?? "", /Excerpt a/, "the held source is no longer shown");
});
