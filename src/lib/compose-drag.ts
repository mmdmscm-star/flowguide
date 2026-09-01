// WHAT A DROP MEANS WHILE COMPOSING A FLOWGUIDE.
//
// Deliberately its own module, and deliberately NOT library-drag.ts, because
// the two gestures mean opposite things and share no rules:
//
//   library-drag  MOVES the master. The item leaves one container and arrives
//                 in another; the Library is changed.
//   compose-drag  COPIES a snapshot. Nothing about the Library changes — the
//                 master stays exactly where it is, keeps its section, its
//                 group, its labels and its favourite — and what the drop
//                 produces is a pending entry in a FlowGuide that does not
//                 exist yet.
//
// Sharing a planner between them is how a copy would one day quietly become a
// move. They are kept apart on purpose.
//
// THE TRAY IS ORDER, NOT STORAGE. It is a list of Library ids in the order the
// professional put them, held in the browser until Create writes the FlowGuide.
// The server already honours that order — create_packet_from_library unnests
// the array `with ordinality` and assigns sort_order from it — so the tray IS
// the eventual order, and nothing new has to be persisted to say so.

export const LIB = "lib:";
export const TRAY = "tray:";
/** The tray as a whole. Dropping on it, rather than on one of its rows, means
 *  the end — the same "no neighbour means append" rule the Library uses. */
export const TRAY_END = "tray-end";

export const libDragId = (id: string) => `${LIB}${id}`;
export const trayDragId = (id: string) => `${TRAY}${id}`;

export function parseComposeId(raw: unknown): { zone: "lib" | "tray" | "end"; id: string } | null {
  const s = String(raw ?? "");
  if (s === TRAY_END) return { zone: "end", id: "" };
  if (s.startsWith(LIB)) return s.length > LIB.length ? { zone: "lib", id: s.slice(LIB.length) } : null;
  if (s.startsWith(TRAY)) return s.length > TRAY.length ? { zone: "tray", id: s.slice(TRAY.length) } : null;
  return null;
}

export type ComposePlan =
  /** Copy a Library item into the pending FlowGuide at this position. */
  | { kind: "add"; id: string; index: number }
  /** Move a pending entry within the tray. */
  | { kind: "reorder"; id: string; index: number }
  | null;

/**
 * Resolve a compose drop against the pending tray.
 *
 * `tray` is the ordered list of Library ids already added. It is the whole
 * truth here — unlike the Library, nothing is paged, so an index is safe to
 * compute and there is no container to read from storage.
 */
export function planCompose(activeRaw: unknown, overRaw: unknown, tray: string[]): ComposePlan {
  const a = parseComposeId(activeRaw);
  const o = overRaw == null ? null : parseComposeId(overRaw);
  if (!a || !o) return null;

  if (a.zone === "lib") {
    // ONE COPY PER ITEM, which is what the product already did when the tray
    // was a checkbox list: `chosen` was a set, so choosing something twice
    // chose it once. Dragging an item that is already pending is not an error
    // and not a second copy — it is nothing.
    if (tray.includes(a.id)) return null;
    if (o.zone === "end") return { kind: "add", id: a.id, index: tray.length };
    if (o.zone === "tray") {
      const at = tray.indexOf(o.id);
      // Dropped ON a pending entry: take its place and push it down. That is
      // what the insertion line above it showed.
      return { kind: "add", id: a.id, index: at < 0 ? tray.length : at };
    }
    return null;                       // dropped back on the Library: nothing
  }

  if (a.zone === "tray") {
    const from = tray.indexOf(a.id);
    if (from < 0) return null;
    if (o.zone === "end") return { kind: "reorder", id: a.id, index: tray.length - 1 };
    if (o.zone === "tray") {
      const to = tray.indexOf(o.id);
      if (to < 0 || to === from) return null;
      return { kind: "reorder", id: a.id, index: to };
    }
    // A pending entry dragged back over the Library. Removing it by dropping it
    // "away" is a gesture people perform by accident, so it does nothing; the
    // row's own Remove button is how it leaves.
    return null;
  }
  return null;
}

/** Apply a plan to the tray. Pure, so the reducer can be read on its own. */
export function applyCompose(tray: string[], plan: ComposePlan): string[] {
  if (!plan) return tray;
  if (plan.kind === "add") {
    if (tray.includes(plan.id)) return tray;
    const next = [...tray];
    next.splice(Math.max(0, Math.min(plan.index, next.length)), 0, plan.id);
    return next;
  }
  const from = tray.indexOf(plan.id);
  if (from < 0) return tray;
  const next = [...tray];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(plan.index, next.length)), 0, plan.id);
  return next;
}
