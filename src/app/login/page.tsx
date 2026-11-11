"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  // TWO SIGN-IN PATHS, PRESENTED AT THE SAME ALTITUDE. The magic link was
  // the only way in until now; adding password sign-in alongside it lets
  // someone use the account on a device where the email inbox isn't a
  // comfortable step (a spouse's laptop, a shared computer, a phone).
  // Both paths read the same email field — only the second control changes
  // the shape of the submit. Password is primary (because it is the new
  // affordance a returning professional came here to use) and the magic
  // link is the recovery / first-time path below it. A professional whose
  // account has no password set simply uses the magic link once and sets
  // one from Settings.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"password" | "magic" | "">("");
  const searchParams = useSearchParams();
  const urlError = searchParams.get("error");
  // /new redirects here before its paste box renders, so say WHY rather than
  // presenting a bare form to someone who was mid-task.
  const next = searchParams.get("next");

  const errorMessages: Record<string, string> = {
    "missing-token": "Invalid sign-in link.",
    "invalid-link": "This link has already been used. Request a new one.",
    expired: "This link has expired. Request a new one.",
    "create-failed": "Something went wrong. Please try again.",
    "signup-expired": "Your sign-in link expired before you entered an invite code. Enter your email to get a new one.",
  };

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading("password");
    try {
      const res = await fetch("/api/auth/password-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Both the "wrong" and the "locked" cases come back with a human
        // sentence; prefer `message` (the long one) when present.
        setError(data.message || data.error || "Incorrect email or password.");
        return;
      }
      router.push(next === "new" ? "/new" : "/dashboard");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading("");
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading("magic");

    try {
      const res = await fetch("/api/auth/send-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
      } else {
        setSent(true);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading("");
    }
  }

  if (sent) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
        <h1 className="text-2xl font-bold text-foreground mb-3">Check your email</h1>
        <p className="text-base text-muted max-w-sm mb-6">
          We sent a sign-in link to <strong className="text-foreground">{email}</strong>
        </p>
        <p className="text-sm text-muted max-w-xs">
          Click the link in the email to sign in. It expires in 15 minutes.
          {next === "new" && " Then choose New Sendset from the top of your dashboard."}
        </p>
        <button
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
          className="mt-8 text-sm text-accent hover:text-accent-hover"
        >
          Use a different email
        </button>
      </main>
    );
  }

  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-foreground text-center mb-2">Sendset</h1>
        <p className="text-base text-muted text-center mb-8">
          {next === "new"
            ? "Sign in to start a new Sendset. It’ll be waiting on your dashboard."
            : "Sign in to your account"}
        </p>

        {urlError && errorMessages[urlError] && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {errorMessages[urlError]}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* PASSWORD FORM — primary. Email + password + one submit. */}
        <form onSubmit={handlePasswordSignIn}>
          <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5 mt-4">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <button
            type="submit"
            disabled={loading !== "" || !email || !password}
            className="w-full mt-4 px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading === "password" ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* OR A SIGN-IN LINK. For a first-time use (no password set yet) or
            a forgotten-password recovery. The magic link doubles as the
            password-reset path: sign in via the link, open Settings, set a
            new password. */}
        <div className="mt-6 pt-6 border-t border-border">
          <p className="text-xs text-muted text-center mb-3">
            No password yet, or forgot it? We'll email you a one-click sign-in link.
          </p>
          <form onSubmit={handleMagicLink}>
            <button
              type="submit"
              disabled={loading !== "" || !email}
              className="w-full px-4 py-2.5 rounded-lg border border-border bg-white hover:bg-background text-foreground text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading === "magic" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        </div>

        {/* New professionals need an invite code (early access). Existing
            accounts sign in above with no extra step. */}
        <p className="mt-6 text-center text-sm text-muted">
          New to Sendset?{" "}
          <Link href="/early-access" className="font-medium text-accent underline-offset-4 hover:underline">
            Request an invite.
          </Link>
        </p>

      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
