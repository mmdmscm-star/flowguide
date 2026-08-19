"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LibraryList } from "@/components/library/library-list";
import { createFromLibrary } from "@/lib/create-from-library";

// "Use my Library" — choosing saved material and starting a FlowGuide from it.
//
// Presented as a dialog because it is reached from the New FlowGuide menu, where
// there is no list to select in. Inside the Library the SAME action is offered
// inline against the list already on screen; both call createFromLibrary, so
// only the presentation differs.
export function UseLibraryPicker({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    const { packetId, message } = await createFromLibrary(selected);
    if (!packetId) { setError(message ?? "Could not create it."); setBusy(false); return; }
    // Straight into the new FlowGuide, not back to a list. The next thing to do
    // is tailor it, and that happens here.
    router.push(`/edit/${packetId}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-white p-4"
           onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-semibold text-foreground">Use my Library</p>
        <p className="mt-1 mb-3 text-sm text-muted">
          Choose what to start this FlowGuide with. Each one is copied in — you can
          change anything afterwards without touching what is saved.
        </p>

        {error && <p className="mb-2 text-sm text-red-700">{error}</p>}

        <LibraryList
          selectable
          selected={selected}
          onToggle={(id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])}
          emptyHint={
            <p className="text-sm text-muted">
              Your Library is empty. Save something to it first, or start blank and
              build from scratch.
            </p>
          }
        />

        <div className="mt-4 flex items-center gap-2">
          <button onClick={create} disabled={busy || selected.length === 0}
            className="px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60">
            {busy ? "Creating…" : selected.length
              ? `Create FlowGuide with ${selected.length}`
              : "Create FlowGuide"}
          </button>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-sm font-medium text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}
