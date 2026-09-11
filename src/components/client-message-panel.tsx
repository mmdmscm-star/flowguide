"use client";

import { useState } from "react";
import { buildClientMessage, type ClientMessageInput } from "@/lib/client-message";
import { Button } from "./ui/button";
import { INPUT_SHELL } from "./ui/field";

// STANDALONE ON PURPOSE.
//
// v1 renders this in one place only - the share step, where the work ends. It
// takes plain values rather than a Sendset, so the dashboard or editor could
// adopt it later without rework IF someone actually returns to send a Sendset
// they published earlier. That is not yet known, so it is not yet built.
//
// EDITS ARE NOT PERSISTED. A stored message is a second copy of Sendset content
// that goes stale the moment the Sendset changes, which is the drift the
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
    /* THE PANEL IDIOM THE DASHBOARD AND LIBRARY WEAR: a quiet band naming the
       thing and saying what it is for, a hairline, then the work. The hint used
       to sit BELOW the field it describes and above the buttons, so the reading
       order was field, instruction, action — the instruction arriving after the
       moment it applied to. */
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-ground">
      <div className="border-b border-line bg-ground-2 px-4 py-3">
        <label htmlFor="client-message" className="block text-body font-medium text-ink">
          Message for your client
        </label>
        <p className="mt-0.5 text-meta text-ink-2">
          Edit anything you like before sending. The link always opens the latest version.
        </p>
      </div>

      <div className="p-4">
        <textarea
          id="client-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={rows}
          spellCheck
          className={`${INPUT_SHELL} resize-y leading-relaxed`}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="md" onClick={copyMessage}>
            {copied ? "Copied!" : "Copy message"}
          </Button>
          {/* The link alone is still one press away - it is a subset of the
              message, so it steps back rather than disappearing. */}
          <Button variant="ghost" size="md" onClick={onCopyLink}>
            {linkCopied ? "Link copied!" : "Copy link only"}
          </Button>
        </div>

        {failed && (
          <p role="alert" className="mt-2 text-meta text-red-700">
            Couldn&apos;t reach the clipboard — select the message above and copy it.
          </p>
        )}
      </div>
    </div>
  );
}
