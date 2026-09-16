"use client";

// One request, one obvious action: Approve & send invite. Approving reserves
// the invitation and sends the email; Send again issues a fresh link for the
// same invitation without approving anything twice.
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type RequestRow = {
  id: string;
  name: string;
  email: string;
  use_case: string;
  created_at: string;
  approved_at: string | null;
  invitation_sent_at: string | null;
};

type Outcome = { message: string; ok: boolean };

export function InviteRequestList({ rows }: { rows: RequestRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});

  async function act(id: string, what: "approve" | "resend") {
    if (busy) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/invites/${what}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: id }),
      });
      const data = await res.json().catch(() => ({}));
      setOutcome((o) => ({ ...o, [id]: { ok: res.ok, message: data.message || (res.ok ? "Done." : "That didn't work.") } }));
      if (res.ok) setDone((d) => ({ ...d, [id]: true }));
    } catch {
      setOutcome((o) => ({ ...o, [id]: { ok: false, message: "That didn't work." } }));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return <p className="text-sm text-muted">No requests yet.</p>;

  return (
    <ul className="space-y-4">
      {rows.map((r) => {
        const approved = !!r.approved_at || done[r.id];
        return (
          <li key={r.id} className="rounded-[var(--radius-panel)] border border-line bg-ground p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body font-medium text-ink">{r.name}</p>
                <p className="text-meta text-ink-2 break-all">{r.email}</p>
                <p className="mt-1 text-micro text-ink-3">
                  {new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {r.approved_at ? " · approved" : ""}
                  {r.invitation_sent_at ? " · invitation sent" : r.approved_at ? " · not sent" : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!approved && (
                  <Button variant="primary" size="sm" disabled={busy === r.id} onClick={() => act(r.id, "approve")}>
                    {busy === r.id ? "Sending…" : "Approve & send invite"}
                  </Button>
                )}
                {approved && (
                  <Button variant="secondary" size="sm" disabled={busy === r.id} onClick={() => act(r.id, "resend")}>
                    {busy === r.id ? "Sending…" : "Send again"}
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-meta text-ink-2">{r.use_case}</p>
            {outcome[r.id] && (
              <p role="status" className={`mt-3 text-meta ${outcome[r.id].ok ? "text-emerald-800" : "text-red-700"}`}>
                {outcome[r.id].message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
