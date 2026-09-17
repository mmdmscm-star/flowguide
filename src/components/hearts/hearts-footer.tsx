"use client";

import { useState } from "react";
import { heartCountLabel, NOT_YOU, sessionSignatureLine } from "@/lib/item-actions";
import { useHearts } from "./hearts-provider";

/** WHAT THIS BROWSER HAS SAID, at the end of the Sendset.
 *
 *  It exists for three things, and nothing else:
 *
 *  1. THE SIGNATURE THIS BROWSER CARRIES. On a shared device the second person
 *     to pick up the tablet would otherwise be editing the first one's hearts
 *     without ever being told. It says "from this browser", because that is all
 *     a capability knows — never "you are Lisa".
 *  2. NOT YOU? Dropping the browser's handle. The submission it held is left
 *     exactly as it is; the next heart starts a new one. Nothing is merged and
 *     nothing is deleted.
 *  3. HEARTS WHOSE ITEM HAS GONE. A Republish can remove something they
 *     hearted. It is still theirs, so it is still shown — labelled, uneditable,
 *     and withdrawable. It is never silently dropped.
 *
 *  No counts of anybody else, ever. */
export function HeartsFooter() {
  const hearts = useHearts();
  const [confirming, setConfirming] = useState(false);
  if (!hearts || !hearts.ready) return null;
  if (hearts.count === 0 && !hearts.error) return null;

  const line = sessionSignatureLine(hearts.signatureName);
  const small = { fontSize: "var(--sg-small)", lineHeight: "var(--sg-small-lh)" } as const;

  return (
    <section
      className="mx-[var(--sg-page-gutter)] mb-8 p-4"
      aria-label="Your hearts"
      style={{ border: "1px solid var(--sg-line)", borderRadius: "var(--sg-card-radius)" }}
    >
      {hearts.count > 0 && (
        <p style={{ ...small, color: "var(--sg-ink)" }}>
          {heartCountLabel(hearts.count)} on this Sendset.{" "}
          {line && <span style={{ color: "var(--sg-muted)" }}>{line}</span>}
        </p>
      )}

      {hearts.departed.length > 0 && (
        <div className="mt-3">
          <p style={{ ...small, color: "var(--sg-muted)" }}>No longer in this Sendset:</p>
          <ul className="mt-1 space-y-1">
            {hearts.departed.map((a) => (
              <li key={a.itemId} className="flex items-center justify-between gap-3" style={{ ...small, color: "var(--sg-ink)" }}>
                <span className="min-w-0 break-words">{a.label ?? "An item"}</span>
                <button
                  type="button"
                  onClick={() => hearts.toggle(a.itemId)}
                  disabled={hearts.isPending(a.itemId)}
                  className="shrink-0 underline underline-offset-4 disabled:opacity-60"
                  style={{ color: "var(--sg-muted)" }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hearts.error && (
        <p role="alert" className="mt-2" style={{ ...small, color: "#b42318" }}>{hearts.error}</p>
      )}

      {hearts.signatureName && (
        <div className="mt-3">
          {confirming ? (
            <p style={{ ...small, color: "var(--sg-muted)" }}>
              Your hearts stay with {hearts.signatureName}. This browser starts again.{" "}
              <button
                type="button"
                onClick={() => { hearts.forget(); setConfirming(false); }}
                className="underline underline-offset-4"
                style={{ color: "var(--sg-ink)" }}
              >
                Start a new response
              </button>{" "}
              <button type="button" onClick={() => setConfirming(false)} className="underline underline-offset-4">
                Cancel
              </button>
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="underline underline-offset-4"
              style={{ ...small, color: "var(--sg-muted)" }}
            >
              {NOT_YOU}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
