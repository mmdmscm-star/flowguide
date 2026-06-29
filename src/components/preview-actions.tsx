"use client";

import { useState } from "react";

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
        <p className="text-sm text-green-800 font-medium mb-2">
          Published — your client can now see this packet
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
