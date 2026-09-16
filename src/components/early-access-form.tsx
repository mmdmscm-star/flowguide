"use client";

import { useState } from "react";
import Link from "next/link";

const FIELD = "w-full rounded-lg border border-border bg-white px-3.5 py-2.5 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent";

export function EarlyAccessForm() {
  const [form, setForm] = useState({ name: "", email: "", useCase: "", website: "" });
  // The address the request was actually sent with, so the confirmation names
  // what was submitted rather than whatever the box holds afterwards.
  const [sentTo, setSentTo] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError("");
    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Something went wrong. Please try again.");
        setState("idle");
        return;
      }
      setSentTo(form.email.trim());
      setState("sent");
    } catch {
      setError("Something went wrong. Please try again.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div>
        <h2 className="text-lg font-semibold text-foreground">Request received</h2>
        {/* Says plainly that nothing arrives now: the only email is an invite,
            and only if one becomes available. */}
        <p className="mt-2 text-base text-muted">
          We&rsquo;ll contact you at <span className="font-medium text-foreground">{sentTo}</span>{" "}
          if an invite becomes available. There&rsquo;s nothing else you need to do.
        </p>
        <p className="mt-6 text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Sign in</Link>
        </p>
        <p className="mt-2 text-sm text-muted">
          Already have an invite code?{" "}
          <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Continue with email</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <label htmlFor="ea-name" className="mb-1.5 block text-sm font-medium text-foreground">Your name</label>
      <input id="ea-name" value={form.name} onChange={set("name")} required maxLength={200} autoComplete="name" className={FIELD} />

      <label htmlFor="ea-email" className="mb-1.5 mt-4 block text-sm font-medium text-foreground">Email address</label>
      <input id="ea-email" type="email" value={form.email} onChange={set("email")} required maxLength={320} autoComplete="email" placeholder="you@example.com" className={FIELD} />

      <label htmlFor="ea-use" className="mb-1.5 mt-4 block text-sm font-medium text-foreground">What would you like to use Sendset for?</label>
      <textarea id="ea-use" value={form.useCase} onChange={set("useCase")} required maxLength={2000} rows={4} className={FIELD} />

      {/* Left empty by people and filled by scripts. Hidden from assistive
          technology too, so nobody is asked to fill it in. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="ea-website">Website</label>
        <input id="ea-website" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
      </div>

      <button type="submit" disabled={state === "sending"}
        className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60">
        {state === "sending" ? "Sending…" : "Request an invite"}
      </button>

      <p className="mt-3 text-center text-sm text-muted">
        No email is sent now. We&rsquo;ll only be in touch if an invite becomes available.
      </p>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Sign in</Link>
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        Already have an invite code?{" "}
        <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Continue with email</Link>
      </p>
    </form>
  );
}
