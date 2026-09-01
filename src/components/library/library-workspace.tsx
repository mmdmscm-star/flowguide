"use client";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { FlowGuideTray, type TrayEntry } from "@/components/library/flowguide-tray";
import {
  applyCompose, libDragId, parseComposeId, planCompose,
} from "@/lib/compose-drag";
import { useCallback, useState } from "react";
import { BlockItemEditor, type LibraryOrganization } from "@/components/editor/block-item-editor";
import { LibraryList } from "@/components/library/library-list";
import { LibraryDetail } from "@/components/library/library-detail";
import { LibraryFilters, EMPTY_FILTERS, type LibraryFilterState } from "@/components/library/library-filters";
import { LibraryStructureView } from "@/components/library/library-structure-view";
import { LibrarySearch } from "@/components/library/library-search";
import { showStructure, canReorder, type GroupRow, type SectionRow } from "@/lib/library-structure";
import type { LibraryVocabulary } from "@/lib/library-organization";
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

/** ONE CONTROL, TWO GESTURES.
 *
 *  Press it and the item goes to the end of the FlowGuide; drag it and you
 *  choose exactly where. Separating those into two affordances would put a grip
 *  and an Add button on every row and make the professional decide which one
 *  they meant — when they mean the same thing, differing only in how precise
 *  they are being.
 *
 *  It says ADD, not a grip's dots, because dots now mean "reorder my Library"
 *  three feet to the left and this does not touch the Library at all. */
function AddToFlowGuide({
  item, added, onAdd,
}: {
  item: LibrarySnapshot; added: boolean; onAdd: () => void;
}) {
  const name = item.title || "this item";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: libDragId(item.id),
    disabled: added,
    data: { title: item.title ?? "" },
  });
  if (added) {
    return (
      <span className="flex-none rounded px-1.5 py-1 text-[11px] font-medium text-accent"
        aria-label={`${name} is already in this FlowGuide`}>
        ✓ Added
      </span>
    );
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onAdd}
      aria-label={`Add ${name} to this FlowGuide`}
      {...attributes}
      {...listeners}
      className={`flex-none touch-none cursor-grab active:cursor-grabbing rounded border border-border
                  px-1.5 py-1 text-[11px] font-medium text-muted hover:border-accent hover:text-accent
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent
                  ${isDragging ? "opacity-40" : ""}`}
    >
      Add
    </button>
  );
}

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
  // The search term lives HERE, not in the list: typing is what switches the
  // Library from its structure to a flat result set, so the box has to outlive
  // that switch.
  const [q, setQ] = useState("");
  // ORGANIZATION FILTERS. Views of one Library, not separate collections: they
  // compose with the search box and with each other, and the chips are drawn
  // from the professional's own vocabulary rather than anything FlowGuide names.
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_FILTERS);
  const [vocab, setVocab] = useState<LibraryVocabulary>({ labels: [], hasFavorites: false });
  const [organizing, setOrganizing] = useState(false);
  const [orgLabel, setOrgLabel] = useState("");
  // WHERE THINGS GO. A destination chosen from what exists, or named inline —
  // there is no screen for making an empty section first, because a section
  // that holds nothing is not something anyone set out to create.
  const [structure, setStructure] = useState<{ sections: SectionRow[]; groups: GroupRow[] }>(
    { sections: [], groups: [] });
  const [destSection, setDestSection] = useState("");     // section id, "", or "__new"
  const [newSection, setNewSection] = useState("");
  const [destGroup, setDestGroup] = useState("");         // group id, "", or "__new"
  const [newGroup, setNewGroup] = useState("");

  /** One organizing write for the whole selection. Refreshes the list so the
   *  chips and stars reflect what just happened. */
  async function organize(patch: Record<string, unknown>) {
    if (!chosen.length) return;
    setBusy(true); setNotice("");
    try {
      const res = await fetch("/api/library/bulk", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chosen, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) { setNotice(data.message || "Could not organize those items."); return; }
      if (data.vocabulary) setVocab(data.vocabulary);
      if (data.structure) setStructure(data.structure);
      setRefreshKey((k) => k + 1);
      setNotice(`Organized ${data.updated} item${data.updated === 1 ? "" : "s"}.`);
    } catch {
      setNotice("Could not organize those items.");
    } finally { setBusy(false); }
  }

  /** Put the selection somewhere. One call: the destination and the position
   *  move together. */
  async function place(target: Record<string, unknown>) {
    await organize({ place: target });
    setDestSection(""); setNewSection(""); setDestGroup(""); setNewGroup("");
  }

  async function toggleFavorite(id: string, next: boolean) {
    // Starring the FIRST item has to reveal the Favorites filter straight away.
    // The vocabulary otherwise only arrives with a first page, so the affordance
    // would appear on some later reload — long after the moment it was earned.
    // Unstarring is not mirrored: whether that was the last one is a question
    // about the whole Library, and the next load answers it honestly.
    if (next) setVocab((v) => (v.hasFavorites ? v : { ...v, hasFavorites: true }));
    await fetch(`/api/library/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: { isFavorite: next } }),
    }).catch(() => {});
  }

  /** "Communities › Santa Rosa" for one entry, or undefined when it is not in
   *  a section. Used only where the hierarchy is NOT on screen. */
  const locationOf = useCallback((item: LibrarySnapshot): string | undefined => {
    const sec = structure.sections.find((x) => x.id === item.sectionId);
    if (!sec) return undefined;
    const grp = structure.groups.find((x) => x.id === item.groupId);
    return grp ? `${sec.name} › ${grp.name}` : sec.name;
  }, [structure]);

  // STRUCTURE SHOWS WHEN IT EXISTS AND NOTHING IS FILTERING. A Library with no
  // sections stays the calm flat list it has always been; a search, a label or
  // Favorites suspends the hierarchy, because those results come from all over
  // and drawing untouched containers as empty would say they were.
  const structured = showStructure(structure.sections.length > 0, {
    q, labels: filters.labels, favorite: filters.favorite,
  });

  const [selecting, setSelecting] = useState(false);

  const [chosen, setChosen] = useState<string[]>([]);
  /** WHAT EACH PENDING ENTRY IS CALLED, remembered when it was added.
   *
   *  `chosen` holds ids, and the tray has to keep showing an item after the
   *  professional has searched away from it — otherwise composing means never
   *  changing the filter. Captured on add rather than looked up on render,
   *  because the row it came from may no longer be loaded. */
  const [addedTitles, setAddedTitles] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState<{ id: string; title: string } | null>(null);

  // =========================================================================
  // COMPOSING A FLOWGUIDE — find, drag, place, arrange, create.
  //
  // COPY, NOT MOVE, and the whole design turns on that. Dragging inside the
  // Library rearranges the Library; dragging out of it does nothing to the
  // Library at all. So this has its own planner, its own drag ids and its own
  // context — nothing is shared with library-drag, because the day they share a
  // rule is the day a copy becomes a move.
  //
  // The Library's own grips are already absent here: they are gated on
  // `reorder && !selectable`, and composing is a selection mode. What appears
  // on a row instead is a grip that says "add", beside a button that does the
  // same thing without a pointer.
  // =========================================================================
  const composing = selecting && !organizing;
  const composeSensors = useSensors(
    // Desktop pointer and keyboard. `distance` is what lets one control be both
    // a button and a drag handle: a press that never moves stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const remember = (id: string, title: string) =>
    setAddedTitles((m) => (m[id] ? m : { ...m, [id]: title || "Untitled" }));

  /** Add at the end — the button path, and what a drop on the tray itself does. */
  function addToTray(item: LibrarySnapshot) {
    remember(item.id, item.title ?? "");
    setChosen((c) => (c.includes(item.id) ? c : [...c, item.id]));
  }
  const removeFromTray = (id: string) => setChosen((c) => c.filter((x) => x !== id));
  function nudge(id: string, dir: -1 | 1) {
    setChosen((c) => {
      const i = c.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const next = [...c];
      next.splice(j, 0, next.splice(i, 1)[0]);
      return next;
    });
  }
  const trayEntries: TrayEntry[] = chosen.map((id) => ({ id, title: addedTitles[id] ?? "Untitled" }));

  function onComposeDragEnd(e: DragEndEvent) {
    setDragging(null);
    const plan = planCompose(e.active.id, e.over?.id ?? null, chosen);
    if (!plan) return;
    if (plan.kind === "add") {
      const t = (e.active.data.current as { title?: string } | undefined)?.title;
      remember(plan.id, t ?? "Untitled");
    }
    setChosen((c) => applyCompose(c, plan));
  }
  function onComposeDragStart(e: DragStartEvent) {
    const p = parseComposeId(e.active.id);
    if (!p) return;
    const carried = (e.active.data.current as { title?: string } | undefined)?.title;
    setDragging({ id: p.id, title: carried ?? addedTitles[p.id] ?? "Item" });
  }

  const router = useRouter();

  const save = useCallback(async (
    payload: ItemContentPayload, _updated?: unknown, organization?: LibraryOrganization,
  ): Promise<MutationResult> => {
    void _updated;
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

      // TWO WRITES, DELIBERATELY. The content save above bumps `revision`,
      // which is the save-back comparator; organization must not, so it goes
      // through its own path rather than riding along in the payload. It runs
      // after the content save so a rejected revision leaves both untouched.
      if (organization && editing) {
        await fetch(`/api/library/${editing.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization }),
        }).catch(() => {});
      }

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

  /** Read an entry, and fetch how many FlowGuides hold a copy — context for
   *  deleting, fetched here rather than shipped with every row. */
  function openEntry(s: LibrarySnapshot) {
    setNotice("");
    setViewing(s);
    setUsedIn(null);
    fetch(`/api/library/${s.id}`)
      .then((r) => r.json())
      .then((d) => setUsedIn(typeof d.usedIn === "number" ? d.usedIn : null))
      .catch(() => setUsedIn(null));
  }

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
              <>
                <button
                  onClick={() => { setNotice(""); setChosen([]); setAddedTitles({}); setOrganizing(false); setSelecting(true); }}
                  className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                             text-foreground hover:border-accent hover:text-accent"
                >
                  Create a FlowGuide
                </button>
                {/* THE OTHER DOOR, AND IT SAYS WHAT IT OPENS.
                    This was called "Organize", which stopped being true the
                    moment the Library itself became draggable: the fastest way
                    to organize is now to drag something, and this button leads
                    to a mode where the handles are deliberately gone. So it
                    read as "to organize your Library, do not press Organize".
                    "Select items" fixed the false half and left an open one —
                    select them for WHAT — so the name now carries both the
                    action and its purpose. The mode is unchanged throughout;
                    only what it was called was wrong. */}
                <button
                  onClick={() => { setNotice(""); setChosen([]); setOrganizing(true); setSelecting(true); }}
                  className="px-3 py-2 rounded-lg border border-border bg-white text-sm font-medium
                             text-foreground hover:border-accent hover:text-accent"
                >
                  Select &amp; Organize
                </button>
              </>
            )}
          </div>
        )}

        {/* SELECTION IS NEUTRAL. Choosing items commits to nothing; what to do
            with them is the next decision, not the first. A separate
            "organizing mode" beside the existing "creating mode" would make the
            professional pick the right door before knowing which room they
            wanted, and get it wrong half the time. */}
        {/* Said where the action was taken, not at the bottom of the page. */}
        {notice && <p className="mb-3 text-sm text-green-700">{notice}</p>}

        {/* TWO ENTRY POINTS, TWO EXPERIENCES.
            Selection state is shared underneath — one mode, internally — but a
            professional should never have to understand that. Arriving through
            Select & Organize and being shown a dimmed "Create FlowGuide" and a
            disabled "Select & Organize" beside it is the machinery leaking into
            the room: it says
            nothing about what to do next and quite a lot about how the code is
            arranged. Each intent now shows only its own action. */}
        {selecting && organizing && (
          <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <p className="text-sm font-medium text-foreground">Select &amp; Organize</p>
            <p className="mt-1 text-sm text-muted">
              Choose one or more Library items to move, label, or favorite together. These
              changes only affect your Library — nothing is copied into a FlowGuide or seen
              by a client.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <span className={`text-sm font-medium ${chosen.length ? "text-foreground" : "text-muted"}`}>
                {chosen.length} item{chosen.length === 1 ? "" : "s"} selected
              </span>
              {/* DONE, NOT CANCEL. Every action in this panel writes
                  immediately — placing, labelling and starring are already
                  saved by the time this button is reachable — so "Cancel" would
                  offer to undo something that cannot be undone from here, and
                  would make a professional hesitate before leaving a job they
                  had already finished.
                  This closes the panel and drops the temporary selection. It
                  touches nothing that was saved, and there is no staged state
                  for it to discard: the alternative — holding edits until a
                  Save — is machinery this panel deliberately does not have. */}
              <button
                onClick={() => { setSelecting(false); setOrganizing(false); setChosen([]); setNotice(""); }}
                disabled={busy}
                className="ml-auto rounded-lg border border-border bg-white px-3 py-1.5 text-sm
                           font-medium text-foreground hover:border-accent hover:text-accent
                           disabled:opacity-50"
              >
                Done
              </button>
            </div>

            {/* NOTHING USABLE-LOOKING UNTIL THERE IS SOMETHING TO ACT ON.
                The inputs were editable at zero selection while the buttons were
                disabled, so the professional typed a name, pressed the button,
                and watched nothing happen. A control that accepts input it cannot
                use is worse than one that is absent. */}
            {chosen.length === 0 ? (
              <p className="mt-3 border-t border-accent/30 pt-3 text-xs text-muted">
                Tick anything below to begin — or tap a row.
              </p>
            ) : (
              <div className="mt-3 space-y-3 border-t border-accent/30 pt-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Where should these live?</p>
                  <p className="text-xs text-muted">
                    One place per item — for example Places, Services, People or Documents.
                    You can add a group inside it, like a town or a specialty.
                  </p>
                  <div className="mt-1.5 space-y-2">
                    <select
                      value={destSection}
                      disabled={busy}
                      onChange={(e) => { setDestSection(e.target.value); setDestGroup(""); setNewGroup(""); }}
                      className="w-full rounded border border-border px-2.5 py-1.5 text-sm
                                 focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="">Choose a place…</option>
                      {structure.sections.map((sec) => (
                        <option key={sec.id} value={sec.id}>{sec.name}</option>
                      ))}
                      <option value="__new">+ New…</option>
                    </select>

                    {destSection === "__new" && (
                      <input
                        value={newSection}
                        disabled={busy}
                        onChange={(e) => setNewSection(e.target.value)}
                        placeholder="Name it — Places, Services, People…"
                        className="w-full rounded border border-border px-2.5 py-1.5 text-sm
                                   focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                      />
                    )}

                    {/* A GROUP ONLY ONCE THERE IS SOMETHING TO PUT IT IN, and
                        only ever the chosen section's own groups. Two groups
                        called Santa Rosa under different sections are different
                        groups, so offering the wrong section's would be an
                        invitation to file something somewhere it cannot go. */}
                    {destSection && destSection !== "__new" && (
                      <select
                        value={destGroup}
                        disabled={busy}
                        onChange={(e) => setDestGroup(e.target.value)}
                        className="w-full rounded border border-border px-2.5 py-1.5 text-sm
                                   focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="">No group — straight in</option>
                        {structure.groups.filter((g) => g.sectionId === destSection).map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                        <option value="__new">+ New group…</option>
                      </select>
                    )}
                    {destSection === "__new" && newSection.trim() && (
                      <p className="text-[11px] text-muted">You can add groups inside it once it exists.</p>
                    )}
                    {destGroup === "__new" && (
                      <input
                        value={newGroup}
                        disabled={busy}
                        onChange={(e) => setNewGroup(e.target.value)}
                        placeholder="Group name — a town, a specialty…"
                        className="w-full rounded border border-border px-2.5 py-1.5 text-sm
                                   focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                      />
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <SmallAction
                        disabled={busy || !destSection || (destSection === "__new" && !newSection.trim())
                          || (destGroup === "__new" && !newGroup.trim())}
                        onClick={() => place(
                          destSection === "__new"
                            ? { newSectionName: newSection }
                            : { sectionId: destSection,
                                ...(destGroup === "__new" ? { newGroupName: newGroup }
                                   : destGroup ? { groupId: destGroup } : {}) })}
                      >Put them here</SmallAction>
                      <SmallAction disabled={busy} onClick={() => place({ unorganize: true })}>
                        Take out of its section
                      </SmallAction>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-medium text-foreground">Labels</p>
                  <p className="text-xs text-muted">
                    Other ways you would want to find it later, wherever it lives.
                    As many as you like — a specialty, a status such as Preferred.
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <input
                      list="library-labels"
                      value={orgLabel}
                      disabled={busy}
                      onChange={(e) => setOrgLabel(e.target.value)}
                      placeholder="Preferred"
                      className="min-w-0 flex-1 px-2.5 py-1.5 rounded border border-border text-sm
                                 focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-gray-300"
                    />
                    <SmallAction disabled={busy || !orgLabel.trim()}
                      onClick={() => organize({ addLabels: [orgLabel] })}>Add</SmallAction>
                    <SmallAction disabled={busy || !orgLabel.trim()}
                      onClick={() => organize({ removeLabels: [orgLabel] })}>Remove</SmallAction>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <SmallAction disabled={busy} onClick={() => organize({ favorite: true })}>★ Favorite</SmallAction>
                  <SmallAction disabled={busy} onClick={() => organize({ favorite: false })}>☆ Unfavorite</SmallAction>
                </div>
              </div>
            )}
          </div>
        )}

        {selecting && !organizing && (
          <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <p className="text-sm font-medium text-foreground">Start a FlowGuide</p>
            <p className="mt-1 text-sm text-muted">
              Drag items across, or press Add. The order on the right is the order your
              client will read them in.
            </p>
            {/* CANCEL IS CORRECT HERE, and stays. Nothing is written until
                Create FlowGuide: the selection is a staged choice, so there is
                something real to abandon. The Select & Organize panel says Done for the
                opposite reason — its writes have already happened. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`text-sm font-medium ${chosen.length ? "text-foreground" : "text-muted"}`}>
                {chosen.length} item{chosen.length === 1 ? "" : "s"} selected
              </span>
              <button
                onClick={async () => {
                  setBusy(true); setNotice("");
                  const { packetId, message } = await createFromLibrary(chosen);
                  if (!packetId) { setNotice(message ?? "Could not create it."); setBusy(false); return; }
                  router.push(`/edit/${packetId}`);
                }}
                disabled={busy || chosen.length === 0}
                className="ml-2 px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Creating…" : "Create FlowGuide"}
              </button>
              <button
                onClick={() => { setSelecting(false); setChosen([]); setAddedTitles({}); }}
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
              onSave={(payload, updated, organization) => save(payload, updated, organization)}
              organization={{
                labels: editing.labels ?? [],
                isFavorite: editing.isFavorite ?? false,
              }}
              locationLabel={locationOf(editing)}
              vocabulary={vocab}
              onClose={() => setEditing(null)}
            />
          </div>
        ) : (
          <>
          {/* TWO PANES WHILE COMPOSING: the Library on the left, the FlowGuide
              being assembled on the right. The left pane is the ordinary
              Library — same search, same filters, same rows — because finding
              something to reuse is the same problem as finding it at all. What
              differs is one control per row.

              THE TRAY IS NOT A LIBRARY CONTAINER, and is drawn so it cannot be
              mistaken for one: dashed frame, numbered rows, its own title.

              ONE DndContext, and it exists only while composing. The Library's
              own drag context is not rendered here at all — its handles are
              gated on `reorder && !selectable`, and composing is a selection
              mode — so there is never a moment when a drag could mean either
              "move this in my Library" or "copy this into a FlowGuide". */}
          <DndContext
            sensors={composeSensors}
            onDragStart={onComposeDragStart}
            onDragEnd={onComposeDragEnd}
            onDragCancel={() => setDragging(null)}
            accessibility={{
              announcements: {
                onDragStart: ({ active }) =>
                  `Picked up ${(active.data.current as { title?: string } | undefined)?.title || "item"}.`,
                onDragOver: () => "",
                onDragEnd: ({ active, over }) => {
                  const t = (active.data.current as { title?: string } | undefined)?.title || "item";
                  return over ? `${t} placed in this FlowGuide.` : `${t} was not added.`;
                },
                onDragCancel: () => "Cancelled.",
              },
            }}
          >
            <div className={composing ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" : ""}>
              <div className="min-w-0">
          <LibrarySearch value={q} onChange={setQ} className="mb-3" />
          <LibraryFilters vocabulary={vocab} value={filters} onChange={setFilters} className="mb-3" />
          {/* Suggestions for the label input, from the professional's own
              words. Where something lives is chosen from real sections, not
              typed, so there is nothing to suggest for it. */}
          <datalist id="library-labels">
            {vocab.labels.map((l) => <option key={l} value={l} />)}
          </datalist>

          {structured ? (
            <LibraryStructureView
              refreshKey={refreshKey}
              selectable={selecting}
              selected={chosen}
              onToggle={(id) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
              onOpen={selecting ? undefined : openEntry}
              onToggleFavorite={selecting ? undefined : toggleFavorite}
              onMove={(id) => {
                // The same mechanism, reached from a row: hand this one item to
                // the Select & Organize panel rather than growing a second way to pick a
                // destination.
                setNotice(""); setChosen([id]); setOrganizing(true); setSelecting(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              rowSlot={composing ? (it) => ({
                handle: <AddToFlowGuide item={it} added={chosen.includes(it.id)}
                            onAdd={() => addToTray(it)} />,
                muted: chosen.includes(it.id),
              }) : undefined}
              // NOT WHILE COMPOSING. `reorder` carries the Library's own
              // rearranging — section and group Move up/down, and rename — and
              // this surface does not rearrange the Library. Item handles were
              // already gone (they gate on `!selectable`); the HEADING controls
              // were not, so a professional assembling a FlowGuide could still
              // reorder the shelf underneath it from the same screen.
              reorder={!composing && canReorder({ labels: filters.labels, favorite: filters.favorite })}
              onVocabulary={setVocab}
              onEmpty={(empty) => { if (empty) setStructure({ sections: [], groups: [] }); }}
            />
          ) : (
          <LibraryList
            refreshKey={refreshKey}
              labels={filters.labels}
            favorite={filters.favorite}
            onVocabulary={setVocab}
            onStructure={setStructure}
            onToggleFavorite={selecting ? undefined : toggleFavorite}
            query={q}
            onLoaded={({ count, filtered }) => { if (!filtered) setHasAny(count > 0); }}
            // The location belongs on the row exactly here — in a flat,
            // filtered result, where no heading above it says where the item
            // lives. Under the hierarchy it would be noise.
            rowSlot={composing ? (it) => ({
              handle: <AddToFlowGuide item={it} added={chosen.includes(it.id)}
                        onAdd={() => addToTray(it)} />,
              muted: chosen.includes(it.id),
            }) : undefined}
            locationOf={locationOf}
            selectable={selecting}
            selected={chosen}
            onToggle={(id) => setChosen((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id])}
            onOpen={selecting ? undefined : openEntry}
            emptyHint={
              // SAY IT ONCE. A professional opening an empty Library needs to
              // know what goes in it and how to start, not a short manual.
              <div className="rounded-xl border border-border bg-white p-4">
                <p className="text-base font-semibold text-foreground">Nothing saved yet</p>
                <p className="mt-1 text-sm text-muted">
                  Import information you already have, add something manually, or save
                  things while building a FlowGuide.
                </p>
              </div>
            }
          />
          )}
              </div>
              {composing && (
                <aside className="lg:sticky lg:top-4 lg:self-start">
                  <FlowGuideTray
                    entries={trayEntries} busy={busy}
                    onUp={(id) => nudge(id, -1)}
                    onDown={(id) => nudge(id, 1)}
                    onRemove={removeFromTray}
                  />
                </aside>
              )}
            </div>
            <DragOverlay dropAnimation={null}>
              {dragging ? (
                <div className="pointer-events-none rounded-md border border-accent bg-white px-2.5 py-1.5
                                text-sm font-medium text-foreground shadow-lg">
                  {dragging.title}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
          </>
        )}
      </div>
    </div>
  );
}

/** A compact control for one bulk action. */
function SmallAction({
  disabled, onClick, children,
}: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-medium
                 text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}
