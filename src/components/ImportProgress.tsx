"use client";
import { useEffect, useRef } from "react";
import { useIngestion } from "@/lib/useIngestion";
import { isResolvable, hasUnresolvableBlocker, guidanceFor, dispositionsFor,
         headlineFor, actionLabel, namesOneItem } from "@/lib/review-units";

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
  // A FINITE TASK, NOT AN UNBOUNDED WALL.
  //
  // Twenty-six identical cards with no count is not twenty-six decisions, it is
  // an unknown number of them — and a professional who settles two of three has
  // no way to see they are one from done. In real use every run that reached
  // this state stayed in it; the decisions were never the hard part, knowing
  // whether they would end was.
  const decidable = reviewFailures.filter(isResolvable);
  const settled = decidable.length - open.length;
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
      <div className="rounded-[var(--radius-panel)] border border-amber-300 bg-amber-50/70 p-4 mb-5">
        <p className="text-body font-medium text-ink">This Sendset changed while AI was working</p>
        <p className="mt-1 text-body text-ink-2">{error}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {canApply && (
            <button
              onClick={applyAnyway}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-body font-medium text-white hover:bg-ink-hover"
            >
              Add the organized content
            </button>
          )}
          <button
            onClick={() => { discard(); onDiscarded(); }}
            className={canApply
              ? "text-body font-medium text-ink-2 underline-offset-4 hover:underline"
              : "rounded-[var(--radius-control)] bg-ink px-4 py-2 text-body font-medium text-white hover:bg-ink-hover"}
          >
            Discard this import
          </button>
        </div>
        {canApply && (
          <p className="mt-2 text-meta text-ink-2">
            It will be added after your existing sections. Nothing already in this Sendset is changed or replaced.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-[var(--radius-panel)] border p-4 mb-5 ${needsReview ? "border-amber-300 bg-amber-50/70" : "border-line bg-mark-soft"}`}>
      <div className="flex items-center gap-3">
        {phase !== "error" && phase !== "done" && !needsReview && (
          <div className="w-4 h-4 border-2 border-mark border-t-transparent rounded-full animate-spin" />
        )}
        <div className="flex-1">
          <p className="text-body font-medium text-ink">{heading}</p>
          {phase !== "error" && !needsReview && (
            <div className="mt-2 h-1.5 w-full rounded-full bg-ground-3 overflow-hidden">
              <div className="h-full bg-ink transition-all" style={{ width: `${phase === "combining" ? 100 : pct}%` }} />
            </div>
          )}
          {subdividing && phase === "processing" && (
            <p className="mt-1 text-meta text-ink-2">A large part is being divided further so it stays reliable…</p>
          )}
          {phase === "error" && <p className="mt-1 text-body text-red-700">{error} Your completed parts are saved.</p>}
          {needsReview && (
            <>
              <p className="mt-1.5 text-meta text-amber-900">
                {headline}{" "}
                {reviewExit || "Discard the import to clear this review."}
              </p>
              {decidable.length > 1 && (
                <div className="mt-2.5">
                  <div className="flex items-center justify-between gap-3 text-micro font-medium text-amber-900">
                    <span aria-live="polite">
                      {settled} of {decidable.length} settled
                    </span>
                    {open.length === 0 && <span>Publishing is unblocked.</span>}
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-amber-200/70">
                    <div className="h-full rounded-full bg-amber-700 transition-all"
                         style={{ width: `${Math.round((settled / decidable.length) * 100)}%` }} />
                  </div>
                </div>
              )}
            </>
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
          {open.map((f, i) => {
            // SAID WHEN IT CHANGES, NOT ONCE PER CARD.
            //
            // This sentence is a function of which dispositions the KIND
            // offers, so on a run of twenty-six units of one kind it was the
            // same forty-five words printed twenty-six times — more text than
            // the excerpts it was explaining, and the thing a reader learns to
            // skip. It still appears above the first card it applies to, and
            // again the moment the answer differs, so nobody presses a button
            // whose consequence has not been stated.
            const note = dispositionsFor(f).includes("included")
              ? "Adding puts each line into this item using your source wording. The other two just close this \u2014 and they clear Sendset\u2019s copy, so save anything you still need first."
              : dispositionsFor(f).includes("kept_private")
                ? "Only you would see a private note. \u201cI added it elsewhere\u201d just closes this \u2014 Sendset does not move the text for you."
                : "Sendset does not move this for you. Copy anything you still need before closing this \u2014 either button clears Sendset\u2019s copy.";
            const prev = i > 0 ? open[i - 1] : null;
            const prevNote = prev
              ? (dispositionsFor(prev).includes("included")
                  ? "included" : dispositionsFor(prev).includes("kept_private") ? "private" : "neither")
              : null;
            const thisNote = dispositionsFor(f).includes("included")
              ? "included" : dispositionsFor(f).includes("kept_private") ? "private" : "neither";
            const showNote = thisNote !== prevNote;
            return (
            <li key={f.id} className="rounded-[var(--radius-control)] border border-amber-200 bg-ground/70 p-3">
              {/* A KIND THAT HOLDS A WHOLE RUN'S MATERIAL NAMES ITSELF.
                  Most cards are one excerpt from one titled item and the title
                  says enough; this one is a list of lines from across a source,
                  and "Spring Lake Village" alone would not say what happened.
                  From the registry, never hardcoded here. */}
              {headlineFor(f) && (
                <p className="text-body font-semibold text-amber-900">{headlineFor(f)}</p>
              )}
              {f.title && <p className="text-meta font-medium text-amber-900">{f.title}</p>}
              <p className="mt-1 text-body text-ink whitespace-pre-wrap">{f.text}</p>
              {/* From the exception registry, not hardcoded here, so a future
                  review-required kind arrives with its own wording. */}
              <p className="mt-1 text-meta text-ink-2">{guidanceFor(f)}</p>
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
                {/* THE BUTTON THAT ADDS THE MATERIAL, when the kind offers it
                    AND the unit names exactly one item to add it to.
                    resolve_review_unit refuses a unit that names none or two —
                    finalize attaches itemIds only when the title resolves to a
                    single item — so offering it there would hand the
                    professional a button whose only outcome is a refusal. The
                    other two answers stay: they settle without writing. */}
                {dispositionsFor(f).includes("included") && namesOneItem(f) && (
                  <button
                    disabled={resolving === f.id}
                    onClick={() => resolveUnit(f.id, "included")}
                    className="flex h-10 items-center rounded-[var(--radius-control)] bg-amber-700 px-3.5 text-meta font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-60 sm:h-9 sm:px-3"
                  >
                    {resolving === f.id ? "Adding\u2026" : actionLabel(f, "included", "Add these to the item")}
                  </button>
                )}
                {dispositionsFor(f).includes("kept_private") && (
                  <button
                    disabled={resolving === f.id}
                    onClick={() => resolveUnit(f.id, "kept_private")}
                    className="flex h-10 items-center rounded-[var(--radius-control)] bg-amber-700 px-3.5 text-meta font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-60 sm:h-9 sm:px-3"
                  >
                    {resolving === f.id ? "Saving\u2026" : "Keep as private note"}
                  </button>
                )}
                <button
                  disabled={resolving === f.id}
                  onClick={() => resolveUnit(f.id, "resolved")}
                  className="flex h-10 items-center rounded-[var(--radius-control)] border border-amber-300 bg-ground px-3.5 text-meta font-medium text-ink transition-colors hover:border-amber-500 disabled:opacity-60 sm:h-9 sm:px-3"
                >
                  {actionLabel(f, "resolved", dispositionsFor(f).includes("kept_private")
                    ? "I added it elsewhere"
                    : "I added it where it belongs")}
                </button>
                <button
                  disabled={resolving === f.id}
                  onClick={() => resolveUnit(f.id, "ignored")}
                  className="flex h-10 items-center rounded-[var(--radius-control)] border border-amber-300 bg-ground px-3.5 text-meta font-medium text-ink-2 transition-colors hover:border-amber-500 hover:text-ink disabled:opacity-60 sm:h-9 sm:px-3"
                >
                  {actionLabel(f, "ignored", "Leave it out")}
                </button>
              </div>
              {/* Said once per card, quietly, because the difference between the
                  buttons is the whole point \u2014 and because BOTH acknowledgement
                  paths clear FlowGuide\u2019s copy of this text, which the
                  professional should know before pressing one. */}
              {showNote && <p className="mt-1.5 text-micro text-ink-3">{note}</p>}
            </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        {phase === "error" && (
          <button onClick={() => retry()} className="flex h-11 items-center rounded-[var(--radius-control)] bg-ink px-4 text-body font-medium text-white transition-colors hover:bg-ink/90 sm:h-10">
            Resume import
          </button>
        )}
        {phase !== "done" && (
          <button
            onClick={async () => { await discard(); onDiscarded(); }}
            // In needs_review this WAS the only way out. It still is whenever a
            // blocker exists that the per-unit controls cannot clear; when every
            // blocker is decidable above, it goes back to being secondary.
            className={`flex h-11 items-center rounded-[var(--radius-control)] px-4 text-body font-medium
                        transition-colors sm:h-10 ${needsReview && discardIsOnlyExit
              ? "bg-amber-700 text-white hover:bg-amber-800"
              : "border border-line text-ink-2 hover:bg-ground-3 hover:text-ink"}`}
          >
            Discard import
          </button>
        )}
      </div>
    </div>
  );
}
