"use client";

// "SAVED · CHANGES NOT PUBLISHED" — AND ONLY WHEN IT IS TRUE.
//
// Editing a published Sendset changes the working draft; recipients keep the
// frozen publication until Republish. Autosave still saves every change, so
// "Saved" stays true; what the professional also needs is whether the saved
// draft is what their client sees. The server answers that exactly
// (lib/publication-state). This asks again after every save settles, and
// whenever another surface says it saved something (the style picker, the
// profile form).
//
// While an answer is outstanding, or when the server cannot tell, nothing is
// claimed either way: the bar says "Saved" and the Sendset stays "Published",
// both of which are true.
import { useCallback, useEffect, useRef, useState } from "react";

export type PublicationView = "unknown" | "current" | "changed";

export const DRAFT_SAVED_EVENT = "sendset:draft-saved";
/** How long after a save settles before asking — several quick saves ask once. */
export const RECHECK_DELAY_MS = 700;

/** Tell open surfaces that something a publication is built from was saved. */
export function notifyDraftSaved(packetId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DRAFT_SAVED_EVENT, { detail: { packetId } }));
}

/** The bar's save sentence. */
export function saveLabel(saveStatus: "saved" | "saving" | "error", status: string, view: PublicationView): string {
  if (saveStatus === "saving") return "Saving…";
  if (saveStatus === "error") return "Save failed";
  return status === "published" && view === "changed" ? "Saved · Changes not published" : "Saved";
}

export function usePublicationState(packetId: string, status: string, savedSignal: unknown) {
  // The answer is kept with the status it was asked about, so a Sendset that is
  // no longer published never shows a stale "Changes not published".
  const [answer, setAnswer] = useState<{ status: string; view: PublicationView }>({ status: "", view: "unknown" });
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only refs and a timer are touched when scheduling: the state changes in the
  // timer's callback, after the request answers.
  const schedule = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    const mine = ++seq.current;   // anything already in flight is now stale
    timer.current = setTimeout(async () => {
      let view: PublicationView = "unknown";
      try {
        const res = await fetch(`/api/packets/${packetId}/publication-state`, { cache: "no-store" });
        const data = res.ok ? await res.json() : null;
        if (data?.published === true) {
          view = data.publication === "changed" ? "changed"
            : data.publication === "current" || data.publication === "missing" ? "current" : "unknown";
        }
      } catch { /* cannot tell: claim nothing */ }
      if (mine === seq.current) setAnswer({ status, view });
    }, delay);
  }, [packetId, status]);

  const refresh = useCallback((delay = RECHECK_DELAY_MS) => schedule(delay), [schedule]);

  useEffect(() => {
    if (status === "published") schedule(0);
    else seq.current++;
  }, [status, schedule]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (status === "published") schedule(RECHECK_DELAY_MS);
  }, [savedSignal, status, schedule]);

  useEffect(() => {
    const onSaved = (e: Event) => {
      const id = (e as CustomEvent<{ packetId?: string }>).detail?.packetId;
      if (status === "published" && (!id || id === packetId)) schedule(RECHECK_DELAY_MS);
    };
    window.addEventListener(DRAFT_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(DRAFT_SAVED_EVENT, onSaved);
  }, [packetId, status, schedule]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const view: PublicationView = status === "published" && answer.status === "published" ? answer.view : "unknown";
  return { view, refresh };
}
