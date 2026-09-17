"use client";

import { useId, useState } from "react";
import { respondHeading, RESPONSE_OUTCOME, type ResponseField } from "@/lib/responses";

/** THE ONE PLACE A RECIPIENT CAN ANSWER.
 *
 *  Rendered by the recipient page only when the Sendset is published, is not a
 *  demo, accepts responses, and the reader is not its owner. Never on Preview,
 *  print or email.
 *
 *  QUIET. One button at the end of the Sendset, above the signature; the form
 *  opens in place only when asked for. The professional's content stays the
 *  focus, and a reader who does not want to respond never sees a form.
 *
 *  NOTHING ABOUT OTHER RESPONSES. No count, no "others have responded", no
 *  list — whoever else holds this link, what they said is not this reader's.
 *
 *  THE MARKER is handed back exactly as the server rendered it: an opaque
 *  string, never parsed. See MARKER_SHAPE in lib/responses.ts.
 *
 *  WHAT THEY TYPED SURVIVES A REFUSAL. Only a successful send clears the form,
 *  and it is replaced by "Sent." with no echo of the message.
 *
 *  NO maxLength on the fields: a browser truncates a paste to it silently, and
 *  a message cut short without a word is worse than being told it is too long.
 *
 *  IT POSTS TO THE CANONICAL PATH, /p/<slug>/respond. The old /api path is kept
 *  alive only for bundles rendered before the move, which are still open in
 *  somebody's browser; nothing new calls it. */
export function RespondPanel({ slug, marker, senderName }: { slug: string; marker: string; senderName?: string | null }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<{ field: ResponseField; message: string } | null>(null);
  const id = useId();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/p/${encodeURIComponent(slug)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marker, name, contact, message, website }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; field?: ResponseField };
      if (res.ok) {
        setState("sent");
        setName(""); setContact(""); setMessage("");
        return;
      }
      setError({ field: body.field ?? "form", message: body.message || RESPONSE_OUTCOME.failed });
    } catch {
      setError({ field: "form", message: RESPONSE_OUTCOME.failed });
    }
    setState("idle");
  }

  const small = { fontSize: "var(--sg-small)", lineHeight: "var(--sg-small-lh)" } as const;
  const body = { fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" } as const;
  const shell = "mx-[var(--sg-page-gutter)] mb-8";

  if (state === "sent") {
    return (
      <section className={shell} aria-live="polite">
        <p role="status" className="text-center font-medium" style={{ ...body, color: "var(--sg-ink)" }}>
          {RESPONSE_OUTCOME.sent}
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <div className={shell}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="w-full py-3 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            ...body,
            color: "var(--sg-ink)",
            background: "transparent",
            border: "1px solid var(--sg-line)",
            borderRadius: "var(--sg-card-radius)",
          }}
        >
          Respond
        </button>
      </div>
    );
  }

  const input = "w-full px-3 py-2.5 outline-none focus-visible:ring-2";
  const inputStyle = {
    ...body,
    color: "var(--sg-ink)",
    background: "var(--sg-surface)",
    border: "1px solid var(--sg-line)",
    borderRadius: "var(--sg-radius-inner)",
  } as const;
  const label = "block font-medium mb-1";
  const fieldError = (field: ResponseField) =>
    error?.field === field ? (
      <p id={`${id}-${field}-err`} role="alert" className="mt-1" style={{ ...small, color: "#b42318" }}>{error.message}</p>
    ) : null;
  const describedBy = (field: ResponseField, extra?: string) =>
    [extra, error?.field === field ? `${id}-${field}-err` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <section
      className={`${shell} p-5`}
      aria-labelledby={`${id}-heading`}
      style={{ border: "1px solid var(--sg-line)", borderRadius: "var(--sg-card-radius)", background: "var(--sg-surface)" }}
    >
      <h2 id={`${id}-heading`} className="font-semibold mb-1" style={{ ...body, color: "var(--sg-ink)" }}>
        {respondHeading(senderName)}
      </h2>
      <p className="mb-4" style={{ ...small, color: "var(--sg-muted)" }}>
        Only the person who shared this Sendset sees your message.
      </p>

      <form onSubmit={send} noValidate className="space-y-4">
        <div>
          <label htmlFor={`${id}-name`} className={label} style={{ ...small, color: "var(--sg-ink)" }}>Your name</label>
          <input
            id={`${id}-name`} name="name" autoComplete="name" required autoFocus
            value={name} onChange={(e) => setName(e.target.value)}
            aria-invalid={error?.field === "name" || undefined} aria-describedby={describedBy("name")}
            className={input} style={inputStyle}
          />
          {fieldError("name")}
        </div>

        <div>
          <label htmlFor={`${id}-contact`} className={label} style={{ ...small, color: "var(--sg-ink)" }}>
            How to reach you <span style={{ color: "var(--sg-muted)", fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id={`${id}-contact`} name="contact"
            value={contact} onChange={(e) => setContact(e.target.value)}
            aria-invalid={error?.field === "contact" || undefined} aria-describedby={describedBy("contact", `${id}-contact-help`)}
            className={input} style={inputStyle}
          />
          <p id={`${id}-contact-help`} className="mt-1" style={{ ...small, color: "var(--sg-muted)" }}>
            An email or phone number, if you&rsquo;d like a reply.
          </p>
          {fieldError("contact")}
        </div>

        <div>
          <label htmlFor={`${id}-message`} className={label} style={{ ...small, color: "var(--sg-ink)" }}>Message</label>
          <textarea
            id={`${id}-message`} name="message" required rows={4}
            value={message} onChange={(e) => setMessage(e.target.value)}
            aria-invalid={error?.field === "message" || undefined} aria-describedby={describedBy("message")}
            className={`${input} resize-y`} style={inputStyle}
          />
          {fieldError("message")}
        </div>

        {/* Not for people. Hidden from sight, from assistive technology and from
            the tab order; anything typed here is answered as a success and
            stored nowhere. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
          <label htmlFor={`${id}-website`}>Website</label>
          <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off"
            value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>

        {fieldError("form")}

        <button
          type="submit"
          disabled={state === "sending"}
          className="sg-btn-primary w-full py-3 transition-colors disabled:opacity-60"
          style={{ ...body, borderRadius: "var(--sg-card-radius)" }}
        >
          {state === "sending" ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
