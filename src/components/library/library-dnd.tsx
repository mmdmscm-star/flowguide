"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";
export { dragId, parseDragId, type DragKind } from "@/lib/library-drag";

// DIRECT MANIPULATION FOR THE LIBRARY'S STRUCTURE.
//
// The pieces here exist so the structure view can stay readable: a handle, a
// sortable row, a sortable heading, and the collision rule that lets a drop land
// ON a heading rather than near it.
//
// ONE ID SPACE, disambiguated by what is being dragged. A section's heading is
// the sortable node for reordering sections AND the drop target for an item
// being filed into it — the same element means both things, and which one is
// meant is decided by the KIND of the thing in the hand, not by a second
// invisible target stacked on top. That is also why a collapsed section can
// receive a drop: its heading is rendered even when its contents are not.
/** POINTER FIRST, so a drop ON a heading is a drop on that heading.
 *
 *  `closestCenter` alone measures from the dragged item's centre, which near a
 *  boundary happily chooses the last row of the section above instead of the
 *  heading the pointer is actually over. Asking what is under the POINTER
 *  matches what the professional is aiming at; the rectangle test is the
 *  fallback for a keyboard drag, where there is no pointer at all. */
export const libraryCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

/** The grip. Always visible, never hover-only, and never inside the row's own
 *  button — a button within a button is invalid markup, and the row's button is
 *  what opens the item. `touch-none` stops the browser claiming the gesture as a
 *  scroll once a drag has started on the handle itself. */
export function DragHandle({
  label, attributes, listeners, disabled,
}: {
  label: string;
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      {...attributes}
      {...listeners}
      className="flex-none touch-none cursor-grab active:cursor-grabbing rounded p-1 text-gray-300
                 hover:text-gray-600 focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-accent disabled:cursor-default disabled:opacity-30"
    >
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <circle cx="7" cy="4" r="1.5" /><circle cx="13" cy="4" r="1.5" />
        <circle cx="7" cy="10" r="1.5" /><circle cx="13" cy="10" r="1.5" />
        <circle cx="7" cy="16" r="1.5" /><circle cx="13" cy="16" r="1.5" />
      </svg>
    </button>
  );
}

/** Where the thing in the hand would land, drawn as a line between two rows.
 *
 *  The shifting of the other rows tells you something is happening; it does not
 *  tell you WHERE the drop will go, and between two tight rows those are easy to
 *  read wrongly. The line is the answer to "if I let go now". */
const EDGE = {
  before: "before:absolute before:-top-1 before:left-0 before:right-0 before:h-0.5 before:rounded before:bg-accent",
  after: "after:absolute after:-bottom-1 after:left-0 after:right-0 after:h-0.5 after:rounded after:bg-accent",
} as const;

export function SortableRow({
  id, disabled, edge, children,
}: {
  id: string;
  disabled?: boolean;
  /** Which side of this row the drop indicator belongs on, if any. */
  edge?: "before" | "after" | null;
  /** Renders the row itself — this wrapper deliberately renders no element of
   *  its own, because the row already owns its <li> and an <li> inside an <li>
   *  is not a list. */
  children: (bits: {
    innerRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    className: string;
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown>;
    dragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });
  return (
    <>
      {children({
        innerRef: setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        className: `relative ${isDragging ? "opacity-40" : ""} ${edge ? EDGE[edge] : ""}`,
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: (listeners ?? {}) as Record<string, unknown>,
        dragging: isDragging,
      })}
    </>
  );
}

/** A section or group heading: draggable to reorder, and a drop target for an
 *  item being filed into it. */
export function SortableHeading({
  id, disabled, highlight, children,
}: {
  id: string;
  disabled?: boolean;
  /** True while an ITEM is hovering it — this heading would receive the drop. */
  highlight?: boolean;
  children: (handle: {
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown>;
    dragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-md ${isDragging ? "opacity-40" : ""} ${
        highlight ? "ring-2 ring-accent ring-offset-1" : ""}`}
    >
      {children({
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: (listeners ?? {}) as Record<string, unknown>,
        dragging: isDragging,
      })}
    </div>
  );
}
