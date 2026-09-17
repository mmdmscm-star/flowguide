"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useHearts } from "./hearts-provider";

/** THE ONE TIME A HEART ASKS FOR ANYTHING.
 *
 *  A first heart needs a name, because "somebody hearted two of these" is not
 *  something a professional can act on, and because a shared browser must be
 *  able to say whose response it is carrying. After this, hearts are immediate
 *  and this never appears again.
 *
 *  CANCELLING WRITES NOTHING. The heart that opened this goes back to empty, no
 *  capability is minted, no row exists, and no cookie is set — a person who
 *  changes their mind at the name field has left no trace at all. */
export function SignatureSheet() {
  const hearts = useHearts();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const open = Boolean(hearts?.askingFor);

  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  if (!hearts || !open) return null;

  const small = { fontSize: "var(--sg-small)", lineHeight: "var(--sg-small-lh)" } as const;
  const body = { fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" } as const;
  const input = {
    ...body, color: "var(--sg-ink)", background: "var(--sg-surface)",
    border: "1px solid var(--sg-line)", borderRadius: "var(--sg-radius-inner)",
  } as const;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const failed = await hearts!.confirmSignature(name, contact);
    setBusy(false);
    if (failed) setError(failed);
    else { setName(""); setContact(""); }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center sm:items-center"
      style={{ background: "rgba(15,15,15,0.35)" }}
      onClick={() => !busy && hearts.cancelSignature()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm p-5"
        style={{ background: "var(--sg-surface)", borderRadius: "var(--sg-card-radius)" }}
      >
        <h2 id={`${id}-title`} className="font-semibold" style={{ ...body, color: "var(--sg-ink)" }}>
          Who&rsquo;s hearting?
        </h2>
        <p className="mt-1 mb-4" style={{ ...small, color: "var(--sg-muted)" }}>
          So the person who shared this knows whose favourites these are. Only they see it.
        </p>
        <form onSubmit={save} noValidate className="space-y-3">
          <div>
            <label htmlFor={`${id}-name`} className="mb-1 block font-medium" style={{ ...small, color: "var(--sg-ink)" }}>
              Your name
            </label>
            <input
              ref={field} id={`${id}-name`} name="name" autoComplete="name" required
              value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 outline-none focus-visible:ring-2" style={input}
            />
          </div>
          <div>
            <label htmlFor={`${id}-contact`} className="mb-1 block font-medium" style={{ ...small, color: "var(--sg-ink)" }}>
              How to reach you <span style={{ color: "var(--sg-muted)", fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id={`${id}-contact`} name="contact"
              value={contact} onChange={(e) => setContact(e.target.value)}
              className="w-full px-3 py-2.5 outline-none focus-visible:ring-2" style={input}
            />
          </div>
          {error && <p role="alert" style={{ ...small, color: "#b42318" }}>{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit" disabled={busy}
              className="sg-btn-primary flex-1 py-2.5 disabled:opacity-60"
              style={{ ...body, borderRadius: "var(--sg-card-radius)" }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button" onClick={() => hearts.cancelSignature()} disabled={busy}
              className="px-4 py-2.5"
              style={{ ...body, color: "var(--sg-muted)", border: "1px solid var(--sg-line)", borderRadius: "var(--sg-card-radius)" }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
