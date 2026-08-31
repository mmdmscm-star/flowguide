// WHAT A DROP MEANS.
//
// Kept out of the component on purpose. Deciding where a dropped thing lands is
// the part with edges — a neighbour in another container, a group dropped on a
// foreign section, a row dragged at the unorganized remainder — and none of that
// should only be reachable by simulating a pointer gesture in a test.
//
// NOTHING HERE COMPUTES AN ORDER. It produces the INTENT the server is given:
// one thing, and at most one neighbour. The server reads the whole container to
// work out what that means, which is why a drop is correct however far the
// professional had scrolled, and why a future hidden Section stays countable as
// a sibling even when it is not on screen.

export type DragKind = "item" | "section" | "group";

export const dragId = (kind: DragKind, id: string) => `${kind}:${id}`;

export function parseDragId(raw: unknown): { kind: DragKind; id: string } | null {
  const s = String(raw ?? "");
  const at = s.indexOf(":");
  if (at < 0) return null;
  const kind = s.slice(0, at) as DragKind;
  if (kind !== "item" && kind !== "section" && kind !== "group") return null;
  const id = s.slice(at + 1);
  return id ? { kind, id } : null;
}

export interface Placement { sectionId: string | null; groupId: string | null }

export interface DropContext {
  /** Where each LOADED item currently sits. From the server's containers. */
  placeOf: Map<string, Placement>;
  /** The loaded row ids per container key, used only to tell before from after. */
  rowOrder: Map<string, string[]>;
  sections: { id: string }[];
  groups: { id: string; sectionId: string }[];
}

export const containerKey = (s: string | null, g: string | null) => `${s ?? ""}|${g ?? ""}`;

export type DropPlan =
  | { kind: "move"; payload: Record<string, unknown> }
  | { kind: "refused"; message: string }
  | null;

/** Which side of a neighbour the thing lands on.
 *
 *  Moving DOWN past something means landing after it; moving up, before it.
 *  Across containers there is no "down", so it takes the neighbour's place and
 *  pushes it along — which is what dropping onto a row looks like. */
function sideOf(list: string[], activeId: string, overId: string, sameContainer: boolean):
  { before: string } | { after: string } {
  if (!sameContainer) return { before: overId };
  const a = list.indexOf(activeId), o = list.indexOf(overId);
  return a >= 0 && o >= 0 && a < o ? { after: overId } : { before: overId };
}

export function planDrop(activeRaw: unknown, overRaw: unknown, ctx: DropContext): DropPlan {
  const a = parseDragId(activeRaw);
  const o = overRaw == null ? null : parseDragId(overRaw);
  if (!a || !o || a.id === o.id) return null;

  if (a.kind === "item") {
    // ONTO A SECTION HEADING: loose in that section, at the true end. The old
    // group is cleared by the server — never matched by name in the destination.
    if (o.kind === "section") {
      return { kind: "move", payload: { kind: "item", id: a.id, sectionId: o.id, groupId: null } };
    }
    // ONTO A GROUP HEADING: into that group, at the true end.
    if (o.kind === "group") {
      const g = ctx.groups.find((x) => x.id === o.id);
      if (!g) return null;
      return { kind: "move", payload: { kind: "item", id: a.id, sectionId: g.sectionId, groupId: o.id } };
    }
    // ONTO ANOTHER ROW: precise placement beside that specific neighbour.
    const from = ctx.placeOf.get(a.id);
    const to = ctx.placeOf.get(o.id);
    if (!from || !to) return null;
    if (!to.sectionId) {
      // The unorganized remainder is newest-first and has no sequence to join.
      return { kind: "refused", message: "Items that are not in a section stay newest first." };
    }
    if (!from.sectionId) {
      // Dragging OUT of unorganized is a later phase; the fallback Move… does it.
      return { kind: "refused", message: "Use Move… to file something that is not in a section yet." };
    }
    const same = from.sectionId === to.sectionId && from.groupId === to.groupId;
    const rows = ctx.rowOrder.get(containerKey(to.sectionId, to.groupId)) ?? [];
    return {
      kind: "move",
      payload: {
        kind: "item", id: a.id, sectionId: to.sectionId, groupId: to.groupId,
        ...sideOf(rows, a.id, o.id, same),
      },
    };
  }

  // A section is not dropped on a group, or the other way about.
  if (a.kind !== o.kind) return null;

  if (a.kind === "group") {
    const mine = ctx.groups.find((g) => g.id === a.id)?.sectionId;
    const theirs = ctx.groups.find((g) => g.id === o.id)?.sectionId;
    if (!mine || !theirs) return null;
    if (mine !== theirs) {
      // Moving a group between sections moves everything inside it. That is a
      // decision, not a gesture, and "Move…" is where decisions live.
      return { kind: "refused", message: "A group can only be reordered inside its own section." };
    }
    const siblings = ctx.groups.filter((g) => g.sectionId === mine).map((g) => g.id);
    return { kind: "move", payload: { kind: "group", id: a.id, ...sideOf(siblings, a.id, o.id, true) } };
  }

  const ids = ctx.sections.map((x) => x.id);
  return { kind: "move", payload: { kind: "section", id: a.id, ...sideOf(ids, a.id, o.id, true) } };
}
