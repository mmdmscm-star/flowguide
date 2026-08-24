"use client";

import { useRef, useState } from "react";

// COPY A FORMATTED FLOWGUIDE, for a client who wants the content in the email
// body rather than behind a link.
//
// THREE TIERS, because copying rich HTML is the part that actually breaks:
//
//   1. navigator.clipboard.write() with a text/html AND a text/plain flavour.
//      The modern path; needs clipboard-write permission and a focused
//      document, and Firefox's support has been uneven.
//   2. a real DOM selection + execCommand("copy"). No permission needed - the
//      browser serialises the selection - and it works where (1) does not.
//   3. show the rendered version and say plainly that the copy was blocked.
//
// Tier 3 is the important one. Quietly copying plain text when rich copy fails
// would defeat the entire point of the feature while looking like success.
export default function EmailVersionPanel({
  html,
  text,
  onClose,
}: {
  html: string;
  text: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const stage = useRef<HTMLDivElement>(null);

  async function copy() {
    // 1. the modern API, with both flavours so a plain-text composer still
    //    receives something readable.
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        setState("copied");
        setTimeout(() => setState((s) => (s === "copied" ? "idle" : s)), 2500);
        return;
      }
    } catch {
      // fall through
    }

    // 2. selection + execCommand. The node is rendered off-screen rather than
    //    display:none - a hidden node has no selectable layout, so the copy
    //    would silently produce nothing.
    try {
      const el = stage.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        const ok = document.execCommand("copy");
        sel?.removeAllRanges();
        if (ok) {
          setState("copied");
          setTimeout(() => setState((s) => (s === "copied" ? "idle" : s)), 2500);
          return;
        }
      }
    } catch {
      // fall through
    }

    // 3. say so.
    setState("manual");
  }

  return (
    <div className="mx-auto mt-3 max-w-xl text-left">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-green-800">Email version</p>
        <button onClick={onClose} className="text-sm text-green-700 hover:text-green-900 underline">
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        For a client who would rather read it in the email itself. Copy this, then paste
        into Gmail, Outlook or Apple Mail. The live link is included so they can still open
        the interactive version.
      </p>

      {/* The rendered version, shown at the width an email client will use.
          This is also the node tier 2 selects, so what is copied is exactly
          what is shown. */}
      <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-green-300 bg-white p-2">
        <div ref={stage} dangerouslySetInnerHTML={{ __html: html }} />
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={copy}
          className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium"
        >
          {state === "copied" ? "Copied!" : "Copy formatted email"}
        </button>
        {state === "manual" && (
          <span className="text-sm text-red-700">
            Your browser blocked the copy — select the version above and copy it by hand.
          </span>
        )}
      </div>
    </div>
  );
}
