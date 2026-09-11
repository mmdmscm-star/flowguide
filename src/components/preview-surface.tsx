"use client";

import { useCallback, useState } from "react";
import { CreatorNav } from "@/components/nav/creator-nav";
import { TREATMENTS, treatmentByName, webVars } from "@/lib/style/treatment";
import {
  initialSelection, chooseTreatment, saveSucceeded, saveFailed, isBusy,
  type SelectionState,
} from "@/lib/style/treatment-selection";

// THE ONE PLACE A LOOK IS CHOSEN.
//
// Preview is where the choice belongs, because Preview is the only surface that
// shows the professional what they are choosing. `show_quick_nav` lives in the
// editor and is the cautionary case: you toggle it there and nothing on screen
// moves. A look picked where the look is not visible is a look picked blind.
//
// This wraps the Sendset so a click can re-publish the treatment variables
// without a round trip. The Sendset itself is still server-rendered and arrives
// as `children`; nothing about it crosses into the browser because of this
// component.
//
// TWO PLANES, AND THE CHROME IS NOT ON THE SENDSET'S ONE.
//
// `.sg-packet` sets `font-family: var(--sg-font-body)` and `color: var(--sg-ink)`,
// and the creator chrome used to render INSIDE it. So choosing Editorial for the
// client put the professional's own publish bar, share step and message box into
// Source Serif — the recipient's typeface, on the professional's controls — and
// choosing Warm moved their ink colour. Nothing was broken enough to notice, and
// it made "bring the share step into the creator design system" impossible on
// its face: you cannot be in one system while inheriting another's font.
//
// So the chrome sits ABOVE the Sendset now rather than within it, on the
// creator's canvas, and `main.sg-packet` holds the Sendset alone — at the width
// and on the white ground the recipient actually gets. Nothing moved in the
// order a professional reads: nav, publish/share, style, then the Sendset.
//
// THE STATE MACHINE IS IN @/lib/style/treatment-selection. What is left here is
// markup and one fetch.
export function PreviewSurface({
  packetId,
  persisted,
  banner,
  children,
}: {
  packetId: string;
  /** `packets.style_treatment` as stored. Unknown or absent renders Default. */
  persisted?: string | null;
  /** Creator chrome that sits above the Sendset — the publish banner. */
  banner: React.ReactNode;
  children: React.ReactNode;
}) {
  const [sel, setSel] = useState<SelectionState>(() => initialSelection(persisted));

  const choose = useCallback((name: string) => {
    setSel((prev) => {
      const { state, request } = chooseTreatment(prev, name);
      if (!request) return state;

      // Fired from inside the updater so the request id and the state it
      // belongs to are decided together. The reply is applied only if that id
      // is still the current one — see saveSucceeded / saveFailed.
      void (async () => {
        // A FAILURE IS A FAILURE. Which kind it was is not something this can
        // establish — a rejected body, a 500, a timeout and a lost connection
        // all arrive here, and guessing between them in the message would point
        // a professional at the wrong thing. The rollback is the useful part.
        try {
          const res = await fetch(`/api/packets/${packetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ styleTreatment: request.name }),
          });
          if (res.ok) { setSel((s) => saveSucceeded(s, request.seq)); return; }
        } catch { /* falls through to the same rollback */ }
        setSel((s) => saveFailed(s, request.seq));
      })();

      return state;
    });
  }, [packetId]);

  const busy = isBusy(sel);

  return (
    <div className="flex flex-1 flex-col">
      {/* THE CREATOR'S PLANE. Canvas behind, the working surfaces on it — the
          same two-ground composition the Dashboard and Library wear — and
          max-w-3xl rather than the Sendset's max-w-lg. The share step was
          inheriting the recipient column, so on a wide screen the message a
          professional edits and the ways they can send it were squeezed into
          phone width with half the page empty on either side. The panels knew:
          they carried max-w-xl and max-w-2xl inside a max-w-lg parent, which
          could never do anything. */}
      {/* THE ONE CREATOR SURFACE WITH NO WAY OUT BUT BACKWARDS.
          Every other authoring screen wears this nav — Dashboard, Library,
          /new, both editors — and Preview, which is where publishing now
          LANDS, had none. So the bar a professional had been navigating by all
          the way through authoring vanished at the moment they finished, and
          the only exit offered was "Back to editor": backwards, into editing
          the thing they had just declared done. Same component, same sticky
          treatment, same boundary. No tab is current — Preview is a step, not
          a destination. */}
      <div className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2 sm:gap-3 sm:px-6 sm:py-3.5">
          <CreatorNav />
        </div>
      </div>

      <div className="bg-canvas">
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          {banner}

          {/* A LINE THAT EARNS ITSELF. Above it is what the professional does
              next; below it is how the thing beneath looks. With only a gap
              between them the style cards read as a trailing afterthought of
              the share step rather than as a control attached to the Sendset
              they restyle. */}
          <section aria-label="Sendset style" className="border-t border-line pt-6 pb-8">
            <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div>
                <h2 className="text-body font-medium text-ink">Style</h2>
                <p className="mt-0.5 text-meta text-ink-2">How the Sendset below looks to your client.</p>
              </div>
            {/* ONLY WHAT IS CERTAIN. This component knows which treatment is
                stored; it does not know whether the Sendset is published, so it
                never says anything about what a recipient sees. "Warm saved" is
                true of a draft and of a published Sendset alike. */}
              <p aria-live="polite" className="text-meta text-ink-3">
                {busy ? "Saving…" : `${treatmentByName(sel.persisted).label} saved`}
              </p>
            </div>

            {/* THREE CARDS, EACH WEARING ITS OWN TREATMENT. The sample is built
                from the treatment's own resolved variables rather than from a
                second set of swatch colours, so a card cannot drift from the
                thing it is advertising. Selection is drawn in the CREATOR's
                mark, deliberately — "which one is chosen" is chrome, not part
                of the sample. */}
            <div className="grid grid-cols-3 gap-2">
          {TREATMENTS.map((t) => {
            const chosen = sel.shown === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => choose(t.name)}
                disabled={busy}
                aria-pressed={chosen}
                title={t.blurb}
                className={`rounded-[var(--radius-panel)] text-left transition
                            disabled:opacity-60 disabled:cursor-not-allowed
                            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mark/40
                            ${chosen ? "ring-2 ring-mark" : "ring-1 ring-line hover:ring-line-2"}`}
              >
                <span
                  style={webVars(t) as React.CSSProperties}
                  className="block h-full overflow-hidden rounded-[var(--radius-panel)]"
                >
                  <span
                    className="block px-2.5 pt-2.5 pb-3"
                    style={{
                      background: "var(--sg-card-ground)",
                      fontFamily: "var(--sg-font-body)",
                    }}
                  >
                    <span
                      className="block leading-tight"
                      style={{
                        fontFamily: "var(--sg-font-display)",
                        fontWeight: "var(--sg-title-weight)",
                        letterSpacing: "var(--sg-title-tracking)",
                        color: "var(--sg-ink)",
                        fontSize: "0.9375rem",
                      }}
                    >
                      {t.label}
                    </span>
                    <span className="mt-1.5 block h-px w-full" style={{ background: "var(--sg-line)" }} />
                    <span
                      className="mt-1.5 block text-[11px] leading-snug"
                      style={{ color: "var(--sg-prose)" }}
                    >
                      Aa — the day rate
                    </span>
                    <span
                      className="mt-1.5 block text-[11px] font-medium"
                      style={{ color: "var(--sg-accent)" }}
                    >
                      A link
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

            {sel.error && (
              <p role="alert" className="mt-2 text-meta text-red-700">
                {sel.error}
              </p>
            )}
          </section>
        </div>
      </div>

      {/* THE RECIPIENT'S PLANE, full-bleed white and max-w-lg, which is exactly
          what /p/[slug] renders. Preview is only worth anything if it is the
          same composition the client gets. */}
      <div className="flex-1 bg-white">
        <main
          style={webVars(treatmentByName(sel.shown)) as React.CSSProperties}
          className="sg-packet w-full max-w-lg mx-auto pb-12 pt-6 overflow-x-hidden break-words"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
