"use client";

import { useState } from "react";
import Link from "next/link";

const FIELD = "w-full rounded-lg border border-border bg-white px-3.5 py-2.5 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent";

export function EarlyAccessForm() {
  const [form, setForm] = useState({ name: "", email: "", useCase: "", website: "" });
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
      setState("sent");
    } catch {
      setError("Something went wrong. Please try again.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div>
        <p className="text-base text-foreground">
          Thank you — your request is in. I read these myself and will be in touch.
        </p>
        <p className="mt-6 text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Sign in</Link>
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
        {state === "sending" ? "Sending…" : "Request early access"}
      </button>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
