"use client";
import { useCallback, useState } from "react";
import { BlockItemEditor } from "@/components/editor/block-item-editor";
import { LibraryList } from "@/components/library/library-list";
import { CreatorNav } from "@/components/nav/creator-nav";
import { ImportWithAI } from "@/components/library/import-with-ai";
import { createFromLibrary } from "@/lib/create-from-library";
import { useRouter } from "next/navigation";
import { snapshotToItem, type LibrarySnapshot } from "@/lib/library-adapter";
import type { Item } from "@/lib/types";
import type { ItemContentPayload } from "@/lib/item-content";
import type { MutationResult } from "@/lib/serial-mutation";

// The Library workspace. Find → open → edit → save.
//
// EDITING REUSES BlockItemEditor. Not a copy of it, and not a second editor for
// the same eight fields — a Library item and a packet item are the same kind of
// thing, and editing them should feel identical because it IS identical.
//
// Saving carries the revision the editor was opened with. If the entry changed
// underneath (another tab, another device) the write is refused and the current
// version is shown, rather than one edit silently erasing the other.
// A Library entry written here rather than promoted from a packet. Same eight
// fields, same editor, same row — populating the Library has never required a
// FlowGuide to exist, and the empty state should not imply that it does.
const BLANK: Item = {
  id: "new", title: "", address: "", description: "", notes: "",
  photos: [], details: [], links: [], contacts: [],
};

export default function LibraryWorkspace() {
  const [editing, setEditing] = useState<LibrarySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<LibrarySnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // Choosing saved material to start a FlowGuide with. Offered INLINE here
  // rather than in a dialog: the list is already on screen, and putting a second
  // copy of it in a modal would be a worse version of what is already there.
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const router = useRouter();

  const save = useCallback(async (payload: ItemContentPayload): Promise<MutationResult> => {
    if (!editing) return "failed";
    setBusy(true);
    setNotice("");
    setConflict(null);
    try {
      const res = await fetch(`/api/library/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, expectedRevision: editing.revision }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === "revision_conflict") {
        // Not an error the professional caused. Show what it is NOW and let them
        // decide again, rather than discarding either version.
        setConflict(data.current as LibrarySnapshot);
        return "rejected";
      }
      if (!res.ok) { setNotice(data.message || data.error || "Could not save."); return "failed"; }

      setEditing(null);
      setRefreshKey((k) => k + 1);
      setNotice("Saved to your Library.");
      return "ok";
    } catch {
      setNotice("Could not save. Check your connection.");
      return "failed";
    } finally {
      setBusy(false);
    }
  }, [editing]);

  const create = useCallback(async (payload: ItemContentPayload): Promise<MutationResult> => {
    // The retry lives in an INNER function so the duplicate path can call itself
    // without the callback depending on its own identity.
    async function attempt(force: boolean): Promise<MutationResult> {
      try {
        const res = await fetch("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: payload, ...(force ? { force: true } : {}) }),
        });
        const data = await res.json();

        // Same rule as saving from a packet: warn, never merge. Two genuinely
        // different things can share a name.
        if (res.status === 409 && data.error === "duplicate_candidate") {
          if (confirm(`${data.message}\n\nSave this as a separate Library item anyway?`)) {
            return await attempt(true);
          }
          return "rejected";
        }
        if (!res.ok) { setNotice(data.message || data.error || "Could not save."); return "failed"; }

        setCreating(false);
        setRefreshKey((k) => k + 1);
        setNotice("Saved to your Library.");
        return "ok";
      } catch {
        setNotice("Could not save. Check your connection.");
        return "failed";
      }
    }

    setBusy(true);
    setNotice("");
    try {
      return await attempt(false);
    } finally {
      setBusy(false);
    }
  }, []);

  async function remove(s: LibrarySnapshot) {
    // Named consequence, not a generic "are you sure": what makes this safe is
    // precisely that packets are unaffected, and saying so is what lets the
    // professional delete without hesitating.
    if (!confirm(
      `Delete "${s.title || "Untitled"}" from your Library?\n\n` +
      `Any FlowGuide that already uses it is NOT affected — each holds its own copy.`
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/library/${s.id}`, { method: "DELETE" });
      if (!res.ok) { setNotice("Could not delete."); return; }
      setEditing(null);
      setRefreshKey((k) => k + 1);
      setNotice("Removed from your Library.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-white border-b border-border">
        <div className="max-w-lg mx-auto px-5 py-3 flex items-center gap-3">
          <CreatorNav current="library" />
        </div>
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        <header className="pt-6 pb-4">
          <h1 className="text-2xl font-bold text-foreground">Your Library</h1>
          <p className="mt-2 text-xs text-muted">
            Items you can reuse in any FlowGuide. Inserting one makes a copy — editing that
            copy never changes what is saved here, and editing here never changes a
            FlowGuide you have already sent.
          </p>
        </header>

        {/* Also here, not only in the empty state: writing an entry directly is a
            permanent way to use the Library, not a first-run bootstrap. */}
        {!editing && !creating && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { setNotice(""); setImporting(true); }}
              className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium"
            >
              Import with AI
            </button>
            <button
              onClick={() => { setNotice(""); setCreating(true); }}
              className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                         text-foreground hover:border-accent hover:text-accent"
            >
              + Create an item
            </button>
            <button
              onClick={() => { setNotice(""); setChosen([]); setSelecting(true); }}
              className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                         text-foreground hover:border-accent hover:text-accent"
            >
              Create a FlowGuide
            </button>
          </div>
        )}

        {selecting && (
          <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <p className="text-sm font-medium text-foreground">
              Choose what to start a FlowGuide with
            </p>
            <p className="mt-1 text-sm text-muted">
              Each one is copied in. Changing it there never changes what is saved here.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  setBusy(true); setNotice("");
                  const { packetId, message } = await createFromLibrary(chosen);
                  if (!packetId) { setNotice(message ?? "Could not create it."); setBusy(false); return; }
                  router.push(`/edit/${packetId}`);
                }}
                disabled={busy || chosen.length === 0}
                className="px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Creating…" : chosen.length
                  ? `Create FlowGuide with ${chosen.length}`
                  : "Create FlowGuide"}
              </button>
              <button
                onClick={() => { setSelecting(false); setChosen([]); }}
                disabled={busy}
                className="ml-auto text-sm font-medium text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {importing && (
          <ImportWithAI
            onClose={() => setImporting(false)}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        )}

        {notice && <p className="mb-4 text-xs text-green-700">{notice}</p>}

        {conflict && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/70 p-3">
            <p className="text-sm font-medium text-foreground">This item changed while you had it open</p>
            <p className="mt-1 text-xs text-amber-900">
              Someone — probably you, in another tab — saved “{conflict.title}” after you opened it.
              Your edits were not applied, so nothing was lost on either side.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => { setEditing(conflict); setConflict(null); }}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium"
              >
                Open the current version
              </button>
              <button
                onClick={() => setConflict(null)}
                className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {creating ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <p className="mb-3 text-sm font-medium text-foreground">New Library item</p>
            <BlockItemEditor
              item={BLANK}
              busy={busy}
              onSave={(payload) => create(payload)}
              onClose={() => setCreating(false)}
            />
          </div>
        ) : editing ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Editing a Library item</p>
              <button
                onClick={() => remove(editing)}
                disabled={busy}
                className="text-xs font-medium text-red-700 hover:text-red-800 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
            <BlockItemEditor
              item={snapshotToItem(editing)}
              busy={busy}
              onSave={(payload) => save(payload)}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <LibraryList
            refreshKey={refreshKey}
            selectable={selecting}
            selected={chosen}
            onToggle={(id) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
            onOpen={selecting ? undefined : (s) => { setNotice(""); setEditing(s); }}
            emptyHint={
              // AN EMPTY LIBRARY IS THE FIRST THING A NEW PROFESSIONAL SEES, and
              // it used to be one grey sentence. It has to say what this is for
              // and name both ways to fill it — including the one that needs no
              // FlowGuide at all.
              <div className="rounded-xl border border-border bg-white p-4">
                <p className="text-sm font-medium text-foreground">Nothing saved yet</p>
                <p className="mt-1 text-xs text-muted">
                  Your Library holds the things you use again — a community, a service, a
                  person — so you are not rebuilding them for every client. Each one is
                  private to you, and inserting one into a FlowGuide makes a copy.
                </p>
                <p className="mt-3 text-xs font-medium text-foreground">Three ways to fill it</p>
                <ul className="mt-1 space-y-1 text-xs text-muted">
                  <li>
                    <span className="text-foreground">Save from a FlowGuide.</span> Open any
                    FlowGuide — draft or published, it makes no difference — and use{" "}
                    <span className="text-foreground">Save to Library</span> on an item, or{" "}
                    <span className="text-foreground">Save items</span> to pick several at once.
                  </li>
                  <li>
                    <span className="text-foreground">Import with AI.</span> Paste what you already
                    have and review what it finds — no FlowGuide required.
                  </li>
                  <li>
                    <span className="text-foreground">Write one here.</span> Also no FlowGuide required.
                  </li>
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => { setNotice(""); setImporting(true); }}
                    className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium"
                  >
                    Import with AI
                  </button>
                  <button
                    onClick={() => { setNotice(""); setCreating(true); }}
                    className="px-3 py-1.5 rounded-lg border border-border bg-white text-xs font-medium text-foreground hover:border-accent"
                  >
                    Create an item
                  </button>
                </div>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
