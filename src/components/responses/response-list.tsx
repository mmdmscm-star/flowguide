"use client";

import { useSyncExternalStore } from "react";
import type { OwnerResponse } from "@/lib/owner-responses";
import { IDENTITY_NOTE, notificationLabel, responseCountLabel, stalenessLabel } from "@/lib/responses";

/** The owner's list of responses on one Sendset. Read-only, newest first, one
 *  entry per submission.
 *
 *  WORDING IS THE SAFEGUARD. A name is a SIGNATURE — "Signed “Lisa”" — never an
 *  author ("From Lisa"), and never a vote or a person count. Contact details are
 *  shown as entered and labelled unverified. Replying happens outside Sendset,
 *  from the professional's own email or phone. */
const noSubscribe = () => () => {};

export function ResponseList({ responses, responsesEnabled }: { responses: OwnerResponse[]; responsesEnabled: boolean }) {
  // Times are shown in the READER'S timezone, which only the browser knows.
  // Rendered after mount so the server's clock never reaches the page.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const when = (iso: string) =>
    mounted
      ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "";

  if (responses.length === 0) {
    return (
      <p className="text-body text-ink-2">
        {responsesEnabled
          ? "No responses yet."
          : "No responses yet. Responses are off for this Sendset — turn them on in the editor, under Recipient responses."}
      </p>
    );
  }

  return (
    <div>
      <p className="text-meta text-ink-2 mb-1">{responseCountLabel(responses.length)}</p>
      <p className="text-meta text-ink-3 mb-5">{IDENTITY_NOTE}</p>
      <ol className="space-y-3">
        {responses.map((r) => {
          const stale = stalenessLabel(r.wasCurrent, r.republishedSince);
          return (
            <li key={r.id} className="rounded-[var(--radius-panel)] border border-line bg-ground p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-body font-medium text-ink">
                  {r.name ? `Signed “${r.name}”` : "Unsigned"}
                </p>
                <p className="text-meta text-ink-3" suppressHydrationWarning>{when(r.createdAt)}</p>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-body text-ink">{r.message}</p>
              {r.contact && (
                <p className="mt-2 break-words text-meta text-ink-2">
                  Contact, as entered (not verified): <span className="text-ink">{r.contact}</span>
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-micro text-ink-3">
                {stale && <span>{stale}</span>}
                <span>{notificationLabel(r.notificationDue, r.notifiedAt)}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
