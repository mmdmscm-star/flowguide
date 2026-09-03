"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteConfirmMessage, deletePacketRequest, type PacketIdentity } from "@/lib/delete-packet";

// DELETE THE FLOWGUIDE YOU ARE LOOKING AT.
//
// The friction this removes: you open a draft to decide whether you want it,
// decide you don't, and then have to go back to My FlowGuides and work out
// which of several untitled rows was the one you just had open. Deleting from
// here removes the guess entirely — the packet being deleted is the packet on
// screen.
//
// ONE component, mounted by BOTH editors, because a professional should be able
// to do this wherever they are rather than wherever the composition mode
// happens to have put them.
//
// DELIBERATELY QUIET. It is a text link at the very end of the editor's
// scrollable content, not a button in the fixed action bar where Publish lives.
// Reaching it takes a scroll past everything else, which is the right amount of
// friction for something irreversible — and it is never adjacent to the primary
// action it would be catastrophic to mis-click.
export default function DeletePacketAction({
  packetId,
  packet,
}: {
  packetId: string;
  packet: PacketIdentity;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onDelete() {
    if (busy) return;
    if (!confirm(deleteConfirmMessage(packet))) return;

    setBusy(true);
    setError("");
    try {
      await deletePacketRequest(packetId);
      // Only on success. A failed delete must leave the creator where they are,
      // still looking at the FlowGuide that still exists.
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete this Sendset.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-10 mb-8 border-t border-border pt-5">
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="text-sm font-medium text-red-600 hover:text-red-700 underline-offset-4 hover:underline
                   disabled:opacity-60 disabled:no-underline"
      >
        {busy ? "Deleting…" : "Delete this Sendset"}
      </button>
      <p className="mt-1 text-sm text-muted">
        Permanently removes this Sendset. This cannot be undone.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
