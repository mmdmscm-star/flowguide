"use client";
import { useCallback, useState } from "react";
import { BlockItemEditor } from "@/components/editor/block-item-editor";
import { LibraryList } from "@/components/library/library-list";
import { LibraryDetail } from "@/components/library/library-detail";
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
  // Reading is the default; editing is a deliberate second step from here.
  const [viewing, setViewing] = useState<LibrarySnapshot | null>(null);
  const [usedIn, setUsedIn] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<LibrarySnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // Choosing saved material to start a FlowGuide with. Offered INLINE here
  // rather than in a dialog: the list is already on screen, and putting a second
  // copy of it in a modal would be a worse version of what is already there.
  // Whether anything is saved at all. Distinct from "the current search found
  // nothing": an action that needs saved material must not vanish because a
  // search came back empty.
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  // ORGANIZATION FILTERS. Views of one Library, not separate collections: they
  // compose with the search box and with each other, and the chips are drawn
  // from the professional's own vocabulary rather than anything FlowGuide names.
  const [category, setCategory] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [vocab, setVocab] = useState<{ categories: string[]; labels: string[] }>({ categories: [], labels: [] });

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
      setViewing(null);
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
          {/* ONE SENTENCE. The independence rule — that inserting makes a copy —
              is explained where it is actually needed: at the moment of
              insertion, and again in the update and delete confirmations.
              Repeating it here made the Library open with a paragraph about
              semantics before saying what it is for. */}
          <p className="mt-2 text-sm text-muted">
            Save things you use often and add them to any FlowGuide.
          </p>
        </header>

        {/* Also here, not only in the empty state: writing an entry directly is a
            permanent way to use the Library, not a first-run bootstrap. */}
        {!editing && !creating && !viewing && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { setNotice(""); setImporting(true); }}
              className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium"
            >
              Import with AI
            </button>
            <button
              onClick={() => { setNotice(""); setCreating(true); }}
              className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                         text-foreground hover:border-accent hover:text-accent"
            >
              Add manually
            </button>
            {/* OFFERED ONLY WHEN THERE IS SOMETHING TO CHOOSE. On an empty
                Library this opened selection mode over an empty list — an
                action that looks live and leads nowhere. Hidden rather than
                disabled: a disabled control on a first-run screen is one more
                thing to wonder about, and Import with AI and Add manually are
                the useful actions in that state. Unknown (null) keeps it
                hidden, so a failed load never offers a dead end either. */}
            {hasAny === true && (
              <button
                onClick={() => { setNotice(""); setChosen([]); setSelecting(true); }}
                className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                           text-foreground hover:border-accent hover:text-accent"
              >
                Create a FlowGuide
              </button>
            )}
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

        {notice && <p className="mb-4 text-sm text-green-700">{notice}</p>}

        {conflict && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50/70 p-3">
            <p className="text-sm font-medium text-foreground">This item changed while you had it open</p>
            <p className="mt-1 text-sm text-amber-900">
              Someone — probably you, in another tab — saved “{conflict.title}” after you opened it.
              Your edits were not applied, so nothing was lost on either side.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => { setEditing(conflict); setConflict(null); }}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium"
              >
                Open the current version
              </button>
              <button
                onClick={() => setConflict(null)}
                className="px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-muted"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {viewing ? (
          <LibraryDetail
            item={viewing}
            usedIn={usedIn}
            busy={busy}
            onEdit={() => { setEditing(viewing); setViewing(null); }}
            onDelete={() => remove(viewing)}
            onClose={() => setViewing(null)}
          />
        ) : creating ? (
          <div className="rounded-xl border border-border bg-white p-4">
            <p className="mb-3 text-base font-semibold text-foreground">Add to Library</p>
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
              <p className="text-base font-semibold text-foreground">Editing</p>
              <button
                onClick={() => remove(editing)}
                disabled={busy}
                className="text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-60"
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
          <>
          {(vocab.categories.length > 0 || vocab.labels.length > 0 || favorite) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <FilterChip active={!category && labels.length === 0 && !favorite}
                onClick={() => { setCategory(""); setLabels([]); setFavorite(false); }}>All</FilterChip>
              <FilterChip active={favorite} onClick={() => setFavorite((f) => !f)}>★ Favorites</FilterChip>
              {vocab.categories.map((c) => (
                <FilterChip key={c} active={category === c}
                  onClick={() => setCategory((cur) => cur === c ? "" : c)}>{c}</FilterChip>
              ))}
              {vocab.labels.map((l) => (
                <FilterChip key={l} active={labels.includes(l)} subtle
                  onClick={() => setLabels((cur) => cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l])}>{l}</FilterChip>
              ))}
            </div>
          )}
          <LibraryList
            refreshKey={refreshKey}
            category={category}
            labels={labels}
            favorite={favorite}
            onVocabulary={setVocab}
            onLoaded={({ count, filtered }) => { if (!filtered) setHasAny(count > 0); }}
            selectable={selecting}
            selected={chosen}
            onToggle={(id) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
            onOpen={selecting ? undefined : (s) => {
              setNotice("");
              setViewing(s);
              // How many FlowGuides hold a copy — context for deleting. Fetched
              // here rather than shipped with every row in the list.
              setUsedIn(null);
              fetch(`/api/library/${s.id}`)
                .then((r) => r.json())
                .then((d) => setUsedIn(typeof d.usedIn === "number" ? d.usedIn : null))
                .catch(() => setUsedIn(null));
            }}
            emptyHint={
              // SAY IT ONCE. The previous version explained the same idea three
              // times — the page description, a paragraph on what a Library
              // holds, and a list of ways to fill it. A professional opening an
              // empty Library needs to know what goes in it and how to start,
              // not a short manual.
              <div className="rounded-xl border border-border bg-white p-4">
                <p className="text-base font-semibold text-foreground">Nothing saved yet</p>
                <p className="mt-1 text-sm text-muted">
                  Import information you already have, add something manually, or save
                  things while building a FlowGuide.
                </p>
              </div>
            }
          />
          </>
        )}
      </div>
    </div>
  );
}

/** One filter chip. Deliberately the same control for categories and labels —
 *  they filter the same list and behave the same way; only the emphasis
 *  differs, because a category is a place and a label is a facet. */
function FilterChip({
  active, subtle = false, onClick, children,
}: {
  active: boolean; subtle?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent text-white"
          : subtle
            ? "border-border bg-white text-muted hover:border-accent"
            : "border-border bg-white text-foreground hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}
