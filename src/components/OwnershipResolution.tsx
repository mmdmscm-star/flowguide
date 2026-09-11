"use client";
import { useCallback, useState } from "react";
import { Button } from "./ui/button";

// The professional's way out of a media-ownership block.
//
// A finding is never stored, so this panel never holds one either. Every action
// posts, the server recomputes from live rows, and the response REPLACES what is
// on screen. A photo that was moved to the item the source actually names stops
// being a finding because it stopped being true — not because anything here
// marked it resolved. That is why there is no local mutation of the list, and no
// optimistic removal: the only honest source is the recompute that just ran.

export type OwnershipFinding = {
  code: string;
  url?: string;
  itemId: string;
  itemTitle: string;
  proposedItemId?: string;
  proposedItemTitle?: string;
  detail: string;
  actions: Array<"move" | "keep">;
};

/** A photo deliberately kept where it is, as recorded in the database. */
export type KeptPhoto = { itemId: string; itemTitle: string; url: string };

export type OwnershipState = {
  findings: OwnershipFinding[];
  blockingCount: number;
  /** Every Keep on record for this packet — not just the ones made on this
   *  screen. This is what makes a Keep reversible next week rather than only
   *  for as long as the panel happens to stay mounted. */
  kept: KeptPhoto[];
  checked: boolean;
};

/** Identity of a finding for React and for tracking which row is mid-flight.
 *  Findings have no id — they are derived — so this is the (item, photo) pair
 *  the RPCs themselves are keyed on. */
const rowKey = (f: { itemId: string; url?: string }) => `${f.itemId}::${f.url ?? ""}`;

export default function OwnershipResolution({
  packetId,
  state,
  onState,
  onResolved,
}: {
  packetId: string;
  state: OwnershipState;
  onState: (next: OwnershipState) => void;
  /** Every blocking finding is gone. The caller decides what that unlocks. */
  onResolved?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // A Keep SUPPRESSES its finding — that is what a Keep is — so the row vanishes
  // and no recompute can ever surface it again. The undo therefore cannot be
  // driven off findings; it is driven off the decisions themselves, which the
  // server returns with every response. That is what makes this reversible long
  // after the decision was made, rather than only while this panel is mounted.
  const kept = state.kept ?? [];

  const act = useCallback(
    async (f: { itemId: string; url?: string; proposedItemId?: string }, action: "move" | "keep" | "unkeep") => {
      setError("");
      setBusy(`${rowKey(f)}:${action}`);
      try {
        const res = await fetch(`/api/packets/${packetId}/ownership`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            itemId: f.itemId,
            url: f.url,
            ...(action === "move" ? { toItemId: f.proposedItemId } : {}),
          }),
        });
        const data = await res.json();

        // A stale finding still carries the fresh recompute, so the screen
        // corrects itself rather than showing an error about a thing that is
        // already fine.
        if (!res.ok && data.error !== "stale_finding") {
          // A signed-out session is the one failure with a specific remedy, and
          // "Unauthorized" tells a professional nothing they can act on.
          setError(res.status === 401
            ? "Your session has expired. Reload the page and sign in again."
            : data.message || "That didn't go through. Try again.");
          return;
        }
        if (Array.isArray(data.findings)) {
          onState(data as OwnershipState);
          if (data.blockingCount === 0) onResolved?.();
        }
      } catch {
        setError("That didn't go through. Check your connection and try again.");
      } finally {
        setBusy(null);
      }
    },
    [packetId, onState, onResolved],
  );

  const blocking = state.findings.filter((f) => f.code === "media_on_wrong_record");
  const advisory = state.findings.filter((f) => f.code !== "media_on_wrong_record");

  if (blocking.length === 0 && advisory.length === 0 && kept.length === 0) return null;

  // Nothing needs doing when only settled decisions remain, so the panel stops
  // dressing as a warning. Amber means "act now"; a Keep the professional made
  // on purpose is not a problem to be nagged about, it is a record to be able
  // to find and undo.
  const needsAction = blocking.length > 0;

  return (
    /* THE AMBER IS UNCHANGED — it is the one deliberate "act now" signal on a
       surface that is otherwise calm, and this pass did not touch what it means
       or when it appears. What changed is that every word of the panel whose
       whole job is to be READ was 12px on a phone. */
    <div className={`rounded-[var(--radius-panel)] border p-4 text-left ${
      needsAction ? "border-amber-300 bg-amber-50/70" : "border-line bg-ground"
    }`}>
      <p className="text-body font-medium text-ink">
        {needsAction
          ? `Check ${blocking.length === 1 ? "this photo" : `these ${blocking.length} photos`} before publishing`
          : kept.length > 0
            ? `${kept.length === 1 ? "One photo is" : `${kept.length} photos are`} kept here intentionally`
            : "Worth a look before publishing"}
      </p>
      {needsAction ? (
        <p className="mt-1 text-meta text-amber-900">
          Your original source puts {blocking.length === 1 ? "this photo" : "these photos"} on a
          different item than {blocking.length === 1 ? "it is" : "they are"} on now. Move
          {blocking.length === 1 ? " it" : " them"}, or keep {blocking.length === 1 ? "it" : "them"} where
          {blocking.length === 1 ? " it is" : " they are"} if that was deliberate.
        </p>
      ) : kept.length > 0 ? (
        <p className="mt-1 text-meta text-ink-2">
          Your source lists {kept.length === 1 ? "it" : "them"} under
          {kept.length === 1 ? " a different item" : " different items"}, and you chose to keep
          {kept.length === 1 ? " it" : " them"} here. Undo any of these to put the check back.
        </p>
      ) : null}

      {error && <p role="alert" className="mt-2 text-meta text-red-700">{error}</p>}

      <ul className="mt-3 space-y-2">
        {blocking.map((f) => {
          const key = rowKey(f);
          const moving = busy === `${key}:move`;
          const keeping = busy === `${key}:keep`;
          const anyBusy = busy !== null;
          return (
            <li key={key} className="flex items-start gap-3 rounded-[var(--radius-control)] border border-amber-200 bg-white p-3">
              {f.url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={f.url}
                  alt=""
                  className="h-14 w-14 flex-none rounded-md object-cover bg-amber-100"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-ink">{f.itemTitle}</p>
                <p className="mt-0.5 text-meta text-ink-2">
                  {f.proposedItemTitle
                    ? <>Your source lists this photo under <span className="font-medium text-ink">{f.proposedItemTitle}</span>.</>
                    : f.detail}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {f.actions.includes("move") && f.proposedItemTitle && (
                    <Button variant="primary" onClick={() => act(f, "move")} disabled={anyBusy}>
                      {moving ? "Moving…" : `Move to ${f.proposedItemTitle}`}
                    </Button>
                  )}
                  {f.actions.includes("keep") && (
                    <Button variant="secondary" onClick={() => act(f, "keep")} disabled={anyBusy}>
                      {keeping ? "Keeping…" : "Keep here"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {kept.length > 0 && (
        <div className={needsAction ? "mt-3 border-t border-amber-200 pt-3" : "mt-3"}>
          {needsAction && (
            <p className="text-meta font-medium text-amber-900">
              Kept here intentionally
            </p>
          )}
          <ul className="mt-1 space-y-1">
            {kept.map((f) => {
              const undoing = busy === `${rowKey(f)}:unkeep`;
              return (
                <li key={rowKey(f)} className="flex items-center gap-2 text-meta">
                  {/* Which photo, not just which item — an item can hold several,
                      and "Primrose" alone does not say which one was kept. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.url} alt="" className="h-7 w-7 flex-none rounded object-cover bg-amber-100" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{f.itemTitle}</span>
                  <button
                    onClick={() => act(f, "unkeep")}
                    disabled={busy !== null}
                    className="flex-none underline text-ink-2 hover:text-ink disabled:opacity-60"
                  >
                    {undoing ? "Undoing…" : "Undo"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Advisory findings carry no url and resolve to no single destination, so
          they get no buttons — offering one would be a guess. They are shown
          because staying silent about something the check genuinely noticed is
          how the original incident stayed invisible. */}
      {advisory.length > 0 && (
        <div className={`mt-3 border-t pt-3 ${needsAction ? "border-amber-200" : "border-line"}`}>
          <p className={`text-meta font-medium ${needsAction ? "text-amber-900" : "text-ink"}`}>Also worth checking</p>
          <ul className="mt-1 space-y-1">
            {advisory.map((f, i) => (
              <li key={`${rowKey(f)}:${i}`} className="text-meta text-ink-2">
                <span className="font-medium text-ink">{f.itemTitle}</span> — {f.detail}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-ink-2">
            These don&apos;t stop you publishing.
          </p>
        </div>
      )}
    </div>
  );
}
