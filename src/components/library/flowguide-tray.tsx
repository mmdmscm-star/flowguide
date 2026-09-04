"use client";

import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TRAY_END, parseComposeId, trayDragId } from "@/lib/compose-drag";

// THE FLOWGUIDE BEING ASSEMBLED.
//
// Not another Library container, and it has to not LOOK like one: same rows in
// the same shell on both sides of the screen would say these are two views of
// one thing, when in fact the left is the master and the right is a list of
// copies that do not exist yet. So this side is titled, numbered, and framed as
// a document being built.
//
// ITS JOB IS SELECTION AND ORDER, and stops there. No description, no details,
// no photos, no second content editor — the FlowGuide editor is one Create away
// and is where content is written. What cannot be done after Create is decide
// what goes in and in what order, which is exactly what this does.

export interface TrayEntry { id: string; title: string }

function Row({
  entry, index, count, busy, onUp, onDown, onRemove,
}: {
  entry: TrayEntry; index: number; count: number; busy: boolean;
  onUp: () => void; onDown: () => void; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: trayDragId(entry.id), disabled: busy });
  const name = entry.title || "this item";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1.5
                  ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        aria-label={`Drag to reorder ${name}`}
        disabled={busy}
        {...attributes}
        {...listeners}
        className="flex-none touch-none cursor-grab active:cursor-grabbing rounded p-0.5 text-gray-300
                   hover:text-gray-600 focus-visible:outline focus-visible:outline-2
                   focus-visible:outline-accent disabled:opacity-30"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="7" cy="4" r="1.5" /><circle cx="13" cy="4" r="1.5" />
          <circle cx="7" cy="10" r="1.5" /><circle cx="13" cy="10" r="1.5" />
          <circle cx="7" cy="16" r="1.5" /><circle cx="13" cy="16" r="1.5" />
        </svg>
      </button>
      {/* The number is the point of this pane: it is the order the client will
          read them in. */}
      <span className="w-5 flex-none text-right text-xs tabular-nums text-muted">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
      {/* THE FALLBACK, and on a small screen the only path. Named, because
          "Move up" repeated down a list says nothing about which row it is on. */}
      <button type="button" onClick={onUp} disabled={busy || index === 0}
        aria-label={`Move ${name} up`}
        className="flex-none px-1 text-gray-400 hover:text-accent disabled:opacity-25">↑</button>
      <button type="button" onClick={onDown} disabled={busy || index === count - 1}
        aria-label={`Move ${name} down`}
        className="flex-none px-1 text-gray-400 hover:text-accent disabled:opacity-25">↓</button>
      <button type="button" onClick={onRemove} disabled={busy}
        aria-label={`Remove ${name} from this Sendset`}
        className="flex-none px-1 text-gray-400 hover:text-red-600 disabled:opacity-25">×</button>
    </li>
  );
}

export function FlowGuideTray({
  entries, busy, onUp, onDown, onRemove,
}: {
  entries: TrayEntry[];
  busy: boolean;
  onUp: (id: string) => void;
  onDown: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // The whole pane is the drop target, so an aim that misses every row still
  // lands somewhere sensible — the end.
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_END });
  // A LIBRARY ITEM IN THE HAND, as opposed to a tray row being reordered. Only
  // the first needs to be shown where it may land; the second is already home.
  const { active } = useDndContext();
  const carrying = parseComposeId(active?.id)?.zone === "lib";
  return (
    // A TARGET YOU AIM AT, not one you hit.
    //
    // This box WAS its contents: two lines of heading and however many rows
    // existed, so with an empty or nearly-empty Sendset it was a strip a couple
    // of hundred pixels tall, floated at the top of a tall column. dnd-kit's
    // default collision is rectIntersection — the dragged thing's rectangle has
    // to OVERLAP the target's — so everywhere below that strip, which is most of
    // the right-hand side, a release resolved to nothing and silently did
    // nothing. It read as bad aim rather than a small target.
    //
    // So the box is given a floor to stand on and grows to fill the column it
    // already occupies. Nothing about the drop CHANGED — the pane has always
    // meant "the end" — there is simply now enough of it to hit.
    <div
      ref={setNodeRef}
      className={`flex min-h-[18rem] flex-col rounded-xl border-2 border-dashed p-4
                  transition-colors lg:min-h-[60vh] ${
        isOver ? "border-accent bg-accent/10"
        : carrying ? "border-accent/60 bg-accent/5"
        : "border-border bg-white/60"}`}
    >
      <p className="text-sm font-medium text-foreground">This Sendset</p>
      <p className="mt-0.5 text-[11px] text-muted">
        {entries.length === 0
          ? "Nothing in it yet."
          : `${entries.length} item${entries.length === 1 ? "" : "s"}, in this order.`}
      </p>

      {entries.length === 0 ? (
        // THE EMPTY STATE IS THE INSTRUCTION. An empty bordered box says
        // "something goes here" and nothing about what or how.
        <div className={`mt-3 flex flex-1 flex-col items-center justify-center rounded-lg
                         border border-dashed px-3 py-6 text-center transition-colors ${
          carrying ? "border-accent/60 bg-accent/10" : "border-border"}`}>
          <p className="text-sm text-muted">Drag something over from your Library</p>
          <p className="mt-1 text-[11px] text-muted/80">
            or press <span className="font-medium">Add</span> on any item
          </p>
        </div>
      ) : (
        <SortableContext items={entries.map((e) => trayDragId(e.id))}
          strategy={verticalListSortingStrategy}>
          <ol className="mt-3 space-y-1.5">
            {entries.map((e, i) => (
              <Row key={e.id} entry={e} index={i} count={entries.length} busy={busy}
                onUp={() => onUp(e.id)} onDown={() => onDown(e.id)} onRemove={() => onRemove(e.id)} />
            ))}
          </ol>
        </SortableContext>
      )}

      {/* THE OPEN SPACE BELOW THE ROWS, and the reason it is visible.
          It is not a second target — it is the same droppable as the frame
          around it, so a release here means the end, exactly as a release on
          the frame always did. What it adds is somewhere obvious to aim that is
          not a one-row-tall gap between two existing rows. */}
      {entries.length > 0 && (
        <div
          data-tray-landing
          className={`mt-2 flex min-h-[5rem] flex-1 items-center justify-center rounded-lg
                      border border-dashed transition-colors ${
            carrying ? "border-accent/60 bg-accent/10" : "border-transparent"}`}
        >
          {carrying && (
            <p className="text-xs font-medium text-accent">Drop here to add to the end</p>
          )}
        </div>
      )}

      {/* WHAT THIS IS NOT. Said once, quietly, because the whole gesture looks
          like moving and is not. */}
      <p className="mt-3 text-[11px] text-muted/80">
        Each one is copied in. Your Library keeps its own copy, exactly where it is.
      </p>
    </div>
  );
}
