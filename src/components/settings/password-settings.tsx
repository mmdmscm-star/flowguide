"use client";

// Account password — set or change. Sits on /settings alongside the
// professional profile. A section, not a modal: the task is small and
// self-contained, and burying it behind an extra click would hide the
// one affordance someone looked at this page to find.
//
// EMPTY vs SET. The parent passes `hasPassword` so the primary verb
// adjusts ("Set a password" vs "Change password"). Everything else about
// the form is the same — one new-password field, one confirm field, one
// submit. No "old password" field even for a change, because the
// account is already signed in to reach this page; a bad actor with a
// live session can do far worse than change a password, and the
// magic-link reset path means a locked-out professional can always
// recover without knowing the old one.

import { useState } from "react";

const MIN_LENGTH = 10;

export default function PasswordSettings({
  hasPassword,
  passwordUpdatedAt,
}: {
  hasPassword: boolean;
  /** ISO string; shown as a plain date so "last changed" is answerable
   *  without clicking into audit logs that do not exist. */
  passwordUpdatedAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(passwordUpdatedAt);
  const [hasPw, setHasPw] = useState(hasPassword);

  function reset() {
    setPassword(""); setConfirm(""); setError(""); setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters — longer is stronger.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || "Couldn't save your password.");
        return;
      }
      setHasPw(true);
      setSavedAt(new Date().toISOString());
      reset();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 rounded-xl border border-line bg-white p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">Password</h2>
          <p className="mt-1 text-sm text-muted">
            {hasPw
              ? "You can sign in with your email and password on any device — no need for the sign-in email."
              : "Add a password to sign in without the email link — handy for a shared device, a phone, or another person using this account."}
            {savedAt && (
              <>
                {" "}<span className="text-ink-3">Last changed {formatDate(savedAt)}.</span>
              </>
            )}
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex-none px-3 py-1.5 rounded-lg border border-line bg-white text-sm font-medium text-ink hover:border-mark hover:text-mark"
          >
            {hasPw ? "Change password" : "Set a password"}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={submit} className="mt-5 space-y-3">
          <div>
            <label htmlFor="new-password" className="block text-sm font-medium text-foreground mb-1.5">
              {hasPw ? "New password" : "Password"}
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_LENGTH} characters`}
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="block text-sm font-medium text-foreground mb-1.5">
              Confirm
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type it again"
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            />
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Saving…" : hasPw ? "Save new password" : "Set password"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          {!hasPw && (
            <p className="pt-2 text-xs text-muted">
              You can still sign in with the email link too — the password is an alternative, not a replacement.
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "recently";
  }
}
