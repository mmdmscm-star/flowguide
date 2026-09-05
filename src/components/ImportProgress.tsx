"use client";
import { useEffect, useRef } from "react";
import { useIngestion } from "@/lib/useIngestion";
import { isResolvable, hasUnresolvableBlocker, guidanceFor, dispositionsFor,
         headlineFor, actionLabel } from "@/lib/review-units";

// Drives (resumes) a persisted ingestion run and shows real progress. Rendered
// whenever a packet has an active run — from a fresh Organize, an Add-with-AI, or
// a page reload mid-import. Progress reflects completed persisted chunks.
export default function ImportProgress({
  packetId,
  runId,
  onDone,
  onDiscarded,
  onNeedsReview,
  onItemsChanged,
}: {
  packetId: string;
  runId: string;
  onDone: () => void;
  onDiscarded: () => void;
  /** The run applied but publishing is blocked. The packet has content, so the
   *  editor should refresh — but this panel must STAY, because it holds the
   *  only way out. */
  onNeedsReview?: () => void;
  /** "Keep as private note" wrote into an item. The editor below holds its own
   *  copy of the packet, so it has to re-read — the card disappearing is not
   *  the same as the note appearing. */
  onItemsChanged?: () => void;
}) {
  const { state, resume, retry, discard, resolveUnit, applyAnyway } = useIngestion(packetId, { onComplete: onDone, onNeedsReview, onItemsChanged });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resume(runId);
  }, [runId, resume]);

  const { phase, done, total, subdividing, error, reviewSummary, reviewExit, reviewFailures, resolving, recovery } = state;
  const needsReview = phase === "needs_review";
  // Held content the professional can decide about, still outstanding.
  const open = reviewFailures.filter((f) => isResolvable(f) && (f.status ?? "unresolved") === "unresolved");
  // Discard stays the exit only while something is blocking that these controls
  // cannot clear. Offering it as the primary action next to two buttons that
  // WOULD clear the block is how a professional throws away a good import.
  const discardIsOnlyExit = hasUnresolvableBlocker(reviewFailures);
  // `review.summary` describes what finalize FOUND. Once decisions start
  // landing it is history, and leaving it up means the banner says "2 pieces"
  // above a list of one. The stored sentence still speaks for blockers these
  // controls cannot clear; for the units, the live count does.
  const headline = discardIsOnlyExit || open.length === 0
    ? (reviewSummary || "Something didn't add up in this import.")
    : open.length === 1
      ? "1 piece of information needs a decision before publishing."
      : `${open.length} pieces of information need a decision before publishing.`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const heading =
    phase === "preparing" ? "Preparing your information…"
    : phase === "combining" ? "Combining and checking the result…"
    : phase === "done" ? "Done."
    : needsReview ? "Imported — but check this before publishing"
    : phase === "error" ? "Import paused"
    : total > 0 ? `Processing part ${Math.min(done + 1, total)} of ${total}…`
    : "Reading your notes…";


  // THE FLOWGUIDE CHANGED WHILE AI WAS WORKING.
  //
  // This used to be terminal: the run stayed active, the completed work was
  // unreachable, and the only exit was discarding it. It is a CHOICE now — but
  // "Add the organized content" appears only when the server said it can be
  // reconciled. Offering an action that finalizes and then leaves the FlowGuide
  // unpublishable would be worse than not offering one.
  if (phase === "conflict") {
    const canApply = recovery?.canApply === true;
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 mb-5">
        <p className="text-sm font-medium text-foreground">This Sendset changed while AI was working</p>
        <p className="mt-1 text-sm text-muted">{error}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {canApply && (
            <button
              onClick={applyAnyway}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Add the organized content
            </button>
          )}
          <button
            onClick={() => { discard(); onDiscarded(); }}
            className={canApply
              ? "text-sm font-medium text-muted underline-offset-4 hover:underline"
              : "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"}
          >
            Discard this import
          </button>
        </div>
        {canApply && (
          <p className="mt-2 text-xs text-muted">
            It will be added after your existing sections. Nothing already in this Sendset is changed or replaced.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border p-4 mb-5 ${needsReview ? "border-amber-300 bg-amber-50/70" : "border-border bg-blue-50/60"}`}>
      <div className="flex items-center gap-3">
        {phase !== "error" && phase !== "done" && !needsReview && (
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        )}
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">{heading}</p>
          {phase !== "error" && !needsReview && (
            <div className="mt-2 h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${phase === "combining" ? 100 : pct}%` }} />
            </div>
          )}
          {subdividing && phase === "processing" && (
            <p className="mt-1 text-xs text-muted">A large part is being divided further so it stays reliable…</p>
          )}
          {phase === "error" && <p className="mt-1 text-sm text-red-700">{error} Your completed parts are saved.</p>}
          {needsReview && (
            <p className="mt-1 text-sm text-amber-900">
              {headline}{" "}
              {reviewExit || "Discard the import to clear this review."}
            </p>
          )}
        </div>
      </div>

      {/* THE HELD CONTENT ITSELF.
          The source text is shown verbatim, because a decision about writing
          nobody can read is not a decision. It sits with the item it came from,
          and neither button writes it anywhere: FlowGuide choosing a
          destination is the error this panel exists to prevent. */}
      {needsReview && open.length > 0 && (
        <ul className="mt-3 space-y-2">
          {open.map((f) => (
            <li key={f.id} className="rounded-lg border border-amber-200 bg-white/70 p-3">
              {/* A KIND THAT HOLDS A WHOLE RUN'S MATERIAL NAMES ITSELF.
                  Most cards are one excerpt from one titled item and the title
                  says enough; this one is a list of lines from across a source,
                  and "Spring Lake Village" alone would not say what happened.
                  From the registry, never hardcoded here. */}
              {headlineFor(f) && (
                <p className="text-sm font-semibold text-amber-900">{headlineFor(f)}</p>
              )}
              {f.title && <p className="text-xs font-medium text-amber-900">{f.title}</p>}
              <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">{f.text}</p>
              {/* From the exception registry, not hardcoded here, so a future
                  review-required kind arrives with its own wording. */}
              <p className="mt-1 text-xs text-muted">{guidanceFor(f)}</p>
              {/* THE BUTTON SHOULD PERFORM THE DECISION.
                  "I've handled this" resolved the unit and did nothing to the
                  material — and because settling removes the excerpt, and the
                  contract had already cleared it off the item, pressing it
                  destroyed the note. Keeping it as a private note is now a real
                  action FlowGuide carries out; the manual path says plainly
                  that FlowGuide is NOT the one moving anything. */}
              {/* WHICH ACTIONS, FROM THE REGISTRY. A kind holding recipient-facing
                  material does not offer to file it privately: that would hide
                  the whole item from the person it was written for, behind a
                  button that reads like the cautious choice. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {dispositionsFor(f).includes("kept_private") && (
                  <button
                    disabled={resolving === f.id}
                    onClick={() => resolveUnit(f.id, "kept_private")}
                    className="px-2.5 py-1 rounded-md bg-amber-700 text-white text-xs font-medium hover:bg-amber-800 disabled:opacity-60"
                  >
                    {resolving === f.id ? "Saving\u2026" : "Keep as private note"}
                  </button>
                )}
                <button
                  disabled={resolving === f.id}
                  onClick={() => resolveUnit(f.id, "resolved")}
                  className="px-2.5 py-1 rounded-md border border-border text-xs font-medium text-foreground hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {actionLabel(f, "resolved", dispositionsFor(f).includes("kept_private")
                    ? "I added it elsewhere"
                    : "I added it where it belongs")}
                </button>
                <button
                  disabled={resolving === f.id}
                  onClick={() => resolveUnit(f.id, "ignored")}
                  className="px-2.5 py-1 rounded-md border border-border text-xs font-medium text-muted hover:text-foreground disabled:opacity-60"
                >
                  {actionLabel(f, "ignored", "Leave it out")}
                </button>
              </div>
              {/* Said once per card, quietly, because the difference between the
                  buttons is the whole point \u2014 and because BOTH acknowledgement
                  paths clear FlowGuide\u2019s copy of this text, which the
                  professional should know before pressing one. */}
              <p className="mt-1.5 text-[11px] text-muted/80">
                {dispositionsFor(f).includes("kept_private")
                  ? "Only you would see a private note. \u201cI added it elsewhere\u201d just closes this \u2014 Sendset does not move the text for you."
                  : "Sendset does not move this for you. Copy anything you still need before closing this \u2014 either button clears Sendset\u2019s copy."}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        {phase === "error" && (
          <button onClick={() => retry()} className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium">
            Resume import
          </button>
        )}
        {phase !== "done" && (
          <button
            onClick={async () => { await discard(); onDiscarded(); }}
            // In needs_review this WAS the only way out. It still is whenever a
            // blocker exists that the per-unit controls cannot clear; when every
            // blocker is decidable above, it goes back to being secondary.
            className={needsReview && discardIsOnlyExit
              ? "px-3 py-1.5 rounded-lg bg-amber-700 text-white text-sm font-medium hover:bg-amber-800"
              : "px-3 py-1.5 rounded-lg text-sm font-medium text-muted hover:text-foreground border border-border"}
          >
            Discard import
          </button>
        )}
      </div>
    </div>
  );
}
