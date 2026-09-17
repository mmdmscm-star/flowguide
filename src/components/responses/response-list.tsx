"use client";

import { useSyncExternalStore } from "react";
import type { OwnerResponse } from "@/lib/owner-responses";
import { IDENTITY_NOTE, notificationLabel, responseCountLabel, stalenessLabel } from "@/lib/responses";
import { heartCountLabel } from "@/lib/item-actions";

/** The owner's responses on one Sendset. Read-only, newest first, one entry per
 *  submission.
 *
 *  TWO KINDS, SHOWN AS TWO DIFFERENT THINGS, because they are. A message is
 *  correspondence: it happened once, it cannot be edited, and it was emailed. A
 *  set of hearts is a preference somebody can still change, so it says when it
 *  last changed and never claims to have been sent.
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

  const messages = responses.filter((r) => r.kind === "message").length;
  const sessions = responses.length - messages;

  return (
    <div>
      <p className="text-meta text-ink-2 mb-1">
        {responseCountLabel(responses.length)}
        {messages > 0 && sessions > 0 && (
          <span className="text-ink-3">
            {" "}— {messages === 1 ? "1 message" : `${messages} messages`} and{" "}
            {sessions === 1 ? "1 with hearts" : `${sessions} with hearts`}
          </span>
        )}
      </p>
      <p className="text-meta text-ink-3 mb-5">{IDENTITY_NOTE}</p>
      <ol className="space-y-3">
        {responses.map((r) => {
          const stale = r.kind === "message" ? stalenessLabel(r.wasCurrent === true, r.republishedSince) : null;
          return (
            <li key={r.id} className="rounded-[var(--radius-panel)] border border-line bg-ground p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-body font-medium text-ink">
                  {r.name ? `Signed “${r.name}”` : "Unsigned"}
                </p>
                <p className="text-meta text-ink-3" suppressHydrationWarning>
                  {when(r.kind === "actions" ? (r.updatedAt ?? r.createdAt) : r.createdAt)}
                  {r.kind === "actions" && r.updatedAt && r.updatedAt !== r.createdAt && (
                    <span className="text-ink-3"> · last changed</span>
                  )}
                </p>
              </div>

              {r.kind === "message" && (
                <p className="mt-2 whitespace-pre-wrap break-words text-body text-ink">{r.message}</p>
              )}

              {r.kind === "actions" && (
                r.hearts.length === 0 ? (
                  // Every heart withdrawn. The submission stays: somebody
                  // signed it, and "they took it all back" is worth seeing.
                  <p className="mt-2 text-body text-ink-2">No hearts right now — all withdrawn.</p>
                ) : (
                  <div className="mt-2">
                    <p className="text-meta text-ink-2">{heartCountLabel(r.hearts.length)}</p>
                    <ul className="mt-1 space-y-1">
                      {r.hearts.map((h) => (
                        <li key={h.itemId} className="flex flex-wrap items-baseline gap-x-2 text-body text-ink">
                          <span aria-hidden className="text-mark">&#9829;</span>
                          <span className="min-w-0 break-words">{h.label}</span>
                          {!h.inCurrent && (
                            <span className="text-micro text-ink-3">No longer in this Sendset</span>
                          )}
                          {h.inCurrent && stalenessLabel(h.wasCurrent, h.republishedSince) && (
                            <span className="text-micro text-ink-3">{stalenessLabel(h.wasCurrent, h.republishedSince)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}

              {r.contact && (
                <p className="mt-2 break-words text-meta text-ink-2">
                  Contact, as entered (not verified): <span className="text-ink">{r.contact}</span>
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-micro text-ink-3">
                {stale && <span>{stale}</span>}
                {/* Hearts are never emailed: the notification allowance exists
                    for correspondence, and taps must not spend it. */}
                {r.kind === "message" && <span>{notificationLabel(r.notificationDue, r.notifiedAt)}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
