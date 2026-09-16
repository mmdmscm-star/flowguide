"use client";

// The invite code, typed once. It is sent in the request body — never in the
// URL — and the page keeps nothing.
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function JoinForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/redeem-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "That invite code isn't valid.");
        setBusy(false);
        return;
      }
      // The session cookie is set; the dashboard is a server render away.
      router.push("/dashboard");
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}
      <label htmlFor="invite-code" className="mb-1.5 block text-sm font-medium text-foreground">Invite code</label>
      <input
        id="invite-code"
        name="invite-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
        className="w-full rounded-lg border border-border bg-white px-3.5 py-2.5 font-mono text-sm tracking-wide text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-4 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "Checking…" : "Continue"}
      </button>
      <p className="mt-6 text-center text-sm text-muted">
        Don&rsquo;t have a code?{" "}
        <Link href="/early-access" className="font-medium text-accent underline-offset-4 hover:underline">
          Request an invite.
        </Link>
      </p>
    </form>
  );
}
