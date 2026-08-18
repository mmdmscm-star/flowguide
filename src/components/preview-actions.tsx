"use client";

import { useState } from "react";
import OwnershipResolution, { type OwnershipState } from "./OwnershipResolution";

type Props = {
  packetId: string;
  slug: string;
  initialStatus: string;
};

export function PreviewActions({ packetId, slug, initialStatus }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Set only by a publish that was actually blocked on ownership. The panel is
  // driven by the 409 rather than mounted speculatively, so a professional whose
  // packet is fine never sees a photo-checking screen at all.
  const [ownership, setOwnership] = useState<OwnershipState | null>(null);
  const [resolved, setResolved] = useState(false);

  // The 409 carries the findings, but not what may be DONE about each one. That
  // is derived by the ownership route, which is the single place that decides
  // what FlowGuide is willing to offer — so the panel is loaded from there
  // rather than from a second, thinner copy of the same facts.
  async function loadOwnership() {
    try {
      const res = await fetch(`/api/packets/${packetId}/ownership`);
      if (!res.ok) return;
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
        setError(data.message || data.error || "Could not publish");
        return;
      }
      setStatus("published");
    } finally {
      setPublishing(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/p/${slug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={copyLink}
            className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium transition-colors"
          >
            {copied ? "Copied!" : "Copy Link"}
          </button>
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
              if (next.blockingCount > 0) setError("");
            }}
            onResolved={() => {
              setOwnership(null);
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
