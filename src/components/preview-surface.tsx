"use client";

import { useCallback, useState } from "react";
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
// This wraps the WHOLE Sendset so a click can re-publish the treatment variables
// without a round trip. The Sendset itself is still server-rendered and arrives
// as `children`; nothing about the packet crosses into the browser because of
// this component.
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
    <main
      style={webVars(treatmentByName(sel.shown)) as React.CSSProperties}
      className="sg-packet w-full max-w-lg mx-auto pb-12 overflow-x-hidden break-words"
    >
      {banner}

      <section aria-label="Sendset style" className="border-b border-border px-5 py-4">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted">Style</h2>
          {/* ONLY WHAT IS CERTAIN. This component knows which treatment is
              stored; it does not know whether the packet is published, so it
              never says anything about what a recipient sees. "Warm saved" is
              true of a draft and of a published Sendset alike. */}
          <p aria-live="polite" className="text-xs text-muted">
            {busy ? "Saving…" : `${treatmentByName(sel.persisted).label} saved`}
          </p>
        </div>

        {/* THREE CARDS, EACH WEARING ITS OWN TREATMENT. The sample is built from
            the treatment's own resolved variables rather than from a second set
            of swatch colours, so a card cannot drift from the thing it is
            advertising. Selection is drawn in the CREATOR's accent, deliberately
            — "which one is chosen" is chrome, not part of the sample. */}
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
                className={`rounded-lg text-left transition disabled:opacity-60 disabled:cursor-not-allowed
                            focus:outline-none focus:ring-2 focus:ring-accent
                            ${chosen ? "ring-2 ring-accent" : "ring-1 ring-border hover:ring-gray-300"}`}
              >
                <span
                  style={webVars(t) as React.CSSProperties}
                  className="block h-full rounded-lg overflow-hidden"
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
          <p role="alert" className="mt-2 text-sm text-red-600">
            {sel.error}
          </p>
        )}
      </section>

      {children}
    </main>
  );
}
