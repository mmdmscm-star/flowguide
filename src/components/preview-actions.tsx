"use client";

import { useState } from "react";
import OwnershipResolution, { type OwnershipState } from "./OwnershipResolution";
import ClientMessagePanel from "./client-message-panel";
import EmailVersionPanel from "./email-version-panel";

type Props = {
  packetId: string;
  slug: string;
  initialStatus: string;
  /** For the client message. All optional - it degrades a line at a time. */
  title?: string | null;
  clientName?: string | null;
  professionalName?: string | null;
};

export function PreviewActions({ packetId, slug, initialStatus, title, clientName, professionalName }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Set only by a publish that was actually blocked on ownership. The panel is
  // driven by the 409 rather than mounted speculatively, so a professional whose
  // packet is fine never sees a photo-checking screen at all.
  const [ownership, setOwnership] = useState<OwnershipState | null>(null);
  // The email version is fetched on demand and never stored: a saved copy is a
  // second source of truth that goes stale when the packet changes.
  const [emailDoc, setEmailDoc] = useState<{ html: string; text: string } | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [resolved, setResolved] = useState(false);

  // The 409 carries the findings, but not what may be DONE about each one. That
  // is derived by the ownership route, which is the single place that decides
  // what FlowGuide is willing to offer — so the panel is loaded from there
  // rather than from a second, thinner copy of the same facts.
  async function loadOwnership() {
    try {
      const res = await fetch(`/api/packets/${packetId}/ownership`);
      if (!res.ok) return;   // includes 503: an unavailable check has no panel to draw
      setOwnership(await res.json());
    } catch {
      // Leaving the panel unmounted falls back to the 409's own sentence, which
      // already says what is wrong even when it cannot say what to press.
    }
  }

  async function publishPacket(skipProfileCheck: boolean) {
    setError("");
    setPublishing(true);
    try {
      const res = await fetch(`/api/packets/${packetId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish", skipProfileCheck }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 422 && (data.error === "no_profile" || data.error === "no_contact")) {
          const proceed = confirm(
            "This packet does not include professional contact information. You can still publish it, but the contact footer will not appear."
          );
          if (proceed) {
            await publishPacket(true);
          }
          return;
        }
        if (res.status === 409 && data.error === "ownership_unresolved") {
          setResolved(false);
          setError(data.message || "Some photos need checking before you can publish.");
          await loadOwnership();
          return;
        }
        // The check did not run. Not the professional's fault and not their
        // problem to fix, so no panel and no findings — just the retry.
        if (res.status === 503 && data.error === "ownership_unavailable") {
          setResolved(false);
          setOwnership(null);
          setError(data.message || "Photo checks are temporarily unavailable. Try again in a moment.");
          return;
        }
        setError(data.message || data.error || "Could not publish");
        return;
      }
      setStatus("published");
    } finally {
      setPublishing(false);
    }
  }

  // ONE definition, used by the link copy and by the message, so the two can
  // never disagree about where the packet lives. Empty during SSR; the panel
  // only renders after publish, which is client-side.
  const shareUrl = typeof window === "undefined" ? `/p/${slug}` : `${window.location.origin}/p/${slug}`;

  async function createEmailVersion() {
    setEmailBusy(true);
    setEmailError("");
    try {
      const res = await fetch(`/api/packets/${packetId}/email`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.html) {
        setEmailError(data?.message || "Could not build the email version.");
        return;
      }
      setEmailDoc({ html: data.html, text: data.text ?? "" });
    } catch {
      setEmailError("Could not build the email version. Check your connection and try again.");
    } finally {
      setEmailBusy(false);
    }
  }

  // AWAITED AND CAUGHT. This used to fire writeText() without awaiting it and
  // set "Copied!" unconditionally, so an insecure context, a denied permission
  // or a browser that refuses without a user gesture all reported success the
  // professional did not have — observed live, in a browser that denies
  // clipboard writes. The failure now says so, in the same shape the client
  // message and email panels already use.
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  if (status === "published") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-5 py-3 text-center">
        <p className="text-sm text-green-800 font-medium mb-1">
          Published — your client can now see this packet
        </p>
        <p className="text-xs text-green-700 mb-2">
          Anyone with this link can open the packet — no sign-in required. Share
          it only with people you want to see it.
        </p>
        {/* The message CONTAINS the link, so it takes precedence and
            "Copy link only" becomes the secondary action beside it. The link
            behaviour itself is unchanged. */}
        <ClientMessagePanel
          title={title}
          clientName={clientName}
          professionalName={professionalName}
          url={shareUrl}
          onCopyLink={copyLink}
          linkCopied={copied}
        />
        {/* A second way to deliver the SAME packet, for a client who wants the
            content in the email body rather than behind a link. */}
        {emailDoc ? (
          <EmailVersionPanel html={emailDoc.html} text={emailDoc.text} onClose={() => setEmailDoc(null)} />
        ) : (
          <div className="mt-2">
            <button
              onClick={createEmailVersion}
              disabled={emailBusy}
              className="text-sm text-green-700 hover:text-green-900 underline disabled:opacity-60"
            >
              {emailBusy ? "Building…" : "Create email version"}
            </button>
            {emailError && <p className="mt-1 text-sm text-red-600">{emailError}</p>}
          </div>
        )}

        {copyFailed && (
          <p className="mt-1 text-sm text-red-600">
            Your browser blocked the copy — the link is {shareUrl}
          </p>
        )}

        {/* A THIRD way to deliver the same packet, for the professional who
            hands over paper. Opened in a new tab rather than navigated to, so
            the publish confirmation this bar is part of stays put. */}
        <div className="mt-2">
          <a
            href={`/p/${slug}/print`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-green-700 hover:text-green-900 underline"
          >
            Print / Save as PDF
          </a>
        </div>

        <div className="mt-3">
          <a
            href={`/edit/${packetId}`}
            className="text-xs text-green-700 hover:text-green-900 underline"
          >
            ← Back to editor
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 text-center">
      <p className="text-sm text-amber-800 font-medium mb-2">
        Preview — this is how your client will see it
      </p>

      {/* The block and the way out are the same screen. Sending someone
          elsewhere to fix this and back again to retry is how a safety state
          turns into a dead end. */}
      {ownership && (
        <div className="mx-auto mb-3 max-w-2xl">
          <OwnershipResolution
            packetId={packetId}
            state={ownership}
            onState={(next) => {
              setOwnership(next);
              if (next.blockingCount > 0) {
                setError("");
                setResolved(false);   // an undo puts the block back
              }
            }}
            // NOT unmounted. The panel still holds the undo for anything just
            // kept, and taking that away the instant the last finding clears
            // would make every Keep final at exactly the moment a misclick gets
            // noticed. It renders itself away when there is nothing left to say.
            onResolved={() => {
              setError("");
              setResolved(true);
            }}
          />
        </div>
      )}

      {resolved && (
        <p className="text-xs text-green-700 mb-2">
          Photos sorted — you can publish now.
        </p>
      )}
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => publishPacket(false)}
          disabled={publishing}
          className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium transition-colors disabled:opacity-60"
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
        <a
          href={`/edit/${packetId}`}
          className="text-xs text-amber-600 hover:text-amber-800 underline"
        >
          ← Back to editor
        </a>
      </div>
    </div>
  );
}
