"use client";

import { useId, useState } from "react";

/** RECIPIENT RESPONSES — the one switch, shared by both editors.
 *
 *  A SENDSET CAPABILITY, NOT AN EDITOR ONE. The legacy and block editors each
 *  mount this same component, so a Sendset's responses can be turned on or off
 *  whichever way it happens to be composed, and the two can never drift apart.
 *
 *  IMMEDIATE. The switch writes packets.response_actions straight away. It is
 *  not part of the frozen publication, so there is nothing to republish and it
 *  is never disabled on a published Sendset — that is precisely where turning
 *  responses off has to work at once.
 *
 *  DELIBERATELY NARROW. One on/off. No required fields, no item targeting, no
 *  wording options: any of those would be response configuration, and v1 has
 *  none. Default off, because a Sendset should never start accepting messages
 *  from strangers without its owner choosing that.
 *
 *  ASYNC STATE IS VISIBLE. The switch moves when pressed, says "Saving…" while
 *  the write is in flight, and moves BACK with an error if it failed — so the
 *  position always matches what was actually saved. The status sits on the
 *  label's line, never on a line of its own, so saving never pushes the rest of
 *  the page down. Every status is short enough to fit that line at phone width
 *  and the line does not wrap: a longer error ("Couldn't save — try again")
 *  wrapped at 375px and moved everything below it by 24px. */
export function RecipientResponsesSettings({
  packetId,
  initialEnabled,
}: {
  packetId: string;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const id = useId();
  const headingId = `${id}-heading`;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;

  async function toggle() {
    if (status === "saving") return;
    const next = !enabled;
    setEnabled(next);
    setStatus("saving");
    try {
      const res = await fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseActions: next ? ["respond"] : [] }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus("saved");
    } catch {
      // The write did not happen, so the switch must not claim it did.
      setEnabled(!next);
      setStatus("error");
    }
  }

  return (
    <section aria-labelledby={headingId} className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
      <h2 id={headingId} className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-3">
        Recipient responses
      </h2>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="whitespace-nowrap text-body font-medium text-ink">
            <span id={labelId}>Allow responses</span>
            {status === "saving" && <span className="ml-2 text-meta font-normal text-ink-2">Saving…</span>}
            {status === "saved" && <span className="ml-2 text-meta font-normal text-ink-2">Saved</span>}
            {status === "error" && (
              <span role="alert" className="ml-2 text-meta font-normal text-red-700">
                Not saved
              </span>
            )}
          </p>
          <p id={helpId} className="mt-0.5 text-meta text-ink-2">
            People viewing this Sendset can send you a message. You can turn this off anytime.
          </p>
        </div>
        {/* A 44px target around a 24px switch: the padding is cancelled by the
            negative margin, so the hit area grows and the layout does not. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onClick={toggle}
          disabled={status === "saving"}
          className="-m-2.5 shrink-0 rounded-full p-2.5 outline-none focus-visible:ring-2 focus-visible:ring-mark/40 disabled:opacity-60"
        >
          <span
            aria-hidden
            className={`relative block h-6 w-11 rounded-full transition-colors ${enabled ? "bg-ink" : "bg-line-2"}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-ground shadow-sm transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`}
            />
          </span>
        </button>
      </div>
    </section>
  );
}
