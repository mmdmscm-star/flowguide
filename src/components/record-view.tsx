"use client";

import { useEffect } from "react";

/** Slugs this document has already counted.
 *
 *  MODULE-LEVEL, SO ITS LIFETIME IS THE DOCUMENT'S. The contract is: at most
 *  one increment per slug per document lifecycle. Reloading or reopening the
 *  link counts again, which is right — those are page opens. An incidental
 *  remount does not, which is also right: React can mount a component twice for
 *  reasons that have nothing to do with a person opening anything, and in
 *  development StrictMode does so deliberately.
 *
 *  Nothing is stored anywhere. No cookie, no sessionStorage, no identifier —
 *  this is a Set in memory that dies with the tab. Chasing exact
 *  repeat-navigation semantics would mean giving a visitor something to be
 *  recognised by, which is the one thing this feature must not do. */
const counted = new Set<string>();

/** Tells the server a browser opened this Sendset. Renders nothing.
 *
 *  MOUNTED ONLY BY THE RECIPIENT PAGE, and only when it actually rendered a
 *  published Sendset for somebody who is not its owner. Preview, the print
 *  route, demos and the unavailable page never mount it, so they never count.
 *
 *  `keepalive` so the request survives a reader who taps a link immediately;
 *  failures are ignored, because a missed count is not worth a console error on
 *  a client's page. */
export function RecordView({ slug }: { slug: string }) {
  useEffect(() => {
    if (counted.has(slug)) return;
    counted.add(slug);
    fetch(`/api/p/${encodeURIComponent(slug)}/view`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [slug]);

  return null;
}
