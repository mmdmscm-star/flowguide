"use client";

// PUBLISH AND UNPUBLISH IN THE EDITOR'S BOTTOM BAR — ONE CLICK, ONE ACTION.
//
// What went wrong: Publish had no in-flight state, so each impatient click sent
// another request; and on success the bar re-rendered with Unpublish in the
// slot Publish had just occupied, under the pointer that was still clicking,
// before the editor navigated away. One of those clicks unpublished the
// Sendset that had just gone live.
//
// So:
//   * the first click enters a disabled "Publishing…" state at once, and a ref
//     — not only React state — refuses any second start before a re-render;
//   * a publish that succeeds stays a disabled "Published" until the editor has
//     left, so the opposite action never appears under the pointer;
//   * Unpublish asks first, shows "Unpublishing…", and after it succeeds holds
//     a disabled "Unpublished" briefly before Publish can be pressed again —
//     the same rule in the other direction.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export const UNPUBLISH_CONFIRM =
  "Unpublish this Sendset? Its shared link will stop working until you publish it again.";

/** How long a finished unpublish stays inert before Publish can be pressed. */
export const REARM_AFTER_UNPUBLISH_MS = 1500;

export type PublishPhase = "idle" | "publishing" | "published" | "unpublishing" | "unpublished";

/** What a publish attempt did: left the editor (success, or a detour to resolve
 *  photos), or stayed (refused, cancelled, failed) and may be tried again. */
export type PublishOutcome = "navigating" | "stayed";

export function usePublishTransitions({
  publish, unpublish, confirmUnpublish,
}: {
  publish: () => Promise<PublishOutcome>;
  /** Resolves true when the Sendset is now a draft. */
  unpublish: () => Promise<boolean>;
  confirmUnpublish: () => boolean;
}) {
  const [phase, setPhase] = useState<PublishPhase>("idle");
  const inFlight = useRef(false);
  const rearm = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (rearm.current) clearTimeout(rearm.current); }, []);

  const startPublish = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("publishing");
    let outcome: PublishOutcome = "stayed";
    try {
      outcome = await publish();
    } finally {
      if (outcome === "navigating") {
        // Stay inert until the editor unmounts. Nothing is released.
        setPhase("published");
      } else {
        inFlight.current = false;
        setPhase("idle");
      }
    }
  }, [publish]);

  const startUnpublish = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!confirmUnpublish()) {
      inFlight.current = false;
      return;
    }
    setPhase("unpublishing");
    let done = false;
    try {
      done = await unpublish();
    } finally {
      if (done) {
        setPhase("unpublished");
        rearm.current = setTimeout(() => {
          inFlight.current = false;
          setPhase("idle");
        }, REARM_AFTER_UNPUBLISH_MS);
      } else {
        inFlight.current = false;
        setPhase("idle");
      }
    }
  }, [unpublish, confirmUnpublish]);

  return { phase, startPublish, startUnpublish };
}

const BUSY_LABEL: Record<Exclude<PublishPhase, "idle">, string> = {
  publishing: "Publishing…",
  published: "Published",
  unpublishing: "Unpublishing…",
  unpublished: "Unpublished",
};

export function PublishControls({
  status, phase, copiedLink, onPublish, onUnpublish, onCopyLink,
}: {
  status: string;
  phase: PublishPhase;
  copiedLink: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
  onCopyLink: () => void;
}) {
  // A transition in flight, or just finished, owns the slot: one disabled,
  // announced control where the action was — never its opposite.
  if (phase !== "idle") {
    return (
      <Button variant={phase === "publishing" || phase === "published" ? "primary" : "danger"} size="md"
        disabled aria-busy={phase === "publishing" || phase === "unpublishing"} aria-live="polite">
        {BUSY_LABEL[phase]}
      </Button>
    );
  }
  if (status === "published") {
    return (
      <>
        <Button variant="secondary" size="md" onClick={onCopyLink}>
          {copiedLink ? "Copied!" : "Copy link"}
        </Button>
        <Button variant="danger" size="md" onClick={onUnpublish}>
          Unpublish
        </Button>
      </>
    );
  }
  if (status === "draft") {
    return (
      <Button variant="primary" size="md" onClick={onPublish}>
        Publish
      </Button>
    );
  }
  return null;
}
