"use client";

import { useId, useState } from "react";
import { RESPONSE_ACTIONS, type ResponseAction } from "@/lib/response-actions";

/** RECIPIENT RESPONSES — the switches, shared by both editors.
 *
 *  A SENDSET CAPABILITY, NOT AN EDITOR ONE. The legacy and block editors each
 *  mount this same component, so a Sendset's responses can be turned on or off
 *  whichever way it happens to be composed, and the two can never drift apart.
 *
 *  TWO SEPARATE CHOICES, because they are two different things to receive. A
 *  message is correspondence someone writes to you; a heart is a preference on
 *  one item that the person who gave it can take back. Turning one on says
 *  nothing about the other, and both start off.
 *
 *  IMMEDIATE. Each switch writes packets.response_actions straight away. It is
 *  not part of the frozen publication, so there is nothing to republish and
 *  neither is disabled on a published Sendset — that is precisely where turning
 *  something off has to work at once.
 *
 *  TURNING HEARTS OFF STOPS NEW ONES. It does not delete the hearts people
 *  already gave, and it does not trap them: somebody who hearted three things
 *  can still see them and still take them back (0059).
 *
 *  ASYNC STATE IS VISIBLE. A switch moves when pressed, says "Saving…" while
 *  the write is in flight, and moves BACK with "Not saved" if it failed — so
 *  the position always matches what was actually saved. The status sits on the
 *  label's line, which does not wrap, so saving never moves the page. */
export function RecipientResponsesSettings({
  packetId,
  initialEnabled,
  initialLikesEnabled = false,
}: {
  packetId: string;
  initialEnabled: boolean;
  initialLikesEnabled?: boolean;
}) {
  const [actions, setActions] = useState<Set<ResponseAction>>(() => {
    const s = new Set<ResponseAction>();
    if (initialEnabled) s.add("respond");
    if (initialLikesEnabled) s.add("like");
    return s;
  });
  const [saving, setSaving] = useState<ResponseAction | null>(null);
  const [status, setStatus] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});
  const id = useId();
  const headingId = `${id}-heading`;

  async function toggle(action: ResponseAction) {
    if (saving) return;
    const next = new Set(actions);
    const turningOn = !next.has(action);
    if (turningOn) next.add(action); else next.delete(action);

    setActions(next);
    setSaving(action);
    setStatus((s) => ({ ...s, [action]: "saving" }));
    try {
      const res = await fetch(`/api/packets/${packetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseActions: RESPONSE_ACTIONS.filter((a) => next.has(a)) }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((s) => ({ ...s, [action]: "saved" }));
    } catch {
      // The write did not happen, so the switch must not claim it did.
      setActions((current) => {
        const back = new Set(current);
        if (turningOn) back.delete(action); else back.add(action);
        return back;
      });
      setStatus((s) => ({ ...s, [action]: "error" }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className="mb-8 border border-line rounded-[var(--radius-panel)] p-4">
      <h2 id={headingId} className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-3">
        Recipient responses
      </h2>
      <Row
        id={`${id}-respond`}
        label="Allow responses"
        help="People viewing this Sendset can send you a message. You can turn this off anytime."
        on={actions.has("respond")}
        status={status.respond ?? "idle"}
        busy={saving !== null}
        onToggle={() => toggle("respond")}
      />
      <div className="mt-4 border-t border-line pt-4">
        <Row
          id={`${id}-like`}
          label="Allow hearts on items"
          help="People viewing this Sendset can heart individual items, and change their mind later. You see who hearted what; they never see each other."
          on={actions.has("like")}
          status={status.like ?? "idle"}
          busy={saving !== null}
          onToggle={() => toggle("like")}
        />
      </div>
    </section>
  );
}

function Row({
  id, label, help, on, status, busy, onToggle,
}: {
  id: string; label: string; help: string; on: boolean;
  status: "idle" | "saving" | "saved" | "error"; busy: boolean; onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="whitespace-nowrap text-body font-medium text-ink">
          <span id={`${id}-label`}>{label}</span>
          {status === "saving" && <span className="ml-2 text-meta font-normal text-ink-2">Saving…</span>}
          {status === "saved" && <span className="ml-2 text-meta font-normal text-ink-2">Saved</span>}
          {status === "error" && (
            <span role="alert" className="ml-2 text-meta font-normal text-red-700">Not saved</span>
          )}
        </p>
        <p id={`${id}-help`} className="mt-0.5 text-meta text-ink-2">{help}</p>
      </div>
      {/* A 44px target around a 24px switch: the padding is cancelled by the
          negative margin, so the hit area grows and the layout does not. */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onClick={onToggle}
        disabled={busy}
        className="-m-2.5 shrink-0 rounded-full p-2.5 outline-none focus-visible:ring-2 focus-visible:ring-mark/40 disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`relative block h-6 w-11 rounded-full transition-colors ${on ? "bg-ink" : "bg-line-2"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-ground shadow-sm transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
          />
        </span>
      </button>
    </div>
  );
}
