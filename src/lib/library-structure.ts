// SECTION -> optional GROUP -> ITEM. The semantics, kept pure.
//
// Everything here is a function of values, so the rules can be asserted without
// a database: what a move actually writes, where a placement lands, which
// containers have become empty, and what the compatibility shadow should say.
//
// ONE STRUCTURAL HOME. An item points at a section, optionally at a group
// inside that section, and nowhere else. There is no multi-placement, no alias
// and no duplicate copy used as an organizing trick — 0039 makes those
// unrepresentable, and nothing here tries to reintroduce them. Alternate
// dimensions are labels, which cut across freely.

/** Where an item lives. `sectionId: null` is the unorganized remainder, which
 *  is a valid permanent home and not a staging area. */
export interface Placement {
  sectionId: string | null;
  groupId: string | null;
}

export interface SectionRow { id: string; name: string; sortOrder: number }
export interface GroupRow { id: string; sectionId: string; name: string; sortOrder: number }

export interface StructureTree {
  sections: Array<SectionRow & { groups: GroupRow[] }>;
}

/** Sections in their order, each with its groups in theirs. */
export function buildTree(sections: SectionRow[], groups: GroupRow[]): StructureTree {
  const byOrder = <T extends { sortOrder: number; id: string }>(a: T, b: T) =>
    a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  return {
    sections: [...sections].sort(byOrder).map((s) => ({
      ...s,
      groups: groups.filter((g) => g.sectionId === s.id).sort(byOrder),
    })),
  };
}

/** Two placements are the same container when BOTH halves match. A loose item
 *  in a section and an item in one of its groups are different containers, so
 *  "move down" in one never walks into the other. */
export function sameContainer(a: Placement, b: Placement): boolean {
  return a.sectionId === b.sectionId && a.groupId === b.groupId;
}

// ---------------------------------------------------------------------------
// MOVING
//
// The interaction is Move up / Move down / Move to…, and no drag. Up and down
// are a swap with the adjacent row IN THE WHOLE CONTAINER — which is why this
// takes the container's full ordered list and not whatever the client happens
// to have scrolled into view. A page-local move would silently rewrite the tail
// of a long section the moment someone pressed it on the last visible row.
// ---------------------------------------------------------------------------

/**
 * What a single-step move should WRITE, or null when it should write nothing.
 *
 * `ordered` is the entire container, in stored order. Returning the two rows to
 * exchange — rather than a whole renumbered list — keeps a move to two updates
 * and makes "nothing happened" (already first, already last, unknown id) an
 * explicit null instead of a no-op write that still looks like a change.
 */
export function swapForMove(
  ordered: Array<{ id: string; sortOrder: number }>,
  id: string,
  direction: "up" | "down",
): Array<{ id: string; sortOrder: number }> | null {
  const i = ordered.findIndex((r) => r.id === id);
  if (i === -1) return null;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ordered.length) return null;          // already at the edge
  const a = ordered[i], b = ordered[j];
  if (a.sortOrder === b.sortOrder) {
    // A tie cannot be resolved by exchanging equal values. Give the mover the
    // neighbour's rank and push the neighbour one step the other way; the dense
    // pass on the next placement tidies the sequence.
    return [
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: direction === "up" ? b.sortOrder + 1 : b.sortOrder - 1 },
    ];
  }
  return [{ id: a.id, sortOrder: b.sortOrder }, { id: b.id, sortOrder: a.sortOrder }];
}

/** Positions for items appended to the end of a container, in the order given. */
export function appendOrders(currentMax: number | null, count: number): number[] {
  const base = (currentMax ?? -1) + 1;
  return Array.from({ length: count }, (_, i) => base + i);
}

// ---------------------------------------------------------------------------
// THE COMPATIBILITY SHADOW
//
// `category` stays written for as long as rolling back to the pre-structure
// runtime is something we might do. It carries the SECTION NAME, or '' when the
// item is unorganized.
//
// It deliberately cannot express a group or a manual position. Encoding either
// would mean inventing a parseable format inside a user-visible text column,
// and then owning that format forever. A rollback shows sections and loses the
// nesting from VIEW — the data itself stays in group_id and sort_order.
// ---------------------------------------------------------------------------
export function shadowCategory(sectionName: string | null | undefined): string {
  return (sectionName ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// PRUNING
//
// Structure exists because material is in it. When the last item leaves, the
// container goes — otherwise a Library slowly fills with empty headings nobody
// asked for, and the only cure is the taxonomy-management screen we are not
// building.
//
// Groups first, then sections, because emptying a group can be what empties the
// section above it.
// ---------------------------------------------------------------------------
export function emptyGroupIds(
  groups: Array<{ id: string }>,
  items: Array<{ groupId: string | null }>,
): string[] {
  const used = new Set(items.map((i) => i.groupId).filter(Boolean) as string[]);
  return groups.filter((g) => !used.has(g.id)).map((g) => g.id);
}

export function emptySectionIds(
  sections: Array<{ id: string }>,
  groups: Array<{ sectionId: string }>,
  items: Array<{ sectionId: string | null }>,
): string[] {
  const withItems = new Set(items.map((i) => i.sectionId).filter(Boolean) as string[]);
  const withGroups = new Set(groups.map((g) => g.sectionId));
  return sections.filter((s) => !withItems.has(s.id) && !withGroups.has(s.id)).map((s) => s.id);
}

/** Case-insensitive reuse, so naming a section "communities" when
 *  "Communities" exists joins the one that is there instead of making a second.
 *  The same rule labels and categories already follow. */
export function findByName<T extends { name: string }>(rows: T[], wanted: string): T | undefined {
  const w = wanted.replace(/\s+/g, " ").trim().toLowerCase();
  if (!w) return undefined;
  return rows.find((r) => r.name.replace(/\s+/g, " ").trim().toLowerCase() === w);
}

export function cleanName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// WHEN THE STRUCTURED VIEW IS THE RIGHT ONE
//
// A Library with no sections is not "structure with zero rows"; it is the calm
// flat list it has always been, and it must stay exactly that. Structure
// appears when the professional has made some, and never before.
//
// A filter also suspends it: under a search term, a label or Favorites, the
// result is a set of matches from all over the Library, and drawing it as a
// hierarchy would imply the untouched containers were empty rather than
// filtered out.
// ---------------------------------------------------------------------------
export function showStructure(
  hasSections: boolean,
  filtering: { q?: string; labels?: string[]; favorite?: boolean; category?: string },
): boolean {
  if (!hasSections) return false;
  if (String(filtering.q ?? "").trim()) return false;
  if ((filtering.labels ?? []).length) return false;
  if (filtering.favorite) return false;
  return true;
}

/** Reordering is offered only where the stored sequence is what is on screen.
 *  In a filtered list the neighbouring row is not the neighbour in storage, so
 *  "move down" would mean something the professional cannot see. */
export const canReorder = (filtering: Parameters<typeof showStructure>[1]): boolean =>
  !String(filtering.q ?? "").trim() && !(filtering.labels ?? []).length && !filtering.favorite;

// ---------------------------------------------------------------------------
// THE CUTOVER RACE, AND THE SMALLEST THING THAT CLOSES IT.
//
// Between 0040 running and the structured runtime being reachable, the previous
// runtime is still serving and can still write `category` — it has never heard
// of section_id. So an item can end up with section_id pointing at the section
// 0040 gave it and a category naming a DIFFERENT one. That is the professional's
// most recent intent, expressed through the only field the old runtime had.
//
// 0041 reconciles it. But the new runtime is live for a minute or so BEFORE
// 0041 runs, and a placement in that minute would overwrite `category` with its
// section's name — destroying the intent, and destroying the evidence, since
// afterwards the two agree and 0041 finds nothing to reconcile.
//
// The fix is not a synchronisation layer. It is to notice that the pair
// disagree and decline, once, until 0041 has run. After that nothing can
// disagree — the new runtime writes both together — so this never fires again
// and leaves with the shadow in the contract migration.
//
// Compared case-insensitively and whitespace-folded, because that is how a
// section name and a category are matched everywhere else.
// ---------------------------------------------------------------------------
export function unreconciledIds(
  rows: Array<{ id: string; category?: unknown; sectionId: string | null }>,
  sectionNameById: Map<string, string>,
): string[] {
  const fold = (s: string) => shadowCategory(s).toLowerCase();
  return rows.filter((r) => {
    const home = r.sectionId ? (sectionNameById.get(r.sectionId) ?? "") : "";
    return fold(home) !== fold(String(r.category ?? ""));
  }).map((r) => r.id);
}
