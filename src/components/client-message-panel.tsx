"use client";

import { useState } from "react";
import { buildClientMessage, type ClientMessageInput } from "@/lib/client-message";

// STANDALONE ON PURPOSE.
//
// v1 renders this in one place only - the post-publish bar, where the work
// ends. It takes plain values rather than a packet, so the dashboard or editor
// could adopt it later without rework IF someone actually returns to send a
// packet they published earlier. That is not yet known, so it is not yet built.
//
// EDITS ARE NOT PERSISTED. A stored message is a second copy of packet content
// that goes stale the moment the packet changes, which is the drift the
// one-packet architecture exists to prevent. Regenerating costs nothing, and a
// professional asking for their edit to be remembered is a real signal worth
// acting on later rather than guessing at now.
export default function ClientMessagePanel(props: ClientMessageInput & { onCopyLink: () => void; linkCopied: boolean }) {
  const { onCopyLink, linkCopied, ...input } = props;
  const [message, setMessage] = useState(() => buildClientMessage(input));
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  // SIZED FROM THE MESSAGE, not guessed and not measured.
  //
  // A fixed row count was wrong twice - at nine and eleven rows the sign-off
  // scrolled out of sight, so a professional could not see their own name in a
  // box they are about to copy. Measuring scrollHeight was worse: it reported a
  // nonsense height in this layout. Counting lines and allowing for the one
  // sentence that wraps is deterministic, costs no layout work, and grows if an
  // edit adds lines. Capped so a long paste cannot take over the screen.
  const rows = Math.min(16, Math.max(9, message.split("\n").length + 3));

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard can refuse - an insecure context, a denied permission.
      // Saying so beats a button that silently does nothing, and the text is
      // already selectable in the box above.
      setFailed(true);
    }
  }

  return (
    <div className="mx-auto mt-3 max-w-xl text-left">
      <label htmlFor="client-message" className="block text-xs font-medium text-green-800 mb-1">
        Message for your client
      </label>
      <textarea
        id="client-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={rows}
        spellCheck
        className="w-full rounded-lg border border-green-300 bg-white p-3 text-sm text-foreground
                   leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
      />
      <p className="mt-1 text-xs text-muted">
        Edit anything you like before sending. The link always opens the latest version.
      </p>

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={copyMessage}
          className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium transition-colors"
        >
          {copied ? "Copied!" : "Copy message"}
        </button>
        {/* The link alone is still one press away - it is a subset of the
            message, so it steps back rather than disappearing. */}
        <button
          onClick={onCopyLink}
          className="text-xs text-green-700 hover:text-green-900 underline"
        >
          {linkCopied ? "Link copied!" : "Copy link only"}
        </button>
      </div>
      {failed && (
        <p className="mt-1 text-xs text-red-600">
          Couldn&apos;t reach the clipboard — select the message above and copy it.
        </p>
      )}
    </div>
  );
}
