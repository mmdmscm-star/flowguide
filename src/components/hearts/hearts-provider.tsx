"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ACTION_HEADER, ACTION_OUTCOME, type MyAction, type MyActions } from "@/lib/item-actions";

/** THE BROWSER'S OWN HEARTS, on one Sendset.
 *
 *  MOUNTED ONLY BY THE RECIPIENT PAGE, and only when the Sendset accepts hearts
 *  and the reader is not its owner. Preview, print and email never mount it, so
 *  ItemHeart renders nothing there — a component that is absent cannot leak a
 *  heart onto a surface that should not have one.
 *
 *  THE PAGE'S HTML IS THE SAME FOR EVERYONE. The hearts are fetched after mount
 *  rather than rendered into the document, so nothing about one reader can ever
 *  be served to another by a cache. The cost is a moment before a returning
 *  reader's hearts appear, which is the right side of that trade.
 *
 *  NOTHING ABOUT ANYBODY ELSE. There is no count here, no "3 people liked
 *  this", no activity. Whoever else holds this link, what they hearted is not
 *  this reader's business. */
type Status = "loading" | "ready";

interface HeartsValue {
  slug: string;
  ready: boolean;
  isHearted: (itemId: string) => boolean;
  isPending: (itemId: string) => boolean;
  toggle: (itemId: string) => void;
  signatureName: string | null;
  /** Hearts whose item the Sendset no longer carries: still theirs, still
   *  withdrawable, never silently dropped. */
  departed: MyAction[];
  count: number;
  error: string | null;
  forget: () => void;
  /** Open when a first heart is waiting on a signature. */
  askingFor: string | null;
  confirmSignature: (name: string, contact: string) => Promise<string | null>;
  cancelSignature: () => void;
}

const HeartsContext = createContext<HeartsValue | null>(null);
export const useHearts = () => useContext(HeartsContext);

export function HeartsProvider({
  slug, marker, children,
}: {
  slug: string;
  /** The publication marker, exactly as the server rendered it: an opaque
   *  string, handed back untouched. Never parsed here. */
  marker: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [actions, setActions] = useState<MyAction[]>([]);
  const [signatureName, setSignatureName] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The item a first heart is waiting on a signature for. It shows as hearted
  // while the sheet is open — and goes back if the person cancels.
  const [askingFor, setAskingFor] = useState<string | null>(null);

  const endpoint = `/p/${encodeURIComponent(slug)}/actions`;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(endpoint, { headers: { Accept: "application/json" } });
        const body = (await res.json().catch(() => null)) as MyActions | null;
        if (!live || !body) { if (live) setStatus("ready"); return; }
        setActions(body.actions ?? []);
        setSignatureName(body.signature?.name ?? null);
      } catch { /* a reader who cannot reach us simply has no hearts yet */ }
      if (live) setStatus("ready");
    })();
    return () => { live = false; };
  }, [endpoint]);

  const mark = useCallback((itemId: string, on: boolean) => {
    setPending((p) => {
      const next = new Set(p);
      if (on) next.add(itemId); else next.delete(itemId);
      return next;
    });
  }, []);

  /** ONE TARGET, ONE CALL — the client has no way to say "these are all of
   *  mine", so it cannot drop a heart by leaving it out. */
  const send = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: "1" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.message ?? ACTION_OUTCOME.failed));
    return body;
  }, [endpoint]);

  const toggle = useCallback((itemId: string) => {
    if (pending.has(itemId)) return;
    setError(null);
    const on = actions.some((a) => a.itemId === itemId);

    if (!on && signatureName === null && status === "ready") {
      // THE FIRST HEART. It appears at once, and the signature sheet opens; if
      // the person cancels, it goes back and NOTHING is written.
      setAskingFor(itemId);
      return;
    }

    mark(itemId, true);
    (async () => {
      try {
        if (on) {
          await send({ op: "clear", itemId, action: "like" });
          setActions((list) => list.filter((a) => a.itemId !== itemId));
        } else {
          const body = await send({ op: "set", itemId, action: "like", marker, name: signatureName ?? "" });
          setActions((list) => [...list.filter((a) => a.itemId !== itemId), body.action as MyAction]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : ACTION_OUTCOME.failed);
      } finally {
        mark(itemId, false);
      }
    })();
  }, [actions, mark, marker, pending, send, signatureName, status]);

  const confirmSignature = useCallback(async (name: string, contact: string) => {
    const itemId = askingFor;
    if (!itemId) return null;
    mark(itemId, true);
    try {
      const body = await send({ op: "set", itemId, action: "like", marker, name, contact });
      setActions((list) => [...list.filter((a) => a.itemId !== itemId), body.action as MyAction]);
      setSignatureName((body.signature as { name?: string } | undefined)?.name ?? name);
      setAskingFor(null);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : ACTION_OUTCOME.failed;
    } finally {
      mark(itemId, false);
    }
  }, [askingFor, mark, marker, send]);

  const cancelSignature = useCallback(() => setAskingFor(null), []);

  const forget = useCallback(() => {
    (async () => {
      try {
        await send({ op: "forget" });
        // The submission this browser held is untouched; this browser simply no
        // longer holds it.
        setActions([]);
        setSignatureName(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : ACTION_OUTCOME.failed);
      }
    })();
  }, [send]);

  const value = useMemo<HeartsValue>(() => ({
    slug,
    ready: status === "ready",
    isHearted: (itemId) => actions.some((a) => a.itemId === itemId) || askingFor === itemId,
    isPending: (itemId) => pending.has(itemId),
    toggle,
    signatureName,
    departed: actions.filter((a) => !a.inCurrent),
    count: actions.length,
    error,
    forget,
    askingFor,
    confirmSignature,
    cancelSignature,
  }), [actions, askingFor, cancelSignature, confirmSignature, error, forget, pending, signatureName, slug, status, toggle]);

  return <HeartsContext.Provider value={value}>{children}</HeartsContext.Provider>;
}
